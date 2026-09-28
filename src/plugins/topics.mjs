/**
 * 无感多话题：一个微信聊天背后按话题分成多个 DSH 会话，每句普通消息出队后先判定归属，有把握才静默切换。
 *   判定逻辑在 memory/threads.mjs（词面 + 实体粗筛 → 经理快模型裁判 → 拿不准 GPT-6 Luna 复核）
 *   「切错了」→ 撤回、回原话题重答；/话题 看全部；/拆话题 把混在一起的旧对话往回拆开
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cfg, paths, APP_DIR } from '../core/config.mjs';
import { log, emit, errText, tag } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';
import * as S from '../agent/session.mjs';
import * as live from '../observe/live.mjs';
import { createRouter, misrouteClaim } from '../memory/threads.mjs';
import { makeTopicJudge } from '../manager/core.mjs';

const MISROUTE_NOFIND_NOTE = '【系统提示 — 主人看不到这段，别在回复里提】主人说话题放错了/串了，但系统没找到更合适的旧会话。' +
  '请结合上下文和交接目录判断他想接的是哪件事，直接按那件事回答；实在对不上再用一句话简单确认。\n\n';

// 首次启用时给「老主线」做画像：面板里记着的近期用户原话
function seedAnchorsFromLive(chat) {
  try {
    const j = JSON.parse(fs.readFileSync(paths.live, 'utf8'));
    const t = tag(chat);
    return (j.recent || []).filter((r) => r.chatTag === t && r.kind === 'chat' && r.task && !/^\[用户在你执行任务/.test(r.task))
      .map((r) => String(r.task).replace(/\[用户发来[^\]]*\]/g, '').trim()).filter(Boolean).reverse();
  } catch { return []; }
}

export default {
  name: 'topics', desc: '一个聊天框背后自动分话题，聊回旧事自动接上旧记忆',
  setup(app) {
    if (cfg.threadRouter === false) { log('topics: threadRouter=false，不启用'); return; }
    const threads = createRouter({
      stateFile: paths.threads,
      getSid: (chat) => S.getSid(chat) || null,
      setSid: (chat, sid) => S.setSid(chat, sid),
      getMeta: (chat) => S.getMeta(chat) || null,
      putMeta: S.putMeta,
      judge: makeTopicJudge({ log }),
      seedAnchors: seedAnchorsFromLive,
      watchDirs: [cfg.dshCwd, paths.root, paths.bin],
      shadow: !!cfg.threadRouterShadow,
      th: cfg.threadTh || {},
      log,
    });
    app.threads = threads;

    // ---------- 往回拆话题（后台跑 topic-split.mjs，1~3 分钟）----------
    let splitRunning = false, pendingSplit = null;
    function runSplit(msg, chat) {
      if (splitRunning) { wx.replySoft(msg, '🧑‍💼 正在拆，稍等。'); return; }
      if (app.agent.active(chat)) { pendingSplit = { msg, chat }; wx.replySoft(msg, '🧑‍💼 好，它这一轮做完我就拆（拆的时候要改话题表，不能跟它抢）。'); return; }
      splitRunning = true;
      wx.replySoft(msg, '🧑‍💼 开始把前面混在一起的话题拆开，1~3 分钟，好了告诉你。');
      emit('topic.split.start', { chat: tag(chat) });
      const ch = spawn(process.execPath, [path.join(APP_DIR, 'src/memory/topic-split.mjs'), '--apply', '--chat', chat], { cwd: paths.root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
      let out = '';
      ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
      ch.on('close', (code) => {
        splitRunning = false;
        const lines = out.split('\n').filter((l) => /^(▶|  「|✓|这个话题只有)/.test(l)).map((l) => l.replace(/：.*$/, '')).slice(0, 14);
        log('topic split chat=' + chat + ' exit=' + code);
        emit('topic.split.done', { chat: tag(chat), ok: code === 0 });
        wx.replySoft(msg, code === 0 ? '🧑‍💼 拆好了：\n' + lines.join('\n') + '\n\n以后聊到哪件事，会自动接上那件事自己的记忆。/话题 看全部。' : '⚠️ 拆话题失败了：' + out.slice(-200));
      });
    }
    app.topics = { split: runSplit };
    // 答应过的「做完这一轮就拆」
    app.every(Math.min(cfg.mailboxPollMs, 15000), () => {
      if (pendingSplit && !app.agent.busy(pendingSplit.chat)) { const p = pendingSplit; pendingSplit = null; runSplit(p.msg, p.chat); }
    });

    function report(chat) {
      const s = threads.summary(chat);
      if (!s) return '还没有话题记录（多话题已开，发条消息就有了）。';
      return '当前话题：「' + s.fg.title + '」\n全部话题（新的在前）：\n' +
        s.threads.slice(0, 12).map((t) => (t.id === s.fg.id ? '▶ ' : '· ') + t.title + '（' + live.dur(Date.now() - t.lastActiveAt) + '前）').join('\n') +
        '\n\n系统会按你说的内容自动切，不用管。切错了说「切错了」。';
    }
    app.command({ names: ['/话题', '/topics'], help: '看所有话题（自动切换，不用管）', handle: (ctx) => wx.replySoft(ctx.msg, report(ctx.chat)) });
    app.command({ names: ['/拆话题', '拆话题'], help: '把前面聊混了的话题拆开', handle: (ctx) => runSplit(ctx.msg, ctx.chat) });
    app.status((chat) => { const s = threads.summary(chat); return s ? '话题：「' + s.fg.title + '」（共 ' + s.count + ' 个，自动切换；/话题 查看）' : ''; });
    app.api('topics', () => {
      const st = threads._load();
      return Object.entries(st.chats || {}).map(([chat, c]) => ({
        chat: tag(chat), fg: c.fg,
        threads: Object.values(c.threads || {}).filter((t) => t.status === 'open').sort((a, b) => b.lastActiveAt - a.lastActiveAt)
          .map((t) => ({ id: t.id, title: t.title, lastActiveAt: t.lastActiveAt, createdAt: t.createdAt, anchors: (t.anchors || []).length, segments: (t.segments || []).length, origin: t.origin })),
      }));
    });

    // route@10：普通新消息判定归属（可能把 sid/meta 整体换成另一个话题的）
    app.stage('route', 10, async (T) => {
      if (T.opts.reask || !T.opts.route) return;
      const { chat, run, opts } = T;
      try {
        const rt = await threads.route(chat, opts.hint ? T.text : T.spoken, { fullText: T.text, hint: opts.hint });
        log('thread route chat=' + chat + ' ' + rt.action + (rt.to ? ' ' + rt.from + '→' + rt.to : '') + ' 「' + rt.title + '」 ' + rt.why);
        emit('topic.route', { chat: tag(chat), action: rt.action, from: rt.from || null, to: rt.to || null, why: String(rt.why || '').slice(0, 80) });
        if (rt.action !== 'stay') run.note('🧵 ' + (rt.action === 'new' ? '开了新话题「' : '回到话题「') + rt.title + '」');
        T.routePrefix = rt.prefix || '';
        if (opts.hint) {
          if (rt.action !== 'stay') {
            T.text = opts.hint.prev;
            T.routePrefix += '【系统提示 — 主人看不到这段】主人下面这句话刚才被放在别的会话里答了，他说放错了。请在这里重新回答它。\n\n';
          } else {
            if (opts.hint.interruptedPrev) T.text = opts.hint.prev + '\n（主人又说：' + T.text + '）';
            T.routePrefix += MISROUTE_NOFIND_NOTE;
            T.forceRecall = true;
          }
        }
      } catch (e) {
        log('thread route ERROR chat=' + chat + ' ' + String((e && e.stack) || e));   // 出任何错都当"留在原地"
      }
    });
    app.stage('afterReply', 10, (T) => { try { threads.noteReply(T.chat, T.out); } catch (e) { log('thread noteReply ERROR ' + errText(e)); } });
    app.stage('reset', 10, (T) => { try { threads.forceNew(T.chat); } catch (e) { log('thread forceNew ERROR ' + errText(e)); } });

    // 「切错了」：能撤回就撤回、回原话题重答；没切过就拿上一句重新找归属
    async function handleMisroute(msg, said, claim, ctx) {
      const chat = wx.chatKey(msg);
      const rv = threads.revert(chat);
      emit('topic.misroute', { chat: tag(chat), reverted: !!rv, interrupted: !!ctx.interrupted });
      if (rv) {
        let txt = rv.texts.join('\n');
        if (claim.extra) txt += '\n（主人补充：' + claim.extra + '）';
        log('misroute revert chat=' + chat + ' ' + rv.from + '→' + rv.to);
        return app.agent.answer(msg, txt, { raw: true, reask: { prefix: rv.prefix, note: '🧵 撤回：回到话题「' + rv.title + '」重答' } });
      }
      const prev = threads.lastUserText(chat);
      if (prev) return app.agent.answer(msg, said, { raw: true, route: true, hint: { prev, interruptedPrev: !!ctx.interrupted } });
      return app.agent.answer(msg, said, { raw: true, reask: { prefix: MISROUTE_NOFIND_NOTE } });
    }
    // ingress@40：放在叫停/改向前面判。先入队（插队首）再中断当前轮：正在答的多半就是放错地方的那句
    app.ingress(40, 'misroute', (ctx) => {
      if (ctx.mode !== 'dsh') return;
      const claim = misrouteClaim(ctx.said);
      if (!claim) return;
      const { chat, msg, said } = ctx;
      const a = app.agent.active(chat);
      const c = { interrupted: !!(a && a.kind === 'chat') };
      log('misroute claim chat=' + chat + ' text=' + JSON.stringify(said.slice(0, 40)) + (c.interrupted ? ' interrupt=' + a.runId.slice(0, 8) : ''));
      app.notify('preempt', { chat });
      app.agent.enqueueFn(chat, () => handleMisroute(msg, said, claim, c), { priority: true });
      if (c.interrupted) app.agent.interrupt(chat, a.runId).then((ok) => log('misroute interrupt ' + (ok ? 'done' : 'noop') + ' chat=' + chat)).catch((e) => log('misroute ERROR ' + errText(e)));
      return 'consume';
    });
  },
};
