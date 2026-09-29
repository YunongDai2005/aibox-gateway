/**
 * 经理：工人（DSH）干活时"听不见"，这时主人的话先给经理（快模型，约 2 秒回）。
 * 经理看工人实时状态秒回主人，并决定 none / note / redo / stop / queue / answer / split（见 manager/core.mjs）。
 * note 进信箱，工人用 mailbox 命令看；没看的等这一轮结束后自动补交。工人用 ask-owner 问主人，主人的回答经经理写回。
 */
import { cfg } from '../core/config.mjs';
import { log, emit, errText, tag } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';
import * as live from '../observe/live.mjs';
import * as mgr from '../manager/core.mjs';
import { managerRevision, mailboxDelivery } from '../agent/prompts.mjs';
import { helperBrief } from './helpers.mjs';

export default {
  name: 'manager', desc: '工人忙时你随时说话，经理秒回并转达',
  setup(app) {
    const lastDshMsg = new Map();   // chat -> 最后一条消息（补交信箱时用它的 context_token 回复）

    function report(chat) {
      const on = mgr.isOn(chat, cfg.managerMode);
      const q = mgr.pendingQuestion();
      return (on ? '🧑‍💼 经理在岗' : '经理下班中') + '\n' +
        (app.agent.busy(chat) ? '工人正在干活，现在跟你说话的是经理。' : '工人空闲，你的话直接给工人。') + '\n' +
        '信箱未读 ' + mgr.mailboxUnread().length + ' 条' + (q ? '；工人在等你回答：「' + q.q.slice(0, 60) + '」' : '') + '\n' +
        '开关：/经理开 /经理关';
    }
    app.command({ names: ['/经理', '经理'], help: '经理在不在岗、信箱、工人有没有问题要问你', handle: (ctx) => wx.replySoft(ctx.msg, report(ctx.chat)) });
    app.command({
      names: ['/经理开', '/经理关'], help: '开关经理',
      handle: (ctx) => {
        const on = ctx.t === '/经理开';
        mgr.setOn(ctx.chat, on);
        emit('manager.toggle', { chat: tag(ctx.chat), on });
        wx.replySoft(ctx.msg, on ? '🧑‍💼 经理上班了：它干活时你随时说话，我秒回、帮你转达。' : '经理下班了，恢复原来的方式（干活时的话排队，「停」照样有效）。');
      },
    });
    app.status((chat) => (mgr.isOn(chat, cfg.managerMode) ? '经理：在岗' : ''));

    const decisions = new Map();
    const epochs = new Map();
    app.listen('preempt', ({ chat }) => epochs.set(chat, (epochs.get(chat) || 0) + 1));
    app.listen('new', ({ chat }) => epochs.set(chat, (epochs.get(chat) || 0) + 1));

    async function handle(msg, chat, text, target, run, epoch) {
      const d = await mgr.decide({ chat, text, run, runId: target?.runId, acceptedTask: target?.task, helpers: helperBrief() });
      emit('manager.decide', { chat: tag(chat), action: d.action, ms: d.ms, route: d.route });
      if ((epochs.get(chat) || 0) !== epoch) {
        await wx.replySoft(msg, '🧑‍💼 刚才那轮执行状态已经变化，这条要求尚未应用：' + text + '\n请确认要调整哪项任务。');
        return;
      }
      if (d.action === 'fallback') {                 // 经理的模型都挂了 → 退回排队，不能丢话
        await wx.replySoft(msg, '📥 收到。（经理暂时联系不上，这句先排队，它做完手上的就处理。）');
        app.agent.enqueueRouted(msg, text);
        log('manager fallback chat=' + chat + ' err=' + (d.error || '').slice(0, 160));
        return;
      }
      const tw = d.toWorker || text;
      const a = app.agent.active(chat);
      if (['redo', 'stop', 'note', 'answer'].includes(d.action) &&
          (!target || a !== target || a.state !== 'running' || (epochs.get(chat) || 0) !== epoch)) {
        await wx.replySoft(msg, '🧑‍💼 刚才那轮执行状态已经变化，这条要求尚未应用：' + text + '\n请确认要调整哪项任务。');
        return;
      }
      if (!['redo', 'stop', 'note'].includes(d.action)) await wx.replySoft(msg, '🧑‍💼 ' + d.reply);
      if (d.action === 'note') { mgr.mailboxAdd(tw, 'note', { chat, runId: target.runId, topicId: app.threads?.summary(chat)?.fg?.id || null }); await wx.replySoft(msg, '🧑‍💼 好，我转告它。这是可继续执行的补充，已放入信箱。'); }
      else if (d.action === 'answer' && d.question) mgr.answerQuestion(d.question, tw);
      else if (d.action === 'queue') app.agent.enqueueRouted(msg, tw);
      else if (d.action === 'split') { if (app.topics) app.topics.split(msg, chat); }
      else if (d.action === 'stop') {
        if (target.kind !== 'chat') { await wx.replySoft(msg, '🧑‍💼 当前在写交接，暂时无法安全打断。'); return; }
        app.notify('preempt', { chat });
        const ok = await app.agent.interrupt(chat, target.runId);
        await wx.replySoft(msg, ok && target.hasClosed ? '🧑‍💼 当前执行已停止。已完成的操作仍然保留。' : '🧑‍💼 已请求停止，但尚未确认进程退出。');
      } else if (d.action === 'redo') {
        if (target.kind !== 'chat') {
          await wx.replySoft(msg, '🧑‍💼 当前正在写交接，暂时无法安全打断；这条调整尚未执行，请稍后重发。');
          return;
        }
        app.notify('preempt', { chat });
        const revisionEpoch = epochs.get(chat) || 0;
        // Reserve the next queue slot before signalling, and gate it on confirmed exit.
        let release;
        const stopped = new Promise((resolve) => { release = resolve; });
        app.agent.enqueueFn(chat, async () => {
          if (!await stopped || (epochs.get(chat) || 0) !== revisionEpoch) return;
          const notes = mgr.mailboxUnread().filter(x => x.chat === chat && x.runId === target.runId);
          const original = (target.task || run?.task || '') + (notes.length ? '\n【此前尚未读取的补充】\n' + notes.map(x => x.text).join('\n') : '');
          if (notes.length) mgr.mailboxMarkRead(notes.map(x => x.id));
          await app.agent.answer(msg, managerRevision(original, tw), { raw: true });
        }, { priority: true });
        let ok = false;
        try { ok = await app.agent.interrupt(chat, target.runId); }
        finally { release(ok && target.hasClosed); }
        await wx.replySoft(msg, ok && target.hasClosed
          ? '🧑‍💼 好，我让它按新要求改。旧执行已停止，将保留未冲突的要求继续做。'
          : '🧑‍💼 尚未确认旧执行停止，未启动新的执行。请检查当前任务状态。');
      }
      log('manager chat=' + chat + ' action=' + d.action + ' ms=' + d.ms + ' route=' + d.route);
    }

    app.ingress(36, 'remember-last', (ctx) => { if (ctx.mode === 'dsh') lastDshMsg.set(ctx.chat, ctx.msg); });
    // ingress@60：工人忙 + 经理在岗 → 这句给经理（「停」在前面已经处理了；图片/文件没有文字，照旧排队）
    app.ingress(60, 'manager', (ctx) => {
      const { chat, msg, said } = ctx;
      if (!(ctx.mode === 'dsh' && said && !said.startsWith('/') && mgr.isOn(chat, cfg.managerMode) && app.agent.busy(chat))) return;
      ctx.managed = true;
      const target = app.agent.active(chat);
      const run = live.runningFor(chat)[0] || null;
      const epoch = epochs.get(chat) || 0;
      const pending = (decisions.get(chat) || Promise.resolve()).then(() => handle(msg, chat, said, target, run, epoch))
        .catch((e) => { log('manager ERROR chat=' + chat + ' ' + errText(e)); return wx.replySoft(msg, '🧑‍💼 这条要求处理失败，尚未确认应用，请重发。'); });
      decisions.set(chat, pending);
      pending.finally(() => { if (decisions.get(chat) === pending) decisions.delete(chat); });
      return 'consume';
    });

    // 工人这一轮结束了、信箱里还有没看的留言 → 作为下一条消息交给它（保证不丢）
    app.every(cfg.mailboxPollMs, () => {
      const unread = mgr.mailboxUnread();
      if (!unread.length) return;
      for (const [chat, msg] of lastDshMsg) {
        if (app.agent.busy(chat) || app.agent.queueBusy(chat)) continue;
        const topicId = app.threads?.summary(chat)?.fg?.id || null;
        const scoped = unread.filter((x) => !x.chat || (x.chat === chat && (!x.topicId || x.topicId === topicId)));
        if (!scoped.length) continue;
        mgr.mailboxMarkRead(scoped.map((x) => x.id));
        log('mailbox deliver chat=' + chat + ' n=' + scoped.length);
        emit('mailbox.deliver', { chat: tag(chat), n: scoped.length });
        app.agent.enqueue(msg, mailboxDelivery(scoped.map((x) => '- ' + x.text).join('\n')));
        break;
      }
    });

    app.stage('afterReply', 30, (T) => { try { mgr.noteWorkerReply(T.chat, T.out); } catch (e) { log('manager noteWorkerReply ERROR ' + errText(e)); } });
    app.api('manager', () => ({ unread: mgr.mailboxUnread().length, question: mgr.pendingQuestion() ? { q: String(mgr.pendingQuestion().q).slice(0, 120), at: mgr.pendingQuestion().at } : null }));
  },
};
