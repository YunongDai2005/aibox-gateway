/**
 * DSH 会话表（与 v1 同一份文件，可随时切回 v1）：
 *   dsh-sessions.json      chat -> 前台 sid
 *   dsh-session-meta.json  chat -> { sid, startedAt, resumedAt, msgCount, lastMsgAt, ctxIn, handoffWarned, pendingHandoff, fileInjectedAt }
 *   modes.json             chat -> 'ai' | 'dsh' | 'local'
 */
import fs from 'node:fs';
import { paths } from '../core/config.mjs';
import { log } from '../core/log.mjs';
import { readJson } from '../core/store.mjs';

const writeMeta = (m) => fs.writeFileSync(paths.meta, JSON.stringify(m, null, 2));

export function modes() { return readJson(paths.modes, {}); }
export function setMode(chat, mode) { const m = modes(); m[chat] = mode; fs.writeFileSync(paths.modes, JSON.stringify(m, null, 2)); log('mode ' + chat + ' -> ' + mode); }

export function sessions() { return readJson(paths.sessions, {}); }
export function getSid(chat) { return sessions()[chat]; }
export function setSid(chat, sid) { const m = sessions(); if (sid) m[chat] = sid; else delete m[chat]; fs.writeFileSync(paths.sessions, JSON.stringify(m, null, 2)); }

export function allMeta() { return readJson(paths.meta, {}); }
export function getMeta(chat) { return allMeta()[chat]; }
// 换了新 sid：开一份新 meta，接续消息计数；未消费的交接包保留
export function setMeta(chat, sid) {
  const m = allMeta();
  const prev = m[chat] || {};
  if (!sid) delete m[chat];
  else if (prev.sid !== sid) {
    const extra = {};
    if (prev.msgCount) extra.msgCount = prev.msgCount;
    if (prev.pendingHandoff) extra.pendingHandoff = prev.pendingHandoff;
    m[chat] = { sid, startedAt: Date.now(), ...extra };
  }
  writeMeta(m);
}
export function putMeta(chat, obj) { const m = allMeta(); if (obj) m[chat] = obj; else delete m[chat]; writeMeta(m); }
export function patchMeta(chat, patch) { const m = allMeta(); m[chat] = { ...(m[chat] || {}), ...(typeof patch === 'function' ? patch(m[chat] || {}) : patch) }; writeMeta(m); return m[chat]; }
export function bumpMsgCount(chat) { patchMeta(chat, (e) => ({ msgCount: (e.msgCount || 0) + 1, lastMsgAt: Date.now() })); }
export function setPendingHandoff(chat, p) { patchMeta(chat, { pendingHandoff: p }); }
export function markFileInject(chat) { patchMeta(chat, { fileInjectedAt: Date.now() }); }
export function clearPendingHandoff(chat) {
  const m = allMeta();
  const e = m[chat];
  if (e && e.pendingHandoff) {
    delete e.pendingHandoff;
    if (!e.sid && !e.msgCount && Object.keys(e).length === 0) delete m[chat];
    writeMeta(m);
  }
}
export function resetSession(chat) { setSid(chat, null); setMeta(chat, null); }
// 中断路径也要把新拿到的 sessionId 落盘，否则改向重跑拿不到 sid、会开新会话丢上下文
export function saveSessionIfAny(chat, r) {
  try { if (r && r.sessionId) { setSid(chat, r.sessionId); setMeta(chat, r.sessionId); } }
  catch (e) { log('saveDshSessionIfAny ERROR ' + String((e && e.message) || e)); }
}
