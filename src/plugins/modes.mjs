/**
 * 模式：同一个微信聊天可以切三个"大脑"
 *   /ai    OpenClaw（消息原样放行给 OpenClaw 插件）
 *   /dsh   DSH 工人（本网关接管）
 *   /local 台式机本地模型（Ollama）
 * 还有 /mode 看状态、/new 开新会话、/帮助 列出所有命令，以及去重和最终派发。
 */
import { cfg } from '../core/config.mjs';
import { log, emit, errText, tag } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';
import * as S from '../agent/session.mjs';
import { routeLabel } from '../agent/dsh.mjs';

export function modeLabel(mode) {
  if (mode === 'dsh') return 'DSH · ' + routeLabel();
  if (mode === 'local') return '本地模型 ' + cfg.localModel + '（台式机）';
  return 'OpenClaw（DeepSeek 按量）';
}

function slowNotice(msg, what) {
  const t = setTimeout(() => { wx.replySoft(msg, '⏳ ' + what + '还在处理，稍等…'); }, cfg.slowNoticeMs);
  return () => clearTimeout(t);
}

async function answerLocal(msg, text) {
  const chat = wx.chatKey(msg);
  const t0 = Date.now();
  if (!text) { await wx.replySoft(msg, '⚠️ 本地模型只能处理文字。图片/文件请发 /dsh 切到 DSH。'); return; }
  const stopSlow = slowNotice(msg, '本地模型');
  try {
    let lastErr = null, answer = '';
    for (let attempt = 1; attempt <= 2 && !answer; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), cfg.localTimeoutMs);
      try {
        const r = await fetch(cfg.ollamaUrl.replace(/\/+$/, '') + '/api/chat', {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
          body: JSON.stringify({ model: cfg.localModel, stream: false, keep_alive: -1, think: false, messages: [{ role: 'user', content: text }] }),
        });
        const j = await r.json();
        answer = (j && j.message && j.message.content) || '';
      } catch (e) { lastErr = e; } finally { clearTimeout(timer); }
      if (!answer && attempt === 1) await new Promise((r) => setTimeout(r, 1500));
    }
    stopSlow();
    if (answer) {
      await wx.reply(msg, answer);
      log('local reply sent chat=' + chat + ' len=' + answer.length + ' took=' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
      emit('local.done', { chat: tag(chat), ms: Date.now() - t0, ok: true });
    } else {
      await wx.replySoft(msg, '⚠️ 本地模型没响应（' + String((lastErr && lastErr.message) || '空回复') + '）。再发一次，或发 /ai 切回我。');
      log('local FAILED chat=' + chat + ' err=' + String((lastErr && lastErr.message) || 'empty'));
      emit('local.done', { chat: tag(chat), ms: Date.now() - t0, ok: false });
    }
  } catch (e) {
    stopSlow();
    log('local ERROR chat=' + chat + ' err=' + errText(e));
    await wx.replySoft(msg, '⚠️ 本地链路出错：' + errText(e) + '\n发 /ai 可以切回我。');
  }
}

export default {
  name: 'modes', core: true, desc: '切换大脑（OpenClaw / DSH / 本地模型）、去重、派发',
  setup(app) {
    const sw = (mode, extra = '') => (ctx) => {
      S.setMode(ctx.chat, mode); ctx.modes[ctx.chat] = mode;
      emit('mode.switch', { chat: tag(ctx.chat), mode });
      wx.replySoft(ctx.msg, '✅ 已切换 → ' + modeLabel(mode) + extra);
    };
    app.command({ names: ['/dsh'], help: '切到 DSH 工人（能操作电脑）', handle: sw('dsh', '\n/new 开新会话，/mode 看状态') });
    app.command({ names: ['/ai', '回来'], help: '切回 OpenClaw', handle: sw('ai') });
    app.command({ names: ['/local', '本地'], help: '切到台式机本地模型', handle: sw('local') });
    app.command({
      names: ['/mode', '模式'], help: '看现在用的是哪个大脑、会话和话题',
      handle: (ctx) => {
        const mode = S.modes()[ctx.chat] || 'ai';
        let t = '当前：' + modeLabel(mode);
        if (mode === 'dsh') {
          const meta = S.getMeta(ctx.chat);
          t += meta ? '\n会话：' + new Date(meta.startedAt).toLocaleString('zh-CN', { hour12: false }) + ' 开始' : '\n会话：下一条消息新开';
          for (const l of app.statusLines(ctx.chat, mode)) t += '\n' + l;
        }
        wx.replySoft(ctx.msg, t + '\n切换：/dsh /ai /local　新会话：/new');
      },
    });
    app.command({
      names: ['/new', '/reset'], modes: ['dsh'], help: '开一个新话题（旧的还在，聊回去会自动接上）',
      handle: (ctx) => { app.notify('new', ctx); emit('cmd.new', { chat: tag(ctx.chat) }); app.agent.reset(ctx.msg); },
    });
    app.command({
      names: ['/帮助', '/help', '帮助'], help: '列出所有命令',
      handle: (ctx) => {
        const L = app.commands.filter((c) => c.help).map((c) => c.names[0] + (c.names.length > 1 ? '（' + c.names.slice(1).join(' ') + '）' : '') + '：' + c.help);
        wx.replySoft(ctx.msg, '📖 命令（直接发）：\n' + L.join('\n') + '\n\n面板：' + cfg.dashboardUrl);
      },
    });

    // 去重：iLink 偶尔会把同一条消息推两次（只对网关接管的模式去重，OpenClaw 自己会处理）
    app.ingress(30, 'dedupe', (ctx) => {
      if ((ctx.mode === 'local' || ctx.mode === 'dsh') && wx.seenBefore(ctx.msg)) { log('dup msg dropped chat=' + ctx.chat); return 'consume'; }
    });
    // 最终派发
    app.ingress(80, 'local', (ctx) => { if (ctx.mode === 'local') { answerLocal(ctx.msg, ctx.t).catch(() => {}); return 'consume'; } });
    app.ingress(90, 'dsh', (ctx) => { if (ctx.mode === 'dsh') { app.agent.enqueueRouted(ctx.msg, ctx.t); return 'consume'; } });
  },
};
