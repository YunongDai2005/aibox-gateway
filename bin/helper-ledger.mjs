/**
 * helper-ledger：外援（GPT / Claude）每次调用的额度账本 + "还能调几次"估算。
 * 2026-09-28 Mac 端 Claude 写。ask-codex.mjs / ask-claude.mjs 写，aibox-quota.mjs 读。
 *
 * 一行一次调用：{ t, end, helper, model, effort, mode, secs, ok, before, after }
 *   before/after = { '5h': { u: 已用百分比, r: 重置时间 }, '7d': {...} }（拿不到就缺）
 *
 * 估算方法（两边官方都只给整数 %，单次调用常常看起来是 0% 或 1%，所以按平均）：
 *   单次花费 = 同一个窗口周期内调用前后已用 % 的差（Claude 优先用"下一次调用开始时"的读数，
 *     因为调用内最后一次请求的花费要到下一次才看得到；两次间隔超过 30 分钟就不用，免得混进主人自己的用量）
 *   每次平均 = 最近 20 次的平均；还能几次 = 剩余 % ÷ 每次平均，取 5 小时和每周里更紧的那个
 *   最近几次加起来还不到 1%：说明每次 < 1/n %，只给下限"至少 剩余×n 次"
 */
import fs from 'node:fs';

export const LEDGER = '/home/aibox/.aibox/helper-calls.jsonl';
const KEEP_DAYS = 14;
const SAMPLE = 20;
const NEXT_GAP_MS = 30 * 60e3;

export function record(entry) {
  try {
    fs.mkdirSync('/home/aibox/.aibox', { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify({ t: Date.now(), ...entry }) + '\n');
  } catch {}
}

export function load() {
  let rows = [];
  try { rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const cut = Date.now() - KEEP_DAYS * 86400e3;
  const kept = rows.filter((r) => r.t > cut);
  if (kept.length < rows.length) { try { fs.writeFileSync(LEDGER, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : '')); } catch {} }
  return kept;
}

// 某外援在某窗口的单次花费样本（新的在前）
function costs(rows, helper, win) {
  const rs = rows.filter((r) => r.helper === helper).sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i], b = r.before && r.before[win];
    if (!b || b.u == null) continue;
    let c = null;
    const nx = rs[i + 1], nb = nx && nx.before && nx.before[win];
    if (helper === 'claude' && nb && nb.u != null && nb.r === b.r && nx.t - (r.end || r.t) < NEXT_GAP_MS) c = nb.u - b.u;
    else { const a = r.after && r.after[win]; if (a && a.u != null && a.r === b.r) c = a.u - b.u; }
    if (c != null && c >= 0) out.push(c);
  }
  return out.reverse().slice(0, SAMPLE);
}

/**
 * current = { '5h': { usedPercent, label }, '7d': {...} }（现在的已用 %）
 * 返回 { calls, atLeast, limitedBy, perCall: { '5h': x, '7d': y }, samples, note }
 */
export function estimate(helper, current) {
  const rows = load();
  const all = rows.filter((r) => r.helper === helper);
  const res = { calls: null, atLeast: false, limitedBy: null, perCall: {}, perWindow: {}, samples: 0, totalCalls: all.length, lastCallAt: all.length ? new Date(all[all.length - 1].t).toISOString() : null, note: null };
  let best = null;
  for (const [win, cur] of Object.entries(current || {})) {
    if (!cur || cur.usedPercent == null) continue;
    const left = Math.max(0, 100 - cur.usedPercent);
    const cs = costs(rows, helper, win);
    res.samples = Math.max(res.samples, cs.length);
    if (cs.length < 3) continue;
    const mean = cs.reduce((s, x) => s + x, 0) / cs.length;
    res.perCall[win] = Math.round(mean * 100) / 100;
    const est = mean > 0 ? { calls: Math.floor(left / mean), atLeast: false } : { calls: Math.floor(left * cs.length), atLeast: true };
    res.perWindow[win] = est;
    if (!best || est.calls < best.calls) best = { ...est, limitedBy: cur.label || win };
  }
  if (best) Object.assign(res, best);
  else res.note = all.length ? '数据不够（记录了 ' + all.length + ' 次，至少要 3 次才估算）' : '还没有调用记录，调用几次后开始估算';
  return res;
}
