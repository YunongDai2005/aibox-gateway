#!/usr/bin/env node
/**
 * ask-claude：让 DSH 请 Claude Code 当外援（走主人的 Claude 订阅，额度和主人自己用的共用）。
 * 2026-09-28 Mac 端 Claude 写。令牌在 ~/.config/claude-code/oauth-token（ai 600，见 AI-BOX.md §1.3）。
 *
 * 用法：
 *   ask-claude "问题"                     顾问模式（默认）：只能读文件、搜网页，不能改、不能跑命令
 *   ask-claude --work "任务"              干活模式：能改文件、跑命令（必须主人明确同意才用）
 *   echo "长问题" | ask-claude -          从标准输入读问题
 * 选项：
 *   --model <模型>          默认 claude-opus-5-5（主人指定）；简单问题可用 sonnet 省额度
 *   --effort <档位>         默认 high；low/medium 更快更省
 *   --cwd 目录             Claude 的工作目录（默认 /home/aibox/dsh-work）
 *   --resume <会话ID>      接着上一次的对话追问（上次输出末尾有会话 ID）
 *   --max-minutes N        最长跑多久（默认 30）；超过 5 分钟的任务请用 bash 的 run_in_background
 * 退出码：0 成功 · 2 用法错 · 3 额度用完/被限流 · 4 其他失败 · 5 超时
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { extractResetText, parseResetAt } from './claude-reset.mjs';
import { record } from './helper-ledger.mjs';

const TOKEN_FILE = path.join(os.homedir(), '.config/claude-code/oauth-token');
const LOG_DIR = '/home/aibox/tmp/claude-runs';

// 面板额度状态文件（/usr/local/share/aibox-dashboard 读它）
const STATE_FILE = '/home/aibox/.aibox/claude-state.json';
// 合并旧状态 + 原子写：别把 lastOkAt/plan 这些字段冲掉，也别写出半个文件
function saveState(patch) {
  try {
    let old = {};
    try { old = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify({ ...old, ...patch }, null, 2));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch {}
}

const argv = process.argv.slice(2);
const opt = { work: false, model: 'claude-opus-5-5', effort: 'high', cwd: '/home/aibox/dsh-work', resume: null, maxMin: 30 };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--work') opt.work = true;
  else if (a === '--model') opt.model = argv[++i];
  else if (a === '--effort') opt.effort = argv[++i];
  else if (a === '--cwd') opt.cwd = argv[++i];
  else if (a === '--resume') opt.resume = argv[++i];
  else if (a === '--max-minutes') opt.maxMin = Number(argv[++i]) || 30;
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]); process.exit(0); }
  else rest.push(a);
}
let prompt = rest.join(' ').trim();
if (!prompt || prompt === '-') prompt = fs.readFileSync(0, 'utf8').trim();
if (!prompt) { console.error('用法：ask-claude [--work] [--model opus] "问题"（-h 看全部）'); process.exit(2); }

let token = '';
try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!token) { console.error('没有 Claude 令牌：' + TOKEN_FILE + '（找主人）'); process.exit(4); }

const preamble = opt.work
  ? '你是被另一个 AI 助手（DSH）请来帮忙的外援，在一台可以随便折腾的 Linux 机器上干活。用中文回答。做完后简短汇报：改了哪些文件、跑了什么、结果如何、还有什么没做。\n\n'
  : '你是被另一个 AI 助手（DSH）请来当顾问的外援，只能读文件和查资料，不能改东西。用中文回答，简短直接，给结论和理由；需要改的地方给出具体做法让 DSH 去改。\n\n';

// 2026-09-28：改用 stream-json —— 它每次请求都带 rate_limit_event（5 小时/每周已用比例 + 重置时间），
// 面板靠它显示 Claude 的 %，并记进外援账本估算"还能调几次"
const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', opt.model, '--effort', opt.effort];
if (opt.resume) args.push('--resume', opt.resume);
if (opt.work) args.push('--dangerously-skip-permissions');
else args.push('--allowedTools', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', '--disallowedTools', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit');

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
let lbuf = '';
function liveLine(line) {
  let e; try { e = JSON.parse(line); } catch { return; }
  live.events[e.type] = (live.events[e.type] || 0) + 1;
  if (e.type === 'system' && e.subtype === 'init') { live.phase = '已连上，开始思考'; liveAct('启动 ' + (e.model || '')); }
  else if (e.type === 'assistant') {
    for (const c of (e.message && e.message.content) || []) {
      if (c.type === 'tool_use') { const i = c.input || {}; live.phase = '在用工具 ' + c.name; liveAct('🔧 ' + c.name + ' ' + String(i.file_path || i.path || i.pattern || i.command || i.url || i.query || '').slice(0, 120)); }
      else if (c.type === 'text' && c.text && c.text.trim()) { live.phase = '在写回答'; live.chars += c.text.length; liveAct('💬 ' + c.text.slice(0, 120)); }
      else if (c.type === 'thinking') live.phase = '在思考';
    }
  } else if (e.type === 'user') live.phase = '看工具结果，想下一步';
  else if (e.type === 'result') { live.phase = e.is_error ? '出错结束' : '完成'; liveAct((e.is_error ? '✕ 结束：' : '✓ 结束，') + (e.num_turns || '?') + ' 轮'); }
  liveWrite(false);
}
liveWrite(true);
const t0 = Date.now();
const child = spawn('claude', args, { cwd: opt.cwd, env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] });
let out = '', err = '', timedOut = false;
// 2026-09-28 修：原来到点直接 SIGKILL —— Claude 干到一半被爆头，改过的文件回滚不了、
// 汇报也发不出来，连日志都不写（走不到那一步），事后完全查不出死因。
// 现在分三段：提前 5 分钟喊它收尾 → 到点先 SIGTERM → 再给 90 秒才 SIGKILL。
const hardMs = opt.maxMin * 60000;
let killTimer = null;
const warnTimer = setTimeout(() => {
  console.error('[ask-claude] 已用 ' + Math.round((Date.now() - t0) / 60000) + '/' + opt.maxMin +
    ' 分钟，还剩约 5 分钟 —— 请尽快收尾，把已完成的改动和结论先回复出来。');
}, Math.max(30000, hardMs - 5 * 60000));
const timer = setTimeout(() => {
  timedOut = true;
  console.error('[ask-claude] 到 ' + opt.maxMin + ' 分钟上限，先 SIGTERM 让它收尾（90 秒后才强杀）');
  try { child.kill('SIGTERM'); } catch {}
  killTimer = setTimeout(() => { console.error('[ask-claude] 收尾超时，SIGKILL'); try { child.kill('SIGKILL'); } catch {} }, 90000);
}, hardMs);
child.stdout.on('data', (d) => {
  out += d;
  if (LIVE) { lbuf += d; const ls = lbuf.split('\n'); lbuf = ls.pop(); for (const l of ls) liveLine(l); }
});
child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
child.stdin.end(preamble + prompt);
child.on('close', (code) => {
  clearTimeout(timer);
  clearTimeout(warnTimer);
  if (killTimer) clearTimeout(killTimer);
  const secs = Math.round((Date.now() - t0) / 1000);
  if (LIVE) { if (lbuf) liveLine(lbuf); if (timedOut) live.phase = '超时被停'; liveWrite(true);
    try { fs.writeFileSync(path.join(path.dirname(LIVE), 'stream.jsonl'), out, { mode: 0o600 }); } catch {} }  // 原始事件流留档，查 bug 用
  // stream-json：一行一个事件；最后的 type=result 就是以前 --output-format json 的那个对象
  let j = null;
  const rl = [];
  for (const line of out.split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'result') j = e;
    else if (e.type === 'rate_limit_event' && e.rate_limit_info) rl.push(e.rate_limit_info);
  }
  const snap = (info) => {
    const w = (info && info.unifiedWindows) || {};
    const one = (x) => (x && x.utilization != null ? { u: Math.round(x.utilization * 1000) / 10, r: x.resetsAt || null } : undefined);
    return info ? { '5h': one(w.five_hour), '7d': one(w.seven_day) } : null;
  };
  record({ t: t0, end: Date.now(), helper: 'claude', model: opt.model, effort: opt.effort, mode: opt.work ? 'work' : 'advise', secs, ok: !!(j && !j.is_error && code === 0), before: snap(rl[0]), after: snap(rl[rl.length - 1]) });
  // 官方直接说被拒了（status=rejected；allowed_warning 只是接近上限）→ 用它给的精确重置时间记限流，不用再从报错文字里猜
  const rej = rl.slice().reverse().find((x) => x.status === 'rejected');
  if (rej) saveState({ limited: true, resetsAt: rej.resetsAt ? new Date(rej.resetsAt * 1000).toISOString() : null, resetText: null, detectedAt: new Date().toISOString(), limitType: rej.rateLimitType || null });
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, new Date().toISOString().replace(/[:.]/g, '-') + (opt.work ? '-work' : '') + '.json'),
      JSON.stringify({ mode: opt.work ? 'work' : 'advise', model: opt.model, cwd: opt.cwd, prompt: prompt.slice(0, 4000), secs, code, result: j, stderr: err }, null, 2), { mode: 0o600 });
  } catch {}
  if (timedOut) {
    // 2026-09-28：超时也要把已有内容吐出来 —— 干了一半的结论比「0 字节」有用得多。
    const partial = ((j && (j.result || '')) || '').trim();
    if (partial) console.log(partial);
    else if (out.trim()) console.log('[ask-claude] 超时，以下是未完成的原始事件流尾部：\n' + out.trim().slice(-4000));
    console.error('⏱ Claude 超过 ' + opt.maxMin + ' 分钟被停下（' + (j && j.session_id ? '会话 ' + j.session_id + '，可 --resume 追问' : '无 result 事件') + '）');
    process.exit(5);
  }
  const text = (j && (j.result || '')) || '';
  const errText = text + ' ' + err;
  if (!j || j.is_error || code !== 0) {
    // 注意：overloaded 不算限流（服务繁忙而已），故不在正则里
    if (/usage limit|session limit|rate.?limit|quota|429|limit reached|resets? at|weekly limit|hit your/i.test(errText)) {
      // 记录限流状态给面板（/usr/local/share/aibox-dashboard）
      const now = Date.now();
      const resetText = extractResetText(errText);
      saveState({
        limited: true,
        resetText,
        resetsAt: parseResetAt(resetText || errText, now),
        detectedAt: new Date(now).toISOString(),
      });
      console.error('⛔ Claude 额度用完或被限流，别再调了，自己干或改用 codex。详情：' + errText.replace(/\s+/g, ' ').slice(0, 300));
      process.exit(3);
    }
    console.error('✕ Claude 调用失败（exit=' + code + '）：' + errText.replace(/\s+/g, ' ').slice(0, 400));
    process.exit(4);
  }
  // 成功 → 清除限流状态（原来缺的就是这一半：成功了不清，面板就永远显示没额度）
  saveState({ limited: false, resetsAt: null, resetText: null, lastOkAt: new Date().toISOString() });
  const model = Object.keys(j.modelUsage || {}).join(',') || opt.model;
  console.log(text.trim());
  console.log('\n[Claude 外援 · ' + (opt.work ? '干活模式' : '顾问模式') + ' · ' + model + ' ' + opt.effort + ' · 用时 ' + secs + ' 秒 · 会话 ' + j.session_id + '（追问用 --resume）]');
});
