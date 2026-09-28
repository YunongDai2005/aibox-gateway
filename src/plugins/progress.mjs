/**
 * 进度播报：工人干活时往微信报「在干嘛」。
 *   首报 progressFirstMs（45 秒）；之后有新动静才报，最多 progressEveryMs（4 分钟）一次；
 *   【进展】行和请外援立即报（与上一条隔 ≥ progressGapMs）；每个任务最多 progressMax 条；
 *   跑到 dshWarnMs 提醒一次快到总上限。/进度 随时查。
 */
import { cfg } from '../core/config.mjs';
import { log, emit, tag } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';
import * as live from '../observe/live.mjs';

function reporter(msg, run) {
  let sent = 0, lastAt = 0, lastSig = '';
  const pending = [];
  const send = (t) => {
    if (sent >= cfg.progressMax) return;
    sent++; lastAt = Date.now(); lastSig = run.step + '/' + run.tools;
    if (sent === cfg.progressMax) t += '\n（进度播报到上限了，之后发 /进度 查看）';
    wx.replySoft(msg, t);
    log('progress sent chat=' + run.chatTag + ' n=' + sent + ' ' + t.replace(/\s+/g, ' ').slice(0, 80));
    emit('progress.sent', { chat: run.chatTag, n: sent });
  };
  run.on((ev) => {
    if (ev.kind === 'milestone') pending.push('📍 ' + ev.text);
    else if (ev.kind === 'codex') pending.push('🤝 ' + live.cut(ev.text, 100));
  });
  let warned = false;
  const tick = Math.min(3000, Math.max(100, Math.floor(cfg.progressFirstMs / 3)));
  const iv = setInterval(() => {
    const now = Date.now();
    if (!warned && now - run.startedAt >= cfg.dshWarnMs) {
      warned = true;
      wx.replySoft(msg, '⚠️ 这个任务已经跑了 ' + Math.round(cfg.dshWarnMs / 60000) + ' 分钟，到 ' + Math.round(cfg.dshTimeoutMs / 60000) + ' 分钟会强制停下（进度保留，停了可以发「继续」）。\n' + live.describe(run, '现在'));
      log('progress warn chat=' + run.chatTag);
    }
    if (pending.length && now - lastAt >= cfg.progressGapMs) {
      send(pending.splice(0).join('\n') + '\n（已 ' + live.dur(now - run.startedAt) + '，还在继续）');
      return;
    }
    if (now - run.startedAt < cfg.progressFirstMs) return;
    if (!lastAt) return send(live.describe(run, '⏳ 还在做'));
    if (now - lastAt >= cfg.progressEveryMs && run.step + '/' + run.tools !== lastSig) send(live.describe(run, '⏳ 还在做'));
  }, tick);
  iv.unref?.();
  return { stop: () => clearInterval(iv), get sent() { return sent; } };
}

export function progressReport(chat) {
  const rs = live.runningFor(chat);
  if (rs.length) return rs.map((r) => live.describe(r, r.kind === 'handoff' ? '🗂 正在生成交接包' : '⏳ DSH 正在做')).join('\n\n') + '\n\n面板：' + cfg.dashboardUrl;
  const last = live.lastFor(chat);
  let t = '✅ DSH 现在空闲';
  if (last) t += '\n上一个任务：' + live.cut(last.task, 40) + '\n结果：' + ({ done: '完成', failed: '失败', interrupted: '被中断' }[last.status] || last.status) + ' · 用时 ' + live.dur(last.took || 0) + ' · ' + last.step + ' 步';
  return t;
}

export default {
  name: 'progress', desc: '干活时往微信报进度，/进度 随时查',
  setup(app) {
    app.command({
      names: ['/进度', '进度', '/状态', '/progress'], help: '工人现在在干嘛',
      handle: (ctx) => { emit('cmd.progress', { chat: tag(ctx.chat), busy: live.runningFor(ctx.chat).length > 0 }); wx.replySoft(ctx.msg, progressReport(ctx.chat)); },
    });
    app.stage('turnStart', 20, (T) => {
      const rep = reporter(T.msg, T.run);
      T.rep = rep;
      T.cleanups.push(() => rep.stop());
    });
    app.stage('afterRun', 1, (T) => { if (T.rep) T.rep.stop(); });
  },
};
