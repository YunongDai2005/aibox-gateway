/**
 * 一轮对话（turn）= 把主人的一句话交给工人（DSH）并把结果送回微信。
 * v1 的 answerDsh 是 170 行的大函数；这里拆成流水线，每段由核心或插件挂上去（见 core/app.mjs 的 STAGES）。
 *
 * turn 对象（各阶段共享）：
 *   msg chat opts        入参（opts: route / raw / reask / hint，含义同 v1）
 *   text spoken          要交给工人的全文 / 主人亲口说的（打字 + 语音转写，不含媒体标注）
 *   userText             进入 context 阶段前的原话（回忆关键词只看它）
 *   run                  live 里的运行记录（面板、进度播报都读它）
 *   sid meta fresh       当前会话、元数据、是不是新会话首条
 *   routePrefix forceRecall injected   各插件留下的标记
 *   r                    runDsh 的结果
 *   out files            要发回去的文字和文件
 *   stop                 置 true = 后面的阶段都不跑了
 *   cleanups             finally 里要执行的收尾（例如停掉进度播报）
 */
import { cfg } from '../core/config.mjs';
import { log, emit, errText, tag } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';
import * as S from './session.mjs';
import * as live from '../observe/live.mjs';
import { runDsh, noFinal, isQuotaErr, isSessionLost, coolingDown, setGoCooldown, ocSession, refreshQuota } from './dsh.mjs';
import { registerActiveRun, beginGeneration, activeRuns, interruptCurrentRun } from './runs.mjs';
import { enqueue, queueBusy } from './queue.mjs';

