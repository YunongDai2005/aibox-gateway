/**
 * 日志 + 事件总线。
 *   log(msg)            人看的文本日志 router.log（格式与 v1 一致，老工具/面板照读）
 *   emit(type, data)    机器看的结构化事件 → ~/.aibox/logs/events.jsonl（面板、指标、自进化都吃它）
 *   on(type, fn)        订阅事件（'*' = 全部）
 * 事件里不放原文长句：文本一律截断，经 redact 脱敏（密码/令牌长串打码）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.mjs';

const EVENTS_MAX_BYTES = 20 * 1024 * 1024;
const RING_MAX = 500;
const ring = [];
const subs = new Map();

export function log(msg) {
  try { fs.appendFileSync(paths.routerLog, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch {}
}
export function fatal(msg) {
  try { fs.appendFileSync(paths.routerLog, '[' + new Date().toISOString() + '] 【致命】' + msg + '\n'); } catch {}
}

export const errText = (e) => String((e && e.message) || e);
export const cut = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
// 打码：长得像密钥/令牌/密码的串（≥16 位字母数字混合，或 key=/token=/password= 后面的值）
export function mask(s) {
  return String(s ?? '')
    .replace(/((?:pass(?:word)?|pwd|token|secret|key|密码|口令)\s*[:：=]\s*)\S+/gi, '$1***')
    .replace(/\b(?=[A-Za-z0-9_\-]{16,}\b)(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[A-Za-z0-9_\-]{16,}\b/g, '***');
}

let rotating = false;
function rotateIfBig() {
  if (rotating) return;
  try {
    const st = fs.statSync(paths.events);
    if (st.size < EVENTS_MAX_BYTES) return;
    rotating = true;
    fs.renameSync(paths.events, paths.events + '.1');
  } catch {} finally { rotating = false; }
}

let n = 0;
export function emit(type, data = {}) {
  const ev = { ts: Date.now(), type, ...data };
  ring.push(ev); if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  try {
    fs.mkdirSync(path.dirname(paths.events), { recursive: true });
    fs.appendFileSync(paths.events, JSON.stringify(ev) + '\n');
    if (++n % 200 === 0) rotateIfBig();
  } catch {}
  for (const k of [type, '*']) for (const fn of subs.get(k) || []) { try { fn(ev); } catch (e) { log('event handler ERROR ' + type + ' ' + errText(e)); } }
  return ev;
}
export function on(type, fn) { if (!subs.has(type)) subs.set(type, []); subs.get(type).push(fn); return () => subs.set(type, subs.get(type).filter((f) => f !== fn)); }
export function recentEvents(since = 0, limit = 200) { return ring.filter((e) => e.ts > since).slice(-limit); }

// 聊天 id 只露前 6 位（日志、面板都用这个，别把完整 id 往外传）
export const tag = (chat) => String(chat || '').slice(0, 6);
