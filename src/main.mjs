/**
 * AI Box 网关 v2 入口：装配插件 → 起微信代理（:8787）和面板 API（:8788）。
 * 插件的顺序就是它们在各挂点上的默认优先级来源之一；真正的先后由每个挂点的 order 决定。
 */
import { cfg, validate } from './core/config.mjs';
import { log, fatal, emit, errText, tag } from './core/log.mjs';
import { createApp } from './core/app.mjs';
import * as wx from './channel/wechat.mjs';
import * as S from './agent/session.mjs';
import * as live from './observe/live.mjs';
import { corePlugin, createAgent } from './agent/turn.mjs';
import modes from './plugins/modes.mjs';
import progress from './plugins/progress.mjs';
import handoff from './plugins/handoff.mjs';
import recall from './plugins/recall.mjs';
import helpers from './plugins/helpers.mjs';
import topics from './plugins/topics.mjs';
import stop from './plugins/stop.mjs';
import manager from './plugins/manager.mjs';
import steer from './plugins/steer.mjs';
import observe from './plugins/observe.mjs';
import evolve from './plugins/evolve.mjs';

// 任何没接住的异常只记录、不退出：让正在跑的轮次有机会自己收尾
process.on('uncaughtException', (e) => fatal('uncaughtException: ' + String((e && e.stack) || e)));
process.on('unhandledRejection', (e) => fatal('unhandledRejection: ' + String((e && e.stack) || e)));

const errs = validate(cfg);
if (errs.length) { fatal('配置有误，拒绝启动：\n  ' + errs.join('\n  ')); console.error('配置有误：\n  ' + errs.join('\n  ')); process.exit(78); }

export const app = createApp(cfg);
app.agent = createAgent(app);
for (const p of [corePlugin, observe, modes, progress, handoff, recall, helpers, topics, stop, manager, steer, evolve]) app.use(p);

// ---------- 入站：每条消息先过命令，再按 order 过入站管道 ----------
function findCommand(t, mode) {
  for (const c of app.commands) {
    if (c.modes && !c.modes.includes(mode)) continue;
    if (c.pattern) { const m = t.match(c.pattern); if (m) return [c, m]; }
    else if (c.names.includes(t)) return [c, null];
  }
  return null;
}
async function onUpdates(msgs) {
  const m = S.modes();
  const keep = [];
  let consumed = 0;
  for (const msg of msgs) {
    const chat = wx.chatKey(msg);
    try {
      const t = wx.textOf(msg).trim();
      const ctx = { msg, chat, t, modes: m, said: '', get mode() { return m[chat]; } };
      const hit = t && findCommand(t, m[chat]);
      if (hit) {
        consumed++;
        emit('cmd', { chat: tag(chat), name: hit[0].names[0] });
        Promise.resolve(hit[0].handle(ctx, hit[1])).catch((e) => log('command ERROR ' + hit[0].names[0] + ' ' + errText(e)));
        continue;
      }
      ctx.said = t || wx.voiceText(msg).trim();
      let verdict;
      for (const h of app.ingressList) {
        verdict = await h.fn(ctx);
        if (verdict === 'consume' || verdict === 'keep') break;
      }
      if (verdict === 'consume') consumed++;
      else keep.push(msg);
    } catch (e) {
      // 一条消息出错不连累同一批的其它消息（v1 会整批 502）
      consumed++;
      log('ingress ERROR chat=' + chat + ' ' + String((e && e.stack) || e));
      emit('ingress.error', { chat: tag(chat), error: errText(e).slice(0, 120) });
      wx.replySoft(msg, '⚠️ 网关处理这条消息时出错了（已记录）。再发一次试试，或 /ai 切回。');
    }
  }
  return { keep, consumed };
}

live.init();
const server = wx.createProxy({ onUpdates });
server.listen(cfg.listenPort, cfg.listenHost, () => {
  log('wx-router v2 listening on ' + cfg.listenHost + ':' + cfg.listenPort + ' -> ' + (() => { try { return wx.realBase(); } catch { return '?'; } })() + ' plugins=' + app.plugins.map((p) => p.name).join(','));
  emit('gateway.start', { engine: 'v2', plugins: app.plugins.map((p) => p.name) });
});
