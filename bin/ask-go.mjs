#!/usr/bin/env node
/**
 * ask-go：用 OpenCode Go 包月里的强模型当顾问（不占主人的 ChatGPT Plus / Claude 额度）。2026-09-28 Mac 端 Claude 写。
 * 一般不直接调，用 `helper start go --model <模型> ...`（helper 负责后台运行、进度、日志）。
 *   echo "问题" | ask-go.mjs <模型> [--effort low|medium|high]
 *
 * 模型（2026-09-28 实测同一道技术题；价格/上限来自 opencode.ai/docs/go）：
 *   gpt-6-luna       10s  准确简洁、最快、最便宜        $0.10/$0.50 · 上限 $15（走 /responses 协议）  ← 默认
 *   kimi-k3          36s  答得最好（给推荐做法）      $3/$15 每百万 · 上限 $15（贵）
 * ⚠️ 「上限 $15」不是额外额度：共用 Go 的 $60，按 60÷15=4 倍扣（2026-09-28 实测）。
 *   deepseek-v4-pro  40s  准确简洁                      $0.66-1.32/$1.98-3.96 · 上限 $15
 *   glm-5.3          63s  准确、最详细                  $1.40/$4.40 · 上限 $15
 *   grok-4.7         60s  准确                          $2/$6 · 上限 $15（走 /responses 协议）
 * GPT/Grok 系在 Go 上只认 /responses；其余走 /chat/completions。都读不了文件：把要看的内容贴进问题里。
 * 退出码：0 成功 · 2 用法 · 3 额度用完/限流 · 4 其他失败
 */
import fs from 'node:fs';
import { record } from '/home/aibox/bin/helper-ledger.mjs';