// ---------- 核心阶段（作为 core 插件挂上去） ----------
export const corePlugin = {
  name: 'core', core: true, desc: '一轮对话的骨架：收消息、管会话、跑 DSH、发回复',
  setup(app) {
    // input：语音转写并进文字；图片/文件下载到 inbox 并附一行说明
    app.stage('input', 10, async (T) => {
      if (T.opts.raw) return;
      const vt = wx.voiceText(T.msg);
      if (vt) T.text = (T.text ? T.text + '\n' : '') + vt;
      T.spoken = T.text || '';
      const media = await wx.inboundMedia(T.msg).catch((e) => { log('dsh media ERROR ' + errText(e)); return '[用户发来的媒体处理失败]'; });
      if (media) { T.text = (T.text ? T.text + '\n' : '') + media; T.hasMedia = true; }
    });

    // turnStart：面板上登记一个运行
    app.stage('turnStart', 10, (T) => {
      T.run = live.startRun({ chat: T.chat, kind: 'chat', task: T.text, limitMs: cfg.dshTimeoutMs, idleMs: cfg.dshIdleMs });
    });

    // route：撤回重答（「切错了」）直接带前缀，不再判定话题
    app.stage('route', 5, (T) => {
      if (!T.opts.reask) return;
      T.routePrefix = T.opts.reask.prefix || '';
      if (T.opts.reask.note) T.run.note(T.opts.reask.note);
    });

    // session：读会话；没有会话 = 新会话首条；元数据失配 = 冷切（旧会话已不可用，不花 token 总结）
    app.stage('session', 10, (T) => {
      T.sid = S.getSid(T.chat);
      T.meta = S.getMeta(T.chat);
      if (!T.sid) T.fresh = true;
      else if (!T.meta || T.meta.sid !== T.sid) {
        log('dsh meta mismatch, fresh chat=' + T.chat + ' old=' + T.sid);
        S.resetSession(T.chat); T.sid = undefined;
        T.meta = S.getMeta(T.chat);
        T.fresh = true;
      }
    });
    // session@90：计数（放在换会话判定之后，避免 idle 被自己刷新）；记下原话
    app.stage('session', 90, (T) => { S.bumpMsgCount(T.chat); T.userText = T.text; });

    // context@30：话题路由留下的前缀
    app.stage('context', 30, (T) => { if (T.routePrefix) T.text = T.routePrefix + T.text; });

    // run：Go 主力 → 失败换 DeepSeek 重试 → 会话丢了开新会话重试；被中断就什么都不发
    app.stage('run', 50, async (T) => {
      const { chat, run } = T;
      const oc = ocSession(chat, T.sid);
      const cd = coolingDown();
      run.setRoute(cd ? 'deepseek' : 'go');
      const gen = beginGeneration(chat), reg = registerActiveRun(chat);
      const go = (sid, fallback, o) => runDsh(T.text, sid, { fallback, ocSession: o, onEvent: run.event, chat, generation: gen, register: reg });
      const interrupted = (r) => {
        if (!(r.interrupted || r.stale)) return false;
        S.saveSessionIfAny(chat, r); log('dsh interrupted chat=' + chat);
        run.end('interrupted', '被打断（叫停/改方向/切错了）');
        emit('turn.interrupted', { chat: tag(chat), runId: r.runId });
        T.stop = true;
        return true;
      };
      let r = await go(T.sid, cd, oc);
      if (interrupted(r)) return;
      const lost = noFinal(r) && T.sid && isSessionLost(r);
      if (noFinal(r) && !cd && !lost && !r.signal) {
        const quota = isQuotaErr(r.errTail);
        log('go FAILED chat=' + chat + ' quota=' + quota + ' err=' + r.errTail.replace(/\s+/g, ' ').slice(-300));
        emit('route.fallback', { chat: tag(chat), quota });
        if (quota) {
          setGoCooldown(cfg.goCooldownMs);
          await wx.replySoft(T.msg, '⚠️ Go 额度用完，接下来 ' + Math.round(cfg.goCooldownMs / 60000) + ' 分钟改走 DeepSeek 按量付费。');
        }
        run.note('Go 线路失败，改走 DeepSeek 按量重试'); run.setRoute('deepseek');
        r = await go(T.sid, true, oc);
        if (interrupted(r)) return;
      }
      if (noFinal(r) && T.sid && isSessionLost(r)) {
        log('dsh session lost, starting fresh chat=' + chat);
        emit('session.lost', { chat: tag(chat) });
        S.setSid(chat, null);
        run.note('旧会话丢了，开新会话重试');
        r = await go(null, cd, ocSession(chat, null));
        if (interrupted(r)) return;
      }
      T.r = r;
    });

    app.stage('afterRun', 5, () => refreshQuota());
    app.stage('afterRun', 20, (T) => { if (T.r.sessionId) { S.setSid(T.chat, T.r.sessionId); S.setMeta(T.chat, T.r.sessionId); } });

    // deliver：没内容 → 说清楚为什么；有内容 → 发文字 + 文件
    app.stage('deliver', 50, async (T) => {
      const { r, msg, chat, run } = T;
      const took = ((Date.now() - T.t0) / 1000).toFixed(1) + 's';
      if (noFinal(r) || !String(r.final).trim()) {
        const why = r.killedBy === 'idle' ? Math.round(cfg.dshIdleMs / 60000) + ' 分钟没有任何动静，判定卡死'
          : r.killedBy === 'max' ? '跑满 ' + Math.round(cfg.dshTimeoutMs / 60000) + ' 分钟总上限'
          : r.signal ? '被终止（' + r.signal + '）' : ('exit=' + r.code);
        if (r.killedBy) await wx.replySoft(msg, '⛔ DSH 被停下了：' + why + '。\n' + live.describe(run, '做到这里') + '\n\n会话还在，发「继续」它会接着做；/new 重新开始。');
        else await wx.replySoft(msg, '⚠️ DSH 没返回内容（' + why + '）。再发一次，/new 开新会话，或 /ai 切回。');
        log('dsh EMPTY chat=' + chat + ' ' + why + ' took=' + took + ' err=' + r.errTail.replace(/\s+/g, ' ').slice(-300));
        emit('turn.empty', { chat: tag(chat), killedBy: r.killedBy || null, code: r.code, signal: r.signal || null, ms: Date.now() - T.t0 });
        run.end('failed', '没返回内容（' + why + '）');
        T.stop = true;
        return;
      }
      const { text: outText, files } = wx.extractSends(r.final);
      T.out = outText; T.files = files;
      if (outText) await wx.reply(msg, outText);
      if (files.length) await wx.sendFiles(msg, files);
    });
    app.stage('afterReply', 20, (T) => { T.run.end('done', '已回复（' + T.out.length + ' 字' + (T.files.length ? '，' + T.files.length + ' 个文件' : '') + '）'); });
    app.stage('afterReply', 90, (T) => {
      const { r } = T;
      const ms = Date.now() - T.t0;
      log('dsh reply sent chat=' + T.chat + ' len=' + T.out.length + ' files=' + T.files.length + ' route=' + (r.fallback ? 'deepseek' : 'go') + ' uncachedIn=' + r.usage + ' ctxPeak=' + r.usagePeak + ' took=' + (ms / 1000).toFixed(1) + 's sid=' + (r.sessionId || '-'));
      emit('turn.done', { chat: tag(T.chat), ms, len: T.out.length, files: T.files.length, route: r.fallback ? 'deepseek' : 'go', ctx: r.usagePeak, steps: T.run.step, tools: T.run.tools, fresh: !!T.fresh, kind: T.kind || 'chat' });
    });

    // reset（/new）：清掉前台会话
    app.stage('reset', 50, async (T) => {
      S.resetSession(T.chat);
      await wx.replySoft(T.msg, '✅ DSH 新会话已开。');
    });
  },
};

