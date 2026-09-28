/**
 * L1 自动调参：只动「数据参数」，每个参数有护栏（上下限、步长），每天最多动一步，
 * 每次改动都记账（tunables.json 的 history），效果变差自动回滚，/回滚调参 一键全退回主人的原始配置。
 *
 * 规则都很保守：信号够明确才动，而且会慢慢"回归"主人在 config.json 里设的基准值。
 */
import { cfg, paths } from '../core/config.mjs';
import { readJson, writeJson } from '../core/store.mjs';

// key：config 里的路径；base：主人在 config.json 里的值（没有就用默认）
export const TUNABLES = [
  {
    key: 'threadTh.switchSure', min: 0.70, max: 0.92, step: 0.02, dflt: 0.85,
    why: '话题切换的把握门槛',
    rule: (s) => (s.misroutes >= 2 ? +1 : s.quietDays.misroutes >= 7 ? -1 : 0),
    reason: (d) => (d > 0 ? '昨天「切错了」≥2 次 → 切换更谨慎' : '一周没切错 → 慢慢回到基准'),
  },
  {
    key: 'threadTh.newSure', min: 0.70, max: 0.92, step: 0.02, dflt: 0.85,
    why: '开新话题的把握门槛',
    rule: (s) => (s.misroutes >= 2 ? +1 : s.quietDays.misroutes >= 7 ? -1 : 0),
    reason: (d) => (d > 0 ? '昨天「切错了」≥2 次 → 开新话题更谨慎' : '一周没切错 → 慢慢回到基准'),
  },
  {
    key: 'progressEveryMs', min: 120000, max: 480000, step: 60000, dflt: 240000,
    why: '进度播报的最小间隔',
    rule: (s) => (s.noisy >= 1 ? +1 : s.progressQueries >= 3 ? -1 : 0),
    reason: (d) => (d > 0 ? '你嫌播报太多 → 报得稀一点' : '你干活期间常发 /进度 → 报得勤一点'),
  },
  {
    key: 'dshIdleMs', min: 600000, max: 1200000, step: 120000, dflt: 720000,
    why: '多久没动静算卡死',
    rule: (s) => (s.resumeAfterKill >= 1 ? +1 : s.quietDays.resumeAfterKill >= 14 ? -1 : 0),
    reason: (d) => (d > 0 ? '被停下后你让它「继续」→ 可能是误杀，放宽卡死判定' : '两周没误杀 → 慢慢回到基准'),
  },
];

const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
function set(o, p, v) { const ks = p.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ||= {}; x[ks.at(-1)] = v; }
const round = (v, step) => (step < 1 ? Math.round(v * 100) / 100 : Math.round(v));

export function state() { return readJson(paths.tunables, { values: {}, history: [] }); }
function save(st) { writeJson(paths.tunables, st); }
// 主人在 config.json 里的原始值（不含 tunables 叠加）
export function baseValue(t) {
  const file = readJson(cfg._file, {});
  const v = get(file, t.key);
  return typeof v === 'number' ? v : t.dflt;
}
export function currentValue(t) { const v = get(state().values, t.key); return typeof v === 'number' ? v : baseValue(t); }

/**
 * 按昨天的指标跑一遍规则。s = { misroutes, noisy, progressQueries, resumeAfterKill, quietDays: {misroutes, resumeAfterKill} }
 * 返回改动列表（已落盘；重启网关后生效）
 */
export function tune(s, { dry = false } = {}) {
  const st = state();
  const changes = [];
  for (const t of TUNABLES) {
    const dir = t.rule(s);
    if (!dir) continue;
    const base = baseValue(t), cur = currentValue(t);
    let next = round(cur + dir * t.step, t.step);
    // 回归只回到基准为止，不越过基准往另一边走
    if (dir < 0 && cur <= base) continue;
    if (dir < 0 && next < base) next = base;
    next = Math.min(t.max, Math.max(t.min, next));
    if (next === cur) continue;
    const ch = { at: Date.now(), key: t.key, from: cur, to: next, reason: t.reason(dir), level: 'L1' };
    changes.push(ch);
    if (!dry) { set(st.values, t.key, next); st.history.push(ch); }
  }
  if (!dry && changes.length) { st.history = st.history.slice(-200); save(st); }
  return changes;
}

// 效果变差 → 把最近一次 L1 改动退回去
export function rollbackLast(reason) {
  const st = state();
  const last = [...st.history].reverse().find((h) => h.level === 'L1' && !h.rolledBack);
  if (!last) return null;
  set(st.values, last.key, last.from);
  last.rolledBack = Date.now();
  st.history.push({ at: Date.now(), key: last.key, from: last.to, to: last.from, reason: '自动回滚：' + reason, level: 'rollback' });
  save(st);
  return last;
}
// 全部退回主人的原始配置
export function resetAll() {
  const st = state();
  const had = Object.keys(st.values || {}).length;
  st.history.push({ at: Date.now(), key: '*', reason: '主人要求全部回滚', level: 'reset' });
  st.values = {};
  save(st);
  return had;
}
export function describe() {
  return TUNABLES.map((t) => ({ key: t.key, why: t.why, base: baseValue(t), value: currentValue(t), min: t.min, max: t.max }));
}