const BASE = 'https://opencode.ai/zen/go/v1';
const RESPONSES = /^(gpt-|grok-)/;           // 这些模型只支持 /responses
const args = process.argv.slice(2);
let effort = null; const ei = args.indexOf('--effort'); if (ei >= 0) { effort = args[ei + 1]; args.splice(ei, 2); }
const model = args[0] && !args[0].startsWith('-') ? args.shift() : 'gpt-6-luna';
let prompt = args.filter((a) => a !== '--stdin' && a !== '-').join(' ').trim();
if (!prompt) prompt = fs.readFileSync(0, 'utf8').trim();
if (!prompt) { console.error('用法：echo "问题" | ask-go.mjs <模型> [--effort high]'); process.exit(2); }
const key = (() => { try { const s = fs.readFileSync('/home/aibox/.dsh/.credentials.yaml', 'utf8'); const m = s.match(/^\s*OPENCODE_GO_API_KEY:\s*(\S+)/m); return m ? m[1].replace(/^["']|["']$/g, '') : ''; } catch { return ''; } })();
if (!key) { console.error('没有 OPENCODE_GO_API_KEY'); process.exit(4); }
const H = { 'content-type': 'application/json', authorization: 'Bearer ' + key, 'x-opencode-session': 'ses_aibox_askgo' };
const SYS = '你是被另一个 AI 助手（DSH）请来的技术顾问。用中文，简短直接：先给结论，再给理由和具体做法。拿不准就说拿不准。';

// ---- 实时动态（helper 设 HELPER_LIVE）----
const LIVE = process.env.HELPER_LIVE || null;
const live = { phase: '启动中', activity: [], chars: 0, events: {} };
let liveLast = 0;
function liveWrite(force) { if (!LIVE || (!force && Date.now() - liveLast < 1500)) return; liveLast = Date.now(); live.updatedAt = new Date().toISOString(); try { fs.writeFileSync(LIVE + '.tmp', JSON.stringify(live)); fs.renameSync(LIVE + '.tmp', LIVE); } catch {} }
function liveAct(x) { live.activity.push({ t: Date.now(), x: String(x).replace(/\s+/g, ' ').slice(0, 160) }); if (live.activity.length > 60) live.activity.shift(); }

// ---- Go 额度（账本用）----
async function usage() {
  try {
    const j = await (await fetch(BASE + '/usage', { headers: H, signal: AbortSignal.timeout(6000) })).json();
    const u = j.usage || {}; const w = (x) => (x && x.percent != null ? { u: x.percent, r: x.resetsAt || null } : undefined);
    return { '5h': w(u.rolling), '7d': w(u.weekly), '30d': w(u.monthly) };
  } catch { return null; }
}

const t0 = Date.now();
const before = await usage();
let out = '', reasoningChars = 0, failMsg = null;
const done = async (ok) => { live.chars = out.length; if (!ok) live.phase = '失败'; liveWrite(true);
  record({ t: t0, end: Date.now(), helper: 'go', model, effort: effort || 'default', mode: 'advise', secs: Math.round((Date.now() - t0) / 1000), ok, before, after: await usage() }); };

const useResp = RESPONSES.test(model);
const body = useResp
  ? { model, instructions: SYS, input: prompt, stream: true, max_output_tokens: 16000, ...(effort ? { reasoning: { effort, summary: 'detailed' } } : { reasoning: { summary: 'detailed' } }) }
  : { model, stream: true, max_tokens: 16000, messages: [{ role: 'system', content: SYS }, { role: 'user', content: prompt }], ...(effort ? { reasoning_effort: effort } : {}) };
live.phase = '已发出问题（' + prompt.length + ' 字），等 ' + model + ' 回应'; liveAct('发出问题 ' + prompt.length + ' 字 → ' + model); liveWrite(true);
const hb = setInterval(() => { live.chars = out.length; liveWrite(true); console.error('[ask-go] ' + model + ' ' + Math.round((Date.now() - t0) / 1000) + 's，' + (out.length ? '已写 ' + out.length + ' 字' : '思考中（已想 ' + reasoningChars + ' 字）')); }, 20000);

const ac = new AbortController();
const IDLE_MS = 600000;   // 10 分钟一点数据都没有才算卡死（强模型会先长时间思考）
let res;
try { res = await fetch(BASE + (useResp ? '/responses' : '/chat/completions'), { method: 'POST', headers: H, body: JSON.stringify(body), signal: ac.signal }); }
catch (e) { clearInterval(hb); console.error('连接失败：' + e.message); await done(false); process.exit(4); }
if (!res.ok) {
  clearInterval(hb); const t = await res.text();
  console.error('HTTP ' + res.status + '：' + t.slice(0, 300)); await done(false);
  process.exit(res.status === 429 || /limit|quota|exceed/i.test(t) ? 3 : 4);
}
function frame(line) {
  if (!line.startsWith('data:')) return;
  const d = line.slice(5).trim(); if (!d || d === '[DONE]') return;
  let j; try { j = JSON.parse(d); } catch { return; }
  if (useResp) {
    const t = j.type; live.events[t] = (live.events[t] || 0) + 1;
    if (t === 'response.output_text.delta') { if (!out) { live.phase = '在写回答'; liveAct('开始写回答'); } out += j.delta || ''; }
    else if (t === 'response.reasoning_summary_text.delta') { live.phase = '在思考'; reasoningChars += (j.delta || '').length; }
    else if (t === 'response.reasoning_summary_part.done' && j.part && j.part.text) liveAct('💭 ' + j.part.text.slice(0, 140));
    else if (/failed|error|incomplete/.test(t)) failMsg = JSON.stringify(j.response && j.response.error || j.error || t).slice(0, 300);
  } else {
    const dl = j.choices && j.choices[0] && j.choices[0].delta || {};
    if (dl.reasoning_content) { if (!reasoningChars) { live.phase = '在思考'; liveAct('开始思考'); } reasoningChars += dl.reasoning_content.length; }
    if (dl.content) { if (!out) { live.phase = '在写回答'; liveAct('开始写回答（想了 ' + reasoningChars + ' 字）'); } out += dl.content; }
    if (j.error) failMsg = JSON.stringify(j.error).slice(0, 300);
  }
  liveWrite(false);
}
try {
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  for (;;) {
    let timer; const tick = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new Error(Math.round(IDLE_MS / 60000) + ' 分钟没有任何数据')); }, IDLE_MS); });
    let r; try { r = await Promise.race([reader.read(), tick]); } finally { clearTimeout(timer); }
    if (r.done) { if (buf.trim()) frame(buf); break; }
    buf += dec.decode(r.value, { stream: true }); const ls = buf.split('\n'); buf = ls.pop(); for (const l of ls) frame(l);
  }
} catch (e) { clearInterval(hb); console.error('读取中断：' + e.message + '（已收 ' + out.length + ' 字）'); if (out) console.log(out.trim()); await done(false); process.exit(4); }
clearInterval(hb);
out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();   // 有的模型会把思考混在正文里
if (failMsg && !out) { console.error(model + ' 返回失败：' + failMsg); await done(false); process.exit(/limit|quota|exceed/i.test(failMsg) ? 3 : 4); }
if (!out) { console.error(model + ' 没有输出正文（思考了 ' + reasoningChars + ' 字）'); await done(false); process.exit(4); }
live.phase = '完成'; liveAct('✓ 完成，' + out.length + ' 字');
console.log(out);
console.log('\n[Go 顾问 · ' + model + ' · 用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒 · 走 OpenCode Go 包月]');
await done(true);
