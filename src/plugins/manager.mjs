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
import { wrapSteer, mailboxDelivery } from '../agent/prompts.mjs';
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

    async function handle(msg, chat, text) {
      const run = live.runningFor(chat)[0] || null;
      const d = await mgr.decide({ chat, text, run, helpers: helperBrief() });
      emit('manager.decide', { chat: tag(chat), action: d.action, ms: d.ms, route: d.route });
      if (d.action === 'fallback') {                 // 经理的模型都挂了 → 退回排队，不能丢话
        await wx.replySoft(msg, '📥 收到。（经理暂时联系不上，这句先排队，它做完手上的就处理。）');
        app.agent.enqueue(msg, text);
        log('manager fallback chat=' + chat + ' err=' + (d.error || '').slice(0, 160));
        return;
      }
      await wx.replySoft(msg, '🧑‍💼 ' + d.reply);
      const tw = d.toWorker || text;
      const a = app.agent.active(chat);
      if (d.action === 'note') mgr.mailboxAdd(tw);
      else if (d.action === 'answer' && d.question) mgr.answerQuestion(d.question, tw);
      else if (d.action === 'queue') app.agent.enqueueRouted(msg, tw);
      else if (d.action === 'split') { if (app.topics) app.topics.split(msg, chat); }
      else if (d.action === 'stop') {
        if (a && a.kind === 'chat') app.agent.interrupt(chat, a.runId).then((ok) => log('manager stop ' + (ok ? 'done' : 'noop') + ' chat=' + chat));
      } else if (d.action === 'redo') {
        if (a && a.kind === 'chat') {
          app.notify('preempt', { chat });
          app.agent.enqueue(msg, wrapSteer(tw), { priority: true });
          app.agent.interrupt(chat, a.runId).then((ok) => log('manager redo interrupt ' + (ok ? 'done' : 'noop') + ' chat=' + chat));
        } else mgr.mailboxAdd(tw);                     // 打断不了（在写交接等）→ 退成留言
      }
      log('manager chat=' + chat + ' action=' + d.action + ' ms=' + d.ms + ' route=' + d.route);
    }

    app.ingress(36, 'remember-last', (ctx) => { if (ctx.mode === 'dsh') lastDshMsg.set(ctx.chat, ctx.msg); });
    // ingress@60：工人忙 + 经理在岗 → 这句给经理（「停」在前面已经处理了；图片/文件没有文字，照旧排队）
    app.ingress(60, 'manager', (ctx) => {
      const { chat, msg, said } = ctx;
      if (!(ctx.mode === 'dsh' && said && !said.startsWith('/') && mgr.isOn(chat, cfg.managerMode) && app.agent.busy(chat))) return;
      ctx.managed = true;
      handle(msg, chat, said).catch((e) => log('manager ERROR chat=' + chat + ' ' + String((e && e.stack) || e)));
      return 'consume';
    });

    // 工人这一轮结束了、信箱里还有没看的留言 → 作为下一条消息交给它（保证不丢）
    app.every(cfg.mailboxPollMs, () => {
      const unread = mgr.mailboxUnread();
      if (!unread.length) return;
      for (const [chat, msg] of lastDshMsg) {
        if (app.agent.busy(chat) || app.agent.queueBusy(chat)) continue;
        mgr.mailboxMarkRead(unread.map((x) => x.id));
        log('mailbox deliver chat=' + chat + ' n=' + unread.length);
        emit('mailbox.deliver', { chat: tag(chat), n: unread.length });
        app.agent.enqueue(msg, mailboxDelivery(unread.map((x) => '- ' + x.text).join('\n')));
        break;
      }
    });

    app.stage('afterReply', 30, (T) => { try { mgr.noteWorkerReply(T.chat, T.out); } catch (e) { log('manager noteWorkerReply ERROR ' + errText(e)); } });
    app.api('manager', () => ({ unread: mgr.mailboxUnread().length, question: mgr.pendingQuestion() ? { q: String(mgr.pendingQuestion().q).slice(0, 120), at: mgr.pendingQuestion().at } : null }));
  },
};
