/**
 * 叫停：工人干活时主人说「停」「先别做了」（文字或语音）→ 立刻中断当前轮。
 * 只认确定性硬规则（vendor/stop-rules.mjs，纯正则）：宁可漏判不能误判。
 * 必须绕开聊天队列（否则排在旧任务后面，等于永远打断不了）。收尾写交接时不打断。
 */
import { log, emit, errText, tag } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';
import { isHardStop } from '../vendor/stop-rules.mjs';

export default {
  name: 'stop', desc: '说「停」立刻停下当前任务',
  setup(app) {
    app.ingress(50, 'hard-stop', async (ctx) => {
      const { chat, msg, said } = ctx;
      if (ctx.mode !== 'dsh' || !isHardStop(said) || !app.agent.active(chat)) return;
      const a = app.agent.active(chat);
      log('interrupt requested chat=' + chat + ' text=' + JSON.stringify(said.slice(0, 30)) + ' run=' + a.runId.slice(0, 8));
      if (a.kind === 'handoff') {
        log('interrupt refused (handoff running) chat=' + chat);
        emit('stop.refused', { chat: tag(chat) });
        await wx.replySoft(msg, '⏳ 这会正在收尾写交接，停不了。\n（就快好了，等它写完再发「停」我就停。）');
        return 'consume';
      }
      app.notify('preempt', { chat });
      (async () => {
        const ok = await app.agent.interrupt(chat, a.runId);
        log('interrupt ' + (ok ? 'done' : 'noop') + ' chat=' + chat + ' run=' + a.runId.slice(0, 8));
        emit('stop.done', { chat: tag(chat), ok, voice: !ctx.t });
        await wx.replySoft(msg, ok
          ? '⛔ 停了。\n（当前这轮已中断，做到哪没保留；发「继续」我接着做，/new 重新开始。）'
          : 'ℹ️ 这轮刚好已经结束了，没需要停的。');
      })().catch((e) => log('interrupt ERROR ' + errText(e)));
      return 'consume';
    });
  },
};
