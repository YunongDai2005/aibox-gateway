/**
 * 改方向（经理下班时的老办法）：工人干活时主人补充/改要求 → 先判「还是同一件事吗」
 *   同一件事 → 打断当前轮，在原会话里带着新要求接着做（不从头重来）
 *   另一件事 → 不打断，排队后由话题路由放到该去的话题
 * 防抖：第一句立刻打断重跑，之后 steerMergeMs 内的补充攒成一批只再打断一次，每轮最多 steerMax 批。
 * 经理在岗时这条路径基本不会走到（经理在 ingress@60 先接走了）。
 */
import { cfg } from '../core/config.mjs';
import { log, emit, errText, tag } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';
import { isHardStop } from '../vendor/stop-rules.mjs';
import { isSteer } from '../vendor/steer-rules.mjs';
import { wrapSteer } from '../agent/prompts.mjs';

export default {
  name: 'steer', desc: '经理不在时，干活途中的补充会打断并按新要求接着做',
  setup(app) {
    const pending = new Map();   // chat -> { timer, texts: [], batches }
    const clear = (chat) => { const p = pending.get(chat); if (!p) return; if (p.timer) clearTimeout(p.timer); pending.delete(chat); };
    app.listen('new', (ctx) => clear(ctx.chat));
    app.listen('preempt', ({ chat }) => clear(chat));

    // 返回 true = 已被合并吸收
    function absorb(chat, text, msg) {
      let p = pending.get(chat);
      if (!p) { p = { timer: null, texts: [], batches: 0 }; pending.set(chat, p); }
      if (p.batches >= cfg.steerMax) return false;
      if (text != null) p.texts.push(text);       // null：只开窗口不攒字（那句已经在执行了）
      if (p.timer) clearTimeout(p.timer);
      p.timer = setTimeout(() => flush(chat, p, msg), cfg.steerMergeMs);
      p.timer.unref?.();
      return true;
    }
    function flush(chat, p, msg) {
      if (pending.get(chat) !== p) return;
      pending.delete(chat);
      p.timer = null;
      const merged = p.texts.join('\n');
      if (!merged.trim()) return;
      const a = app.agent.active(chat);
      if (!a) {
        log('steer batch flushed (no active run) chat=' + chat + ' n=' + p.texts.length);
        app.agent.enqueue(msg, wrapSteer(merged), { priority: true });
        return;
      }
      if (a.kind === 'handoff') { log('steer batch deferred (handoff) chat=' + chat); app.agent.enqueue(msg, merged); return; }
      p.batches++;
      log('steer batch flush chat=' + chat + ' n=' + p.texts.length + ' batch=' + p.batches);
      app.agent.enqueue(msg, wrapSteer(merged), { priority: true });
      app.agent.interrupt(chat, a.runId).then((ok) => log('steer batch interrupt ' + (ok ? 'done' : 'noop') + ' chat=' + chat)).catch((e) => log('steer batch ERROR ' + errText(e)));
    }

    app.ingress(70, 'steer', async (ctx) => {
      const { chat, msg, t } = ctx;
      const steerLike = isSteer(t);
      if (!(ctx.mode === 'dsh' && app.agent.active(chat) && (steerLike || (!isHardStop(t) && t.length >= 4 && !t.startsWith('/'))))) return;
      const a = app.agent.active(chat);
      if (a.kind === 'handoff') {
        log('steer deferred (handoff running) chat=' + chat + ' text=' + JSON.stringify(t.slice(0, 40)));
        app.agent.enqueue(msg, t);
        return 'consume';
      }
      if (pending.has(chat)) {
        log('steer merged chat=' + chat + ' text=' + JSON.stringify(t.slice(0, 40)));
        if (!absorb(chat, t, msg)) { log('steer max reached, fallback queue chat=' + chat + ' text=' + JSON.stringify(t.slice(0, 40))); app.agent.enqueue(msg, t); }
        return 'consume';
      }
      log('steer requested chat=' + chat + ' text=' + JSON.stringify(t.slice(0, 40)) + ' run=' + a.runId.slice(0, 8));
      let same = true;
      if (app.threads) {
        try {
          const pk = await app.threads.peekTopic(chat, t);
          log('steer topic chat=' + chat + ' same=' + pk.same + ' sure=' + (pk.sure || 0).toFixed(2) + ' ' + pk.why);
          same = pk.same !== false;
        } catch (e) { log('steer topic ERROR chat=' + chat + ' ' + errText(e)); }
      }
      emit('steer', { chat: tag(chat), same });
      if (!same) {
        log('steer diverted (other topic) chat=' + chat + ' text=' + JSON.stringify(t.slice(0, 40)));
        app.agent.enqueueRouted(msg, t);
        return 'consume';
      }
      app.agent.enqueue(msg, wrapSteer(t), { priority: true });   // 先入队（插队首）再中断，顺序不能反
      absorb(chat, null, msg);
      (async () => {
        const ok = await app.agent.interrupt(chat, a.runId);
        log('steer interrupt ' + (ok ? 'done' : 'noop') + ' chat=' + chat + ' run=' + a.runId.slice(0, 8));
        await wx.replySoft(msg, ok ? '🔁 收到，接着改。' : '📥 收到，紧接着执行。');
      })().catch((e) => log('steer ERROR ' + errText(e)));
      return 'consume';
    });
  },
};
