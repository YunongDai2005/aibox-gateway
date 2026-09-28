/**
 * 指标：吃事件总线，按天累计计数和耗时分布，落盘 ~/.aibox/evolve/metrics/YYYY-MM-DD.json。
 * 面板画图、自进化复盘都读这里。只记数字和短标签，不记对话原文。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../core/config.mjs';
import { on } from '../core/log.mjs';
import { readJson, writeJson } from '../core/store.mjs';

const dir = () => path.join(paths.evolve, 'metrics');
export const dayKey = (ts = Date.now()) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

let cur = null, dirty = false;
function blank(day) { return { day, counters: {}, dist: {}, updatedAt: Date.now() }; }
function load(day) { return readJson(path.join(dir(), day + '.json'), null) || blank(day); }
function ensure(ts) {
  const d = dayKey(ts);
  if (!cur || cur.day !== d) { if (cur && dirty) flush(); cur = load(d); }
  return cur;
}
export function inc(name, n = 1, ts) { const m = ensure(ts); m.counters[name] = (m.counters[name] || 0) + n; dirty = true; }
export function observe(name, v, ts) {
  const m = ensure(ts);
  const a = (m.dist[name] ||= []);
  a.push(Math.round(v));
  if (a.length > 2000) a.splice(0, a.length - 2000);
  dirty = true;
}
export function flush() {
  if (!cur || !dirty) return;
  cur.updatedAt = Date.now();
  try { writeJson(path.join(dir(), cur.day + '.json'), cur); dirty = false; } catch {}
}

export function pct(a, p) { if (!a || !a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }
export function summarize(m) {
  if (!m) return null;
  const c = m.counters || {}, d = m.dist || {};
  const turns = (c['turn.done'] || 0) + (c['turn.empty'] || 0) + (c['turn.error'] || 0);
  return {
    day: m.day,
    msgs: c['msg.in'] || 0,
    turns,
    ok: c['turn.done'] || 0,
    failed: (c['turn.empty'] || 0) + (c['turn.error'] || 0),
    interrupted: c['turn.interrupted'] || 0,
    successRate: turns ? (c['turn.done'] || 0) / turns : null,
    p50: pct(d['turn.ms'], 50), p90: pct(d['turn.ms'], 90),
    kills: (c['turn.empty.idle'] || 0) + (c['turn.empty.max'] || 0),
    fallbacks: c['route.fallback'] || 0,
    rotations: c['session.rotate'] || 0,
    topicSwitches: (c['topic.route.switch'] || 0) + (c['topic.route.new'] || 0),
    misroutes: c['topic.misroute'] || 0,
    stops: c['stop.done'] || 0,
    managerCalls: c['manager.decide'] || 0,
    managerFallbacks: c['manager.decide.fallback'] || 0,
    progressQueries: c['cmd.progress.busy'] || 0,
    progressSent: c['progress.sent'] || 0,
    complaints: c['signal.complaint'] || 0,
    retries: c['signal.retry'] || 0,
    llmCalls: c['llm.call'] || 0,
    llmFails: c['llm.call.fail'] || 0,
  };
}
export function today() { return summarize(ensure()); }
export function day(d) { return summarize(d === dayKey() ? ensure() : readJson(path.join(dir(), d + '.json'), null)); }
export function lastDays(n = 7) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) { const d = dayKey(Date.now() - i * 86400e3); const s = day(d); if (s) out.push(s); }
  return out;
}
export function raw(d) { return d === dayKey() ? ensure() : readJson(path.join(dir(), d + '.json'), null); }

// 事件 → 计数
const SUB = {
  'turn.empty': (e) => e.killedBy || (e.signal ? 'signal' : 'exit'),
  'topic.route': (e) => e.action,
  'manager.decide': (e) => e.action,
  'session.rotate': (e) => e.reason,
  'msg.in': (e) => e.mode,
  'signal': (e) => e.kind,
  'cmd.progress': (e) => (e.busy ? 'busy' : 'idle'),
};
export function start() {
  on('*', (e) => {
    if (e.type === 'signal') { inc('signal.' + e.kind, 1, e.ts); return; }
    inc(e.type, 1, e.ts);
    const f = SUB[e.type]; if (f) { const s = f(e); if (s) inc(e.type + '.' + s, 1, e.ts); }
    if (e.type === 'turn.done') observe('turn.ms', e.ms, e.ts);
    if (e.type === 'llm.call') { inc('llm.call.' + e.purpose, 1, e.ts); if (!e.ok) inc('llm.call.fail', 1, e.ts); observe('llm.ms.' + e.purpose, e.ms || 0, e.ts); }
  });
  const t = setInterval(flush, 30000); t.unref?.();
  process.on('exit', flush);
}
