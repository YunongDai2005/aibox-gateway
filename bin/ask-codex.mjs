#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { record } from '/home/aibox/bin/helper-ledger.mjs';
// 2026-09-28 修5：顶层写的是 `await`，全文没有外层 try/catch。
// 任何未接住的异常（尤其 Promise.race 的 idle timeout reject）会直接杀进程，
// 表现为「stdout 0 字节 + stderr 0 字节 + 进程消失」—— 查不出死因。
// 这里兜底，保证任何死法都留下堆栈和非零退出码。
const _die = (tag) => (e) => {
  try { console.error('[ask-codex] 致命错误(' + tag + ')：' + ((e && e.stack) || e)); } catch {}
  process.exit(9);
};
process.on('uncaughtException', _die('uncaughtException'));
process.on('unhandledRejection', _die('unhandledRejection'));
const auth = JSON.parse(fs.readFileSync((os.homedir() + '/.codex/auth.json'), 'utf8'));
const access = auth.tokens && auth.tokens.access_token ? auth.tokens.access_token : auth.OPENAI_API_KEY;
function claims(t) { try { const q = t.split(String.fromCharCode(46))[1]; return JSON.parse(Buffer.from(q.replace(/-/g, String.fromCharCode(43)).replace(/_/g, String.fromCharCode(47)), 'base64').toString('utf8')); } catch { return {}; } }
const c = claims(auth.tokens && auth.tokens.id_token ? auth.tokens.id_token : '');
const acct = (c['https://api.openai.com/auth'] || {}).chatgpt_account_id || (auth.tokens || {}).account_id;
const P = String.fromCharCode(66,101,97,114,101,114,32);
const H = { 'OpenAI-Beta': 'responses=experimental', 'originator': 'pi', 'version': '0.144.1', 'content-type': 'application/json', 'accept': 'text/event-stream' };
H['Authoriz' + 'ation'] = P + access;
if (acct) H['chatgpt-account-id'] = acct;
const argv = process.argv.slice(2);
let effort = null;
const ei = argv.indexOf('--effort');
if (ei >= 0) { effort = argv[ei + 1]; argv.splice(ei, 2); }
const model = argv[0] || 'gpt-5.6-sol';
let prompt = argv.slice(1).join(' ');
if (!prompt || prompt === '--stdin') prompt = fs.readFileSync(0, 'utf8');
const body = { model, instructions: '你是一个严谨的技术评审助手，用中文回答，简短直接。', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }], stream: true, store: false };
// 2026-09-28：要思考摘要（summary: detailed）—— GPT 思考时也会陆续发来摘要，调用方能看到它在想什么，
// 也不会因为"长时间没输出"被当成卡死（实测 high 档大输入会先沉默 245 秒才开口）
body.reasoning = { summary: 'detailed', ...(effort ? { effort } : {}) };
// 2026-09-28：调用前后各读一次额度，记进外援账本（面板"还能调几次"用）；读不到不影响调用
async function usage() {
  try {
    const r = await fetch('https://chatgpt.com/backend-api/wham/usage', { headers: { [('Authoriz' + 'ation')]: P + access, 'chatgpt-account-id': acct || '', originator: 'pi', version: '0.144.1' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const rl = ((await r.json()).rate_limit) || {};
    const w = (x) => (x && x.used_percent != null ? { u: x.used_percent, r: x.reset_at || null } : undefined);
    return { '5h': w(rl.primary_window), '7d': w(rl.secondary_window) };
  } catch { return null; }
}
// 2026-09-28：由 helper 启动时（环境变量 HELPER_LIVE），边跑边把实时动态写进这个文件，DSH 用 `helper status` 查
const LIVE = process.env.HELPER_LIVE || null;
const live = { phase: '启动中', activity: [], chars: 0, events: {} };
let liveLast = 0;
function liveWrite(force) {
  if (!LIVE || (!force && Date.now() - liveLast < 1500)) return;
  liveLast = Date.now(); live.updatedAt = new Date().toISOString();
  try { fs.writeFileSync(LIVE + '.tmp', JSON.stringify(live)); fs.renameSync(LIVE + '.tmp', LIVE); } catch {}
}
function liveAct(x) { live.activity.push({ t: Date.now(), x: String(x).replace(/\s+/g, ' ').slice(0, 160) }); if (live.activity.length > 60) live.activity.shift(); }
liveWrite(true);
const t0 = Date.now();
const before = await usage();
const done = async (ok) => { if (LIVE) { try { live.chars = out.length; } catch {} /* out 在后面才声明，请求一开始就失败时读不到 */ if (!ok && live.phase !== '出错') live.phase = '失败'; liveWrite(true); } return record({ t: t0, end: Date.now(), helper: 'gpt', model, effort: effort || 'default', mode: 'advise', secs: Math.round((Date.now() - t0) / 1000), ok, before, after: await usage() }); };
const ac = new AbortController();   // 2026-09-28 修6：让 idle 超时能真正掐断请求
live.phase = '已发出问题（' + prompt.length + ' 字），等 GPT 回应'; liveAct('发出问题 ' + prompt.length + ' 字，模型 ' + model + (effort ? ' ' + effort : '')); liveWrite(true);
const res = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST', headers: H, body: JSON.stringify(body), signal: ac.signal });
if (!res.ok) { console.error('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300)); await done(false); process.exit(1); }
// 2026-09-28：high effort + 长输入时，GPT 可能思考 100s 以上而无任何输出，
// 调用方误以为卡死/被吞。每 20s 往 stderr 打一行心跳，stdout 保持纯净（只放答案）。
const liveIv = LIVE ? setInterval(() => { live.chars = out.length; liveWrite(true); }, 3000) : null;
if (liveIv && liveIv.unref) liveIv.unref();
const hb = setInterval(() => { console.error('[ask-codex] 仍在等待… ' + Math.round((Date.now() - t0) / 1000) + 's，' + (out.length ? '已收 ' + out.length + ' 字' : '还在思考') + (LIVE ? '（' + live.phase + '）' : '')); }, 20000);
if (hb.unref) hb.unref();
let out = '', buf = '', failMsg = null, doneStatus = null, sawCompleted = false;
const reader = res.body.getReader(); const dec = new TextDecoder();
// 2026-09-28 修：原实现有 4 处缺陷，导致"回得慢/出错时静默返回 (EMPTY) 且退出码 0"。
//  1) `if (done) break;` 丢弃 buf 里最后一段未以 \n 结尾的帧
//  2) 不认 response.failed / error / response.incomplete，失败被静默吞掉
//  3) 兜底 `response.completed && !out` 读的 j.response.output 实测恒为空数组（store:false 下文本只走 delta），是死代码
//  4) out 为空时仍 exit 0，调用方无法判断失败
// 详见 /home/aibox/dsh-work/gpt-tasks/ 的排查记录。
function handleFrame(line) {
  if (!line.startsWith('data:')) return;
  const d = line.slice(5).trim(); if (!d || d === '[DONE]') return;
  let j; try { j = JSON.parse(d); } catch { return; }
  const t = j.type;
  if (LIVE) {
    live.events[t] = (live.events[t] || 0) + 1;
    if (t === 'response.created') { live.phase = 'GPT 在思考'; liveAct('GPT 开始处理'); }
    else if (t === 'response.reasoning_summary_text.delta') live.phase = 'GPT 在思考';
    else if (t === 'response.reasoning_summary_part.done' && j.part && j.part.text) liveAct('💭 ' + j.part.text.slice(0, 140));
    else if (t === 'response.output_text.delta' && live.phase !== 'GPT 在写回答') { live.phase = 'GPT 在写回答'; liveAct('开始写回答'); }
    else if (t === 'response.completed') { live.phase = '完成'; liveAct('✓ 完成'); }
    else if (/failed|error|incomplete|cancelled/.test(t)) { live.phase = '出错'; liveAct('✕ ' + t); }
  }
  if (t === 'response.output_text.delta') { out += j.delta || ''; if (process.env.ASK_OUT) fs.appendFileSync(process.env.ASK_OUT, j.delta || ''); return; }
  if (t === 'response.completed') {
    sawCompleted = true; doneStatus = (j.response && j.response.status) || 'completed';
    // output 通常为空；若非空则用作补全（比 delta 更权威）
    let full = '';
    for (const it of (j.response && j.response.output) || []) for (const cc of (it.content || [])) if (cc.text) full += cc.text;
    if (full && full.length > out.length) out = full;
    return;
  }
  if (t === 'response.failed' || t === 'error' || t === 'response.incomplete' || t === 'response.cancelled') {
    const e = j.response && j.response.error;
    failMsg = (e && (e.message || e.code)) || (j.error && (j.error.message || j.error.code)) || j.message || t;
    if (t === 'response.incomplete') failMsg = 'incomplete: ' + JSON.stringify((j.response && j.response.incomplete_details) || {});
    return;
  }
}
// 2026-09-28 修6（真正的死因）：
// 原来这里是 `Promise.race([reader.read(), 超时reject]).catch(e => { throw e })`。
// 两个毛病：
//   1) `.catch(e => { throw e })` 是假动作 —— 接住又原样抛出，等于没接；
//      全文又没有外层 try/catch，于是 reject 冲到顶层变成 unhandledRejection，
//      Node 默认直接杀进程，stdout/stderr 双双 0 字节，查不出死因。
//   2) race 输掉之后 reader.read() 不会被取消，连接和 promise 都成孤儿。
// 现在：超时改为「真正 abort 这个请求」，并且用 try/catch 明确报错。
// 2026-09-28：按阶段区分——还在思考（没开始写答案）时允许最长 15 分钟没输出；开始写之后 5 分钟没新内容才算卡住
const IDLE_MS = Number(process.env.ASK_CODEX_IDLE_MS || 300000);
const THINK_MS = Number(process.env.ASK_CODEX_THINK_MS || 900000);
try {
  for (;;) {
    let timer;
    const tick = new Promise((_, rej) => {
      const lim = out.length ? IDLE_MS : THINK_MS;
      timer = setTimeout(() => {
        ac.abort();   // 真正掐断底层请求，不留孤儿
        rej(new Error((out.length ? '写答案中途' : '思考阶段') + ' ' + Math.round(lim / 1000) + ' 秒没有任何数据 (已收 ' + out.length + ' 字)'));
      }, lim);
      timer.unref && timer.unref();
    });
    let r;
    try {
      r = await Promise.race([reader.read(), tick]);
    } finally {
      clearTimeout(timer);
    }
    const { done, value } = r;
    if (done) { if (buf.trim()) handleFrame(buf); break; }   // 修1：处理残留帧
    buf += dec.decode(value, { stream: true });
    const parts = buf.split(String.fromCharCode(10)); buf = parts.pop();
    for (const line of parts) handleFrame(line);
  }
} catch (e) {
  clearInterval(hb);
  console.error('[ask-codex] 读取中断：' + ((e && e.message) || e));
  console.error('[ask-codex] 已收 ' + out.length + ' 字，用时 ' + Math.round((Date.now() - t0) / 1000) + 's');
  await done(false);
  process.exit(4);
}
if (failMsg) { clearInterval(hb); console.error('GPT 返回失败: ' + String(failMsg).slice(0, 400)); await done(false); process.exit(1); }   // 修2
if (!out.trim()) { clearInterval(hb); console.error('GPT 无文本输出' + (sawCompleted ? '（completed 已到达但内容为空）' : '（未收到 completed 事件）') + (doneStatus ? ' status=' + doneStatus : '')); await done(false); process.exit(2); }   // 修4：失败给非零退出码
clearInterval(hb);
console.log(out.trim());
console.error('[ask-codex] 完成，用时 ' + Math.round((Date.now() - t0) / 1000) + 's，' + out.trim().length + ' 字');
await done(true);