// ---------- 对外：跑一轮、排队 ----------
export function createAgent(app) {
  async function answer(msg, text, opts = {}) {
    const T = { msg, chat: wx.chatKey(msg), text, spoken: text || '', opts, t0: Date.now(), routePrefix: '', forceRecall: false, injected: false, fresh: false, stop: false, cleanups: [], out: '', files: [] };
    emit('turn.start', { chat: tag(T.chat), route: !!opts.route, reask: !!opts.reask, steer: /^\[用户在你执行任务的过程中插话\]/.test(text || '') });
    try {
      await app.runStage('input', T);
      if (!T.text) return;
      for (const s of ['turnStart', 'route', 'session', 'context', 'run', 'afterRun', 'deliver', 'afterReply']) {
        await app.runStage(s, T);
        if (T.stop) break;
      }
    } catch (e) {
      log('dsh ERROR chat=' + T.chat + ' err=' + errText(e));
      emit('turn.error', { chat: tag(T.chat), error: errText(e).slice(0, 200) });
      if (T.run) T.run.end('failed', '出错：' + errText(e));
      await wx.replySoft(msg, '⚠️ DSH 调用出错：' + errText(e) + '\n发 /ai 可以切回。');
    } finally {
      for (const f of T.cleanups) { try { f(); } catch {} }
      if (T.run && T.run.status === 'running') T.run.end('failed', '异常结束');
    }
  }
  const chatOf = (msg) => wx.chatKey(msg);
  const agent = {
    answer,
    enqueue: (msg, text, opts) => enqueue(chatOf(msg), () => answer(msg, text), opts),
    // 普通新消息：出队时先判定话题归属（前面排着的消息可能已经换了前台话题，所以必须出队时判）
    enqueueRouted: (msg, text) => enqueue(chatOf(msg), () => answer(msg, text, { route: true })),
    enqueueFn: (chat, fn, opts) => enqueue(chat, fn, opts),
    reset: (msg) => enqueue(chatOf(msg), async () => {
      const T = { msg, chat: chatOf(msg), stop: false };
      await app.runStage('reset', T);
    }),
    busy: (chat) => !!activeRuns.get(chat) || live.runningFor(chat).length > 0,
    anyBusy: () => activeRuns.size > 0 || live.snapshot().running.length > 0,
    queueBusy,
    active: (chat) => activeRuns.get(chat),
    interrupt: interruptCurrentRun,
  };
  return agent;
}
