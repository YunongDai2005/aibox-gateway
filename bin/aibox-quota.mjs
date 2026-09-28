#!/usr/bin/env node
/**
 * aibox-quota：查各条 AI 线路的剩余额度，写到 /home/aibox/.aibox/quota.json（不含任何密钥/邮箱）。
 * 数据源（都是官方返回的真实数值，不是估算）：
 *   - OpenCode Go   GET https://opencode.ai/zen/go/v1/usage       → 5h/周/月 已用百分比 + 重置时间
 *   - ChatGPT 订阅  GET https://chatgpt.com/backend-api/wham/usage → 5h/周 已用百分比 + 重置时间
 *   - DeepSeek API  GET https://api.deepseek.com/user/balance      → 余额
 *   - 本机统计      /home/aibox/wx-router/router.log                  → 今天 DSH 走 Go / DeepSeek 各几条
 * 由 systemd user timer `aibox-quota.timer` 每 5 分钟跑一次；手动：node /home/aibox/bin/aibox-quota.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseResetAt } from '/home/aibox/bin/claude-reset.mjs';
import { estimate, load as loadLedger } from '/home/aibox/bin/helper-ledger.mjs';

const OUT_DIR = '/home/aibox/.aibox';
const OUT = path.join(OUT_DIR, 'quota.json');
const TIMEOUT = 15000;

function credRef(name) {
  try {
    const s = fs.readFileSync(path.join(os.homedir(), '.dsh/.credentials.yaml'), 'utf8');
    const m = s.match(new RegExp('^\\s*' + name + ':\\s*(\\S+)', 'm'));
    return m ? m[1].replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}
async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  const t = await r.text();
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return JSON.parse(t);
}
const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);

async function go() {
  const key = credRef('OPENCODE_GO_API_KEY');
  if (!key) return { ok: false, error: '没有配置 key' };
  const j = await getJson('https://opencode.ai/zen/go/v1/usage', {
    Authorization: 'Bearer ' + key, 'x-opencode-session': 'ses_aibox_quota', 'User-Agent': 'aibox-quota/1.0 (ai-box)',
  });
  const u = j.usage || {};
  const w = (x) => (x ? { usedPercent: x.percent ?? null, status: x.status ?? null, resetsAt: x.resetsAt ?? null } : null);
  const windows = { '5小时': w(u.rolling), '每周': w(u.weekly), '每月': w(u.monthly) };
  // 2026-09-28：本月节奏 —— 月额度按 30 天均匀用，每天约 3.3%。主人觉得用得太少，面板上直接对比"应用到 / 实际"
  let pace = null;
  const mw = windows['每月'];
  if (mw && mw.resetsAt && mw.usedPercent != null) {
    const end = Date.parse(mw.resetsAt), start = end - 30 * 86400e3, frac = Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
    const expected = Math.round(frac * 1000) / 10;
    pace = { day: Math.max(1, Math.ceil(frac * 30)), expected, used: mw.usedPercent, ratio: expected > 0 ? Math.round((mw.usedPercent / expected) * 100) / 100 : null };
  }
  const cur = (k, lab) => windows[lab] && { usedPercent: windows[lab].usedPercent, label: lab };
  const advisor = estimate('go', { '5h': cur('5h', '5小时'), '7d': cur('7d', '每周'), '30d': cur('30d', '每月') });
  return { ok: true, windows, pace, advisor };
}

async function chatgpt() {
  const a = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex/auth.json'), 'utf8'));
  const t = a.tokens || {};
  const j = await getJson('https://chatgpt.com/backend-api/wham/usage', {
    Authorization: 'Bearer ' + t.access_token, 'chatgpt-account-id': t.account_id, originator: 'pi', version: '0.144.1',
  });
  const rl = j.rate_limit || {};
  const w = (x) => (x ? { usedPercent: x.used_percent ?? null, resetsAt: iso(x.reset_at) } : null);
  const windows = { '5小时': w(rl.primary_window), '每周': w(rl.secondary_window) };
  // 2026-09-28：按外援账本估算"还能做几次顾问"（取代"预计几点用完"）
  const advisor = estimate('gpt', { '5h': windows['5小时'] && { usedPercent: windows['5小时'].usedPercent, label: '5小时' }, '7d': windows['每周'] && { usedPercent: windows['每周'].usedPercent, label: '每周' } });
  return { ok: true, plan: j.plan_type || null, limitReached: !!rl.limit_reached, windows, advisor };
}

// Claude（Claude Code OAuth 订阅）
//
// 为什么没有百分比：Claude 的官方额度端点 /api/oauth/usage 需要 user:profile
// 权限，而本机 oauth-token（sk-ant-oat01-*）只有推理权限，调用会被拒：
//   permission_error: OAuth token does not meet scope requirement user:profile
// 对比：OpenCode Go 有 /zen/go/v1/usage 返 percent，ChatGPT 有
// /backend-api/wham/usage 返 used_percent —— 都是开放给订阅者的额度接口。
// Claude 没给我们这条路，所以只能用「探针」判断可用/限流。
//
// 探针策略（不花额度时的最佳近似）：
//   1. 读本地记录的最后一次探针结果（claude-state.json）
//   2. 若已过 resetsAt → 直接判定恢复可用
//   3. 否则显示上次已知状态 + 恢复时间
// 真实探针由 wx-router 在调用外援失败时写入，避免主动烧额度。
const CLAUDE_STATE = path.join(OUT_DIR, 'claude-state.json');
// 限流记录里解析不出恢复时间时，最多认它这么久；超过就当作「可能已恢复」
const CLAUDE_NO_RESET_TTL = 12 * 3600e3;

function claudeLocal() {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(CLAUDE_STATE, 'utf8')); } catch {}
  const now = Date.now();
  const det = st.detectedAt ? Date.parse(st.detectedAt) : NaN;
  const base = { ok: true, plan: st.plan || null, detectedAt: st.detectedAt || null,
                 lastOkAt: st.lastOkAt || null, resetText: st.resetText || null };
  if (st.limited) {
    // 老记录只有人类可读的 resetText → 以「探测时刻」为基准补算 resetsAt（现在卡住的那条会自动自愈）
    let resetsAt = st.resetsAt || null;
    if (!resetsAt && st.resetText && Number.isFinite(det)) resetsAt = parseResetAt(st.resetText, det);
    const resetMs = Date.parse(resetsAt || '');
    if (Number.isFinite(resetMs)) {
      if (now >= resetMs) {
        return { ...base, available: true, limited: false, resetsAt,
                 note: '已过恢复时间，额度应已重置（下次调用确认）' };
      }
      return { ...base, available: false, limited: true, resetsAt };
    }
    // 兜底：拿不到恢复时间
    const until = (Number.isFinite(det) ? det : 0) + CLAUDE_NO_RESET_TTL;
    if (now < until) {
      return { ...base, available: false, limited: true, resetsAt: new Date(until).toISOString(), guessed: true };
    }
    return { ...base, available: null, limited: null, resetsAt: null, stale: true,
             note: '限流记录没有恢复时间且已过期，可能已恢复（下次调用会重新探测）' };
  }
  if (st.lastOkAt) {
    // 最后已知正常 → 就算超过 24 小时也按可用算，只是注明
    const fresh = now - Date.parse(st.lastOkAt) < 24 * 3600e3;
    return { ...base, available: true, limited: false, resetsAt: null,
             note: fresh ? null : '超过 24 小时没用过，按上次状态推断' };
  }
  // 没有任何记录 → 状态未知（仍可尝试调用）
  return { ...base, available: null, limited: null, resetsAt: null,
           note: '还没有探测记录，还没用过 Claude 外援' };
}

async function claude() {
  const tokFile = path.join(os.homedir(), '.config/claude-code/oauth-token');
  let tok = '';
  try { tok = fs.readFileSync(tokFile, 'utf8').trim(); } catch {}
  if (!tok) return { ok: false, error: '没有配置 oauth-token' };
  const local = claudeLocal();
  // 2026-09-28：% 从哪来 —— 官方额度端点要 user:profile 权限（我们的令牌没有），但 Claude Code 每次调用的
  // stream-json 里都带 rate_limit_event（5 小时/每周已用比例 + 重置时间）。ask-claude 把它记进外援账本，这里取最新一次。
  // 局限：只在外援被调用时更新；主人自己在 Mac 上用 Claude 花掉的额度，要等下一次调用才看得到。
  const last = loadLedger().filter((r) => r.helper === 'claude' && (r.after || r.before)).pop();
  const windows = {};
  if (last) {
    const s = last.after || last.before;
    for (const [k, label] of [['5h', '5小时'], ['7d', '每周']]) {
      const x = s[k]; if (!x) continue;
      const resetsAt = x.r ? new Date(x.r * 1000).toISOString() : null;
      const passed = resetsAt && Date.parse(resetsAt) <= Date.now();
      windows[label] = { usedPercent: passed ? null : x.u, resetsAt: passed ? null : resetsAt, reset: !!passed };
    }
  }
  const cur = {};
  if (windows['5小时'] && windows['5小时'].usedPercent != null) cur['5h'] = { usedPercent: windows['5小时'].usedPercent, label: '5小时' };
  if (windows['每周'] && windows['每周'].usedPercent != null) cur['7d'] = { usedPercent: windows['每周'].usedPercent, label: '每周' };
  return { ...local, windows, asOf: last ? new Date(last.end || last.t).toISOString() : null, advisor: estimate('claude', cur),
           source: last ? 'Claude Code 调用时附带的额度信息' : '还没有带额度信息的调用记录' };
}

async function deepseek() {
  const key = credRef('DEEPSEEK_API_KEY');
  if (!key) return { ok: false, error: '没有配置 key' };
  const j = await getJson('https://api.deepseek.com/user/balance', { Authorization: 'Bearer ' + key });
  const b = (j.balance_infos || []).filter((x) => Number(x.total_balance) > 0);
  const main = b[0] || (j.balance_infos || [])[0] || {};
  return { ok: true, available: !!j.is_available, balance: Number(main.total_balance || 0), currency: main.currency || 'CNY' };
}

function todayRoutes() {
  const out = { go: 0, deepseek: 0, local: 0, failedGo: 0 };
  try {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    const lines = fs.readFileSync('/home/aibox/wx-router/router.log', 'utf8').split('\n').slice(-5000);
    for (const l of lines) {
      const m = l.match(/^\[([^\]]+)\]/); if (!m || new Date(m[1]) < d) continue;
      if (l.includes('dsh reply sent')) { if (l.includes('route=deepseek')) out.deepseek++; else if (l.includes('route=go')) out.go++; }
      else if (l.includes('local reply sent')) out.local++;
      else if (l.includes('go FAILED')) out.failedGo++;
    }
  } catch {}
  return out;
}

async function safe(fn) { try { return await fn(); } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 120) }; } }

const result = {
  updatedAt: new Date().toISOString(),
  go: await safe(go),
  chatgpt: await safe(chatgpt),
  claude: await safe(claude),
  deepseek: await safe(deepseek),
  today: todayRoutes(),
};
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---------- 历史采样 + 预测用完时间 ----------
const HIST = path.join(OUT_DIR, 'quota-history.jsonl');
const now = Date.now();
const sample = { t: now, go: {}, chatgpt: {} };
for (const src of ['go', 'chatgpt']) {
  if (result[src] && result[src].ok) for (const [k, w] of Object.entries(result[src].windows)) if (w) sample[src][k] = { u: w.usedPercent, r: w.resetsAt };
}
let hist = [];
try { hist = fs.readFileSync(HIST, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
hist.push(sample);
hist = hist.filter((h) => h.t > now - 7 * 86400e3);
fs.writeFileSync(HIST, hist.map((h) => JSON.stringify(h)).join('\n') + '\n');

// 用"同一个窗口周期内、最近 2 小时"的采样算消耗速度（%/小时），推算什么时候到 100%
function predict(src, name, w) {
  if (!w || w.usedPercent == null) return null;
  const pts = hist.filter((h) => h.t > now - 2 * 3600e3 && h[src] && h[src][name] && h[src][name].r === w.resetsAt).map((h) => ({ t: h.t, u: h[src][name].u }));
  if (pts.length < 2) return { ratePerHour: null, exhaustAt: null, note: '数据不够' };
  const first = pts[0], last = pts[pts.length - 1];
  const hrs = (last.t - first.t) / 3600e3;
  const rate = hrs > 0 ? (last.u - first.u) / hrs : 0;
  if (rate <= 0.01) return { ratePerHour: 0, exhaustAt: null, note: '近期没消耗' };
  const eta = now + ((100 - w.usedPercent) / rate) * 3600e3;
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : Infinity;
  return { ratePerHour: Math.round(rate * 10) / 10, exhaustAt: eta < reset ? new Date(eta).toISOString() : null, note: eta < reset ? '会在重置前用完' : '能撑到重置' };
}
for (const src of ['go', 'chatgpt']) {
  if (result[src] && result[src].ok) for (const [k, w] of Object.entries(result[src].windows)) if (w) w.forecast = predict(src, k, w);
}

// ---------- Go 用完 → 按真实重置时间提前切 DeepSeek ----------
const GO_STATE = '/home/aibox/wx-router/go-state.json';
let gs = {};
try { gs = JSON.parse(fs.readFileSync(GO_STATE, 'utf8')); } catch {}
if (result.go && result.go.ok) {
  const full = Object.values(result.go.windows).filter((w) => w && (w.usedPercent >= 100 || (w.status && w.status !== 'ok')));
  if (full.length) {
    const until = Math.max(...full.map((w) => Date.parse(w.resetsAt) || now + 3600e3));
    if (!(gs.cooldownUntil > until - 60e3)) { gs = { cooldownUntil: until, at: new Date().toISOString(), source: 'quota' }; fs.writeFileSync(GO_STATE, JSON.stringify(gs, null, 2)); }
  } else if (gs.source === 'quota' && gs.cooldownUntil > now) {
    gs = {}; fs.writeFileSync(GO_STATE, '{}\n'); // 我们设的冷却，Go 已恢复 → 解除
  }
}
if (gs.cooldownUntil > now) result.goCooldownUntil = new Date(gs.cooldownUntil).toISOString();

// ---------- 阈值提醒（每个窗口周期每档只提醒一次）----------
const ALERT = path.join(OUT_DIR, 'quota-alerts.json');
let sent = {};
try { sent = JSON.parse(fs.readFileSync(ALERT, 'utf8')); } catch {}
const LABEL = { go: 'OpenCode Go', chatgpt: 'ChatGPT（codex 外援）' };
const msgs = [];
const hm = (iso) => { const d = new Date(iso); return (d.toDateString() === new Date().toDateString() ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + d.toTimeString().slice(0, 5); };
for (const src of ['go', 'chatgpt']) {
  if (!(result[src] && result[src].ok)) continue;
  for (const [k, w] of Object.entries(result[src].windows)) {
    if (!w || w.usedPercent == null) continue;
    const left = 100 - w.usedPercent;
    const level = left <= 0 ? 'empty' : left <= 20 ? 'low' : null;
    const f = w.forecast || {};
    const soon = !level && f.exhaustAt && Date.parse(f.exhaustAt) - now < 3600e3 ? 'soon' : null;
    const lv = level || soon;
    if (!lv) continue;
    const key = src + '|' + k + '|' + w.resetsAt + '|' + lv;
    if (sent[key]) continue;
    sent[key] = now;
    const tail = w.resetsAt ? '，' + hm(w.resetsAt) + ' 重置' : '';
    if (lv === 'empty') msgs.push('⛔ ' + LABEL[src] + ' ' + k + '额度用完' + tail + (src === 'go' ? '。期间 DSH 自动走 DeepSeek 按量。' : '。期间 codex 外援不可用。'));
    else if (lv === 'low') msgs.push('⚠️ ' + LABEL[src] + ' ' + k + '额度只剩 ' + left + '%' + tail + (f.exhaustAt ? '，照现在速度约 ' + hm(f.exhaustAt) + ' 用完' : '') + '。');
    else msgs.push('⏱️ ' + LABEL[src] + ' ' + k + '额度照现在速度约 ' + hm(f.exhaustAt) + ' 用完（还剩 ' + left + '%' + tail + '）。');
  }
}
for (const [kk, ts] of Object.entries(sent)) if (ts < now - 8 * 86400e3) delete sent[kk];
fs.writeFileSync(ALERT, JSON.stringify(sent, null, 2));
if (msgs.length && !process.argv.includes('--no-notify')) {
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('/usr/bin/node', ['/home/aibox/bin/wx-notify.mjs', msgs.join('\n')], { timeout: 30000, stdio: 'ignore' });
  } catch (e) { result.notifyError = String((e && e.message) || e).slice(0, 120); }
}
result.alertsSent = msgs;

fs.writeFileSync(OUT + '.tmp', JSON.stringify(result, null, 2));
fs.chmodSync(OUT + '.tmp', 0o644);
fs.renameSync(OUT + '.tmp', OUT);
if (process.argv.includes('--print')) console.log(JSON.stringify(result, null, 2));
