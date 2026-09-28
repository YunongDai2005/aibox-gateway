#!/usr/bin/env node
/**
 * helper：外援任务管理器（GPT / Claude / Go 顾问）。2026-09-28 Mac 端 Claude 写，同日第二版：三个顾问都能带工具干活 + WorkTree + 按额度自动选。
 *
 * 为什么要它：外援独立运行（systemd scope），DSH 这一轮结束、路由重启都不会把它带走；运行中写实时动态，随时能查。
 *
 * 三个顾问（都能自己读文件；--work 时能改文件、跑命令）：
 *   claude  你的 Claude 订阅（和主人共用）   Claude Code，默认 Opus 5.5 · high
 *   gpt     你的 ChatGPT Plus               官方 Codex 命令行，默认 gpt-6-sol
 *   go      OpenCode Go 包月                DSH 换成 Go 里的强模型跑，默认 kimi-k3（⚠️ 按 4 倍扣 Go 额度）
 *           另有「快问」模式 --chat：只聊天不读文件，默认 gpt-6-luna，10 秒左右、最省
 *
 * 用法（DSH 里一律这样调，别自己包 timeout / nohup / run_in_background）：
 *   helper start auto   --title "短标题" --file 问题.md [--work --repo <git 仓库目录>] [--hard|--quick]
 *        ← 推荐：看三家额度 + 任务难度，自动选顾问和模型（经理的快模型判断，硬规则兜底），会打印选择理由
 *   helper start claude|gpt|go [--model M] [--effort E] [--work] [--repo 目录] [--chat] --title "短标题" (--file 问题.md | "问题")
 *   helper wait <编号> [--max 240]   最多等 N 秒（默认 240，上限 540）；0=做完并输出结果 · 10=还在跑（先报进度再 wait）· 1=失败
 *   helper status [编号] / helper result <编号> / helper kill <编号>
 *
 * WorkTree（--work --repo 时）：从仓库当前状态开一个独立工作副本 + 分支 helper/<编号>，外援只改副本，不碰正在跑的文件。
 *   做完自动提交到那个分支，然后：
 *   helper diff <编号>      看它改了什么（先看再决定！）
 *   helper merge <编号>     合并回主目录（= 改动生效；路由代码还要按 AGENTS.md「自主重启 wx-router」重启才生效）
 *   helper discard <编号>   整个丢掉
 *   现在纳入 git 的仓库：/home/aibox/wx-router、/home/aibox/bin
 *
 * 任务目录 /home/aibox/.aibox/helper-jobs/<编号>/（meta.json · live.json 实时动态 · prompt.txt · out.txt · err.txt · stream.jsonl），保留 30 天。
 * 总日志 /home/aibox/.aibox/logs/helpers.log（START/DONE/FAILED/KILL/NOTIFY/AUTO/MERGE…）。测试时设 HELPER_NO_NOTIFY=1 不发微信。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { record } from '/home/aibox/bin/helper-ledger.mjs';

const ROOT = '/home/aibox/.aibox/helper-jobs';
const WT_ROOT = '/home/aibox/.aibox/worktrees';
const LOG = '/home/aibox/.aibox/logs/helpers.log';
const KEEP_DAYS = 30;
const NAME = { gpt: 'GPT', claude: 'Claude', go: 'Go 顾问' };
const DEFAULT_MODEL = { gpt: 'gpt-6-sol', claude: 'claude-opus-5-5', go: 'kimi-k3' };
// Go 里能让 DSH 带工具驱动的模型（openai-completions 协议）；gpt-6-luna / grok 只认 /responses，只能 --chat 快问
const GO_TOOL_MODELS = { 'kimi-k3': 256000, 'deepseek-v4-pro': 1000000, 'glm-5.3': 200000, 'deepseek-v4.1-flash': 1000000, 'minimax-m3': 200000, 'qwen3.7-plus': 256000 };

const rj = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const wj = (p, o) => { fs.writeFileSync(p + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(p + '.tmp', p); };
const dir = (id) => path.join(ROOT, id);
const meta = (id) => rj(path.join(dir(id), 'meta.json'));
const setMeta = (id, patch) => wj(path.join(dir(id), 'meta.json'), { ...meta(id), ...patch });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'; };
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
function log(msg) { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch {} }
const who = (m) => NAME[m.helper] + '·' + (m.model || DEFAULT_MODEL[m.helper]) + (m.work ? '（干活）' : m.chat ? '（快问）' : '（顾问）');

// ---------- git / WorkTree ----------
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
function gitRoot(p) { const r = git(p, 'rev-parse', '--show-toplevel'); return r.status === 0 ? r.stdout.trim() : null; }
function commitAll(repo, msg, author) {
  git(repo, 'add', '-A');
  if (git(repo, 'diff', '--cached', '--quiet').status === 0) return false;
  const r = git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg, '--author', author);
  return r.status === 0;
}
const MAIN_AUTHOR = 'AI Box 自动快照 <aibox@example.invalid>';
const HELPER_AUTHOR = (m) => NAME[m.helper] + '-helper <' + m.helper + '-helper@example.invalid>';

// ---------- 额度（给自动选择用）----------
function quotaView() {
  const q = rj('/home/aibox/.aibox/quota.json', {}) || {};
  const left = (ws) => { const v = Object.values(ws || {}).filter((w) => w && w.usedPercent != null).map((w) => 100 - w.usedPercent); return v.length ? Math.min(...v) : null; };
  const soonest = (ws) => { const t = Object.values(ws || {}).filter((w) => w && w.resetsAt).map((w) => Date.parse(w.resetsAt)); return t.length ? new Date(Math.min(...t)).toISOString() : null; };
  const win = (ws) => Object.entries(ws || {}).filter(([, w]) => w).map(([k, w]) => k + '剩' + (w.usedPercent == null ? '?' : Math.round(100 - w.usedPercent) + '%') + (w.resetsAt ? '(' + new Date(w.resetsAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '重置)' : '')).join(' ');
  return {
    updatedAt: q.updatedAt,
    claude: q.claude && q.claude.ok ? { left: left(q.claude.windows), limited: q.claude.available === false, text: win(q.claude.windows) || '（没有读数）', calls: q.claude.advisor && q.claude.advisor.calls } : null,
    gpt: q.chatgpt && q.chatgpt.ok ? { left: left(q.chatgpt.windows), limited: !!q.chatgpt.limitReached, text: win(q.chatgpt.windows), calls: q.chatgpt.advisor && q.chatgpt.advisor.calls, soonest: soonest(q.chatgpt.windows) } : null,
    go: q.go && q.go.ok ? { left: left(q.go.windows), limited: !!q.goCooldownUntil, text: win(q.go.windows), pace: q.go.pace } : null,
  };
}
async function managerPick(task, opts, cands, qv) {
  // 用经理的快模型判断（Go · deepseek-v4.1-flash，关思考，约 3 秒）；失败就按硬规则
  let key = ''; try { const s = fs.readFileSync('/home/aibox/.dsh/.credentials.yaml', 'utf8'); key = (s.match(/^\s*OPENCODE_GO_API_KEY:\s*(\S+)/m) || [])[1] || ''; key = key.replace(/^["']|["']$/g, ''); } catch {}
  const sys = `你是经理，负责给一个外援任务挑顾问。只输出 JSON：{"pick": 候选编号(数字), "effort": "low|medium|high", "reason": "一句话理由（中文）"}。
挑选原则（按重要性）：
1. 能不能干：要改文件/跑命令（干活）三家都行；只是快速核对、简单问题 → 优先最省的。
2. 难度：难、关键、要写/审大段代码 → 选强的（Claude Opus、GPT-6、Kimi K3）；一般问题中等即可。
3. 额度：谁剩得多用谁；某家快重置但还剩很多 → 优先用它（不用就浪费了）；某家剩不到 25% → 尽量别用。
4. Claude 和主人自己共用，主人常用：Claude 5 小时剩不到 40% 时让给别家。
5. Go 的强模型按 4 倍扣 Go 月额度；Go 月额度节奏偏低时可以多用。`;
  const user = '【任务】' + cut(task, 1200) + '\n【模式】' + (opts.work ? '干活（要改文件' + (opts.repo ? '，在 WorkTree 里' : '') + '）' : '顾问（只读）') + (opts.hard ? '；主人/DSH 标了：难' : '') + (opts.quick ? '；标了：快速小问题' : '') +
    '\n【额度】Claude：' + (qv.claude ? qv.claude.text : '未知') + '\nGPT（ChatGPT Plus）：' + (qv.gpt ? qv.gpt.text : '未知') + '\nGo 包月：' + (qv.go ? qv.go.text + (qv.go.pace ? '；本月第' + qv.go.pace.day + '天，按节奏应用' + qv.go.pace.expected + '%、实际' + qv.go.pace.used + '%' : '') : '未知') +
    '\n【候选】\n' + cands.map((c, i) => i + '. ' + c.label + '：' + c.note).join('\n');
  if (!key) return null;
  try {
    const r = await fetch('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(20000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key, 'x-opencode-session': 'ses_aibox_pick' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 300, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }) });
    const j = await r.json(); const o = JSON.parse(j.choices[0].message.content);
    const c = cands[Number(o.pick)];
    return c ? { ...c, effort: ['low', 'medium', 'high'].includes(o.effort) ? o.effort : c.effort, reason: String(o.reason || '').slice(0, 160), by: '经理' } : null;
  } catch (e) { log('AUTO 经理判断失败 ' + e.message); return null; }
}
async function choose(task, opts) {
  const qv = quotaView();
  const cands = [];
  const ok = (v) => v && !v.limited && (v.left == null || v.left >= 10);   // 硬规则：限流或剩不到 10% 的不参与
  if (ok(qv.claude)) cands.push({ helper: 'claude', model: opts.quick ? 'sonnet' : 'claude-opus-5-5', effort: opts.quick ? 'medium' : 'high', left: qv.claude.left ?? 50,
    label: 'Claude ' + (opts.quick ? 'Sonnet' : 'Opus 5.5'), note: '最强之一，能读文件/改代码；和主人共用额度（' + qv.claude.text + '）' });
  if (ok(qv.gpt)) cands.push({ helper: 'gpt', model: opts.quick ? 'gpt-5.6-sol' : 'gpt-6-sol', effort: opts.quick ? 'low' : 'high', left: qv.gpt.left ?? 50,
    label: 'GPT ' + (opts.quick ? '5.6-Sol' : '6-Sol'), note: '最强之一，能读文件/改代码；ChatGPT Plus（' + qv.gpt.text + '）' });
  if (ok(qv.go)) {
    cands.push({ helper: 'go', model: 'kimi-k3', effort: 'high', left: qv.go.left ?? 50, label: 'Go·Kimi K3', note: '强，能读文件/改代码（DSH 工具）；Go 包月按 4 倍扣（' + qv.go.text + '）' });
    cands.push({ helper: 'go', model: 'deepseek-v4-pro', effort: 'high', left: qv.go.left ?? 50, label: 'Go·DeepSeek V4 Pro', note: '中上，能读文件/改代码；Go 包月按 4 倍扣' });
    if (!opts.work) cands.push({ helper: 'go', model: 'gpt-6-luna', chat: true, effort: 'medium', left: qv.go.left ?? 50, label: 'Go·GPT-6 Luna 快问', note: '10 秒左右、最省，但读不了文件（只适合把内容贴进问题的小问题）' });
  }
  if (!cands.length) throw new Error('三家额度都快用完或被限流了：' + JSON.stringify({ claude: qv.claude && qv.claude.text, gpt: qv.gpt && qv.gpt.text, go: qv.go && qv.go.text }));
  let pick = await managerPick(task, opts, cands, qv);
  if (!pick) {   // 兜底：剩得最多的；快问优先最省的
    const pool = opts.quick ? cands.filter((c) => c.chat).concat(cands) : cands.filter((c) => !c.chat);
    pick = { ...pool.slice().sort((a, b) => b.left - a.left)[0], reason: '经理没回，按剩余额度最多的选', by: '硬规则' };
  }
  return pick;
}

// ---------- 状态 / 展示 ----------
function refresh(id) {
  const m = meta(id);
  if (m && m.status === 'running' && m.runnerPid && !alive(m.runnerPid)) {
    setMeta(id, { status: 'failed', endedAt: new Date().toISOString(), error: '外援进程意外消失（可能机器重启或被杀）' });
    log(id + ' FAILED 进程意外消失 runnerPid=' + m.runnerPid);
    return meta(id);
  }
  return m;
}
function line(m) {
  if (!m) return '（没有这个任务）';
  const live = rj(path.join(dir(m.id), 'live.json'), {}) || {};
  const t0 = Date.parse(m.startedAt), t1 = m.endedAt ? Date.parse(m.endedAt) : Date.now();
  const st = { running: '运行中', done: '✓ 完成', failed: '✕ 失败', killed: '已停止' }[m.status] || m.status;
  let s = m.id + ' · ' + who(m) + ' · ' + st + ' · ' + dur(t1 - t0) + ' · ' + cut(m.title, 40);
  if (m.status === 'running') {
    const last = (live.activity || []).slice(-1)[0];
    s += '\n   现在：' + (live.phase || '启动中') + (live.chars ? '，已写 ' + live.chars + ' 字' : '') +
      (last ? '\n   最近动作：' + last.x + '（' + dur(Date.now() - last.t) + '前）' : '') + (live.updatedAt ? '' : '\n   （还没收到外援的任何动静）');
  } else if (m.status === 'failed') s += '\n   原因：' + cut(m.error || '', 200);
  if (m.branch) s += '\n   WorkTree：' + m.branch + (m.merged ? '（已合并）' : m.discarded ? '（已丢弃）' : m.changed ? '（有改动：' + cut(m.diffstat, 120) + '）→ helper diff / merge / discard ' + m.id : m.status === 'running' ? '' : '（没有改动）');
  if (m.auto) s += '\n   自动选择理由（' + m.auto.by + '）：' + cut(m.auto.reason, 120);
  return s;
}
function result(m) { try { return fs.readFileSync(path.join(dir(m.id), 'out.txt'), 'utf8').trim() || '（没有输出）'; } catch { return '（没有输出）'; } }
function cleanup() {
  try {
    for (const id of fs.readdirSync(ROOT)) {
      const m = rj(path.join(dir(id), 'meta.json'));
      if (m && m.status !== 'running' && Date.parse(m.endedAt || m.startedAt) < Date.now() - KEEP_DAYS * 86400e3) {
        if (m.wt && fs.existsSync(m.wt) && m.repo) { git(m.repo, 'worktree', 'remove', '--force', m.wt); git(m.repo, 'branch', '-D', m.branch); }
        fs.rmSync(dir(id), { recursive: true, force: true });
      }
    }
  } catch {}
}
function findDsh() {
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    try {
      const cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' ');
      if (/\bdsh\b.*--profile/.test(cmd)) return pid;
      pid = Number(fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[1]);
    } catch { return null; }
  }
  return null;
}

// ---------- 命令 ----------
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'start') {
  let helper = args.shift();
  if (!['claude', 'gpt', 'go', 'auto'].includes(helper)) { console.error('用法：helper start auto|claude|gpt|go [选项] --title "短标题" (--file 问题.md | "问题")'); process.exit(2); }
  const o = { title: '', file: null, work: false, repo: null, model: null, effort: null, cwd: process.cwd(), resume: null, maxMin: null, chat: false, hard: false, quick: false };
  const text = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--title') o.title = args[++i]; else if (a === '--file') o.file = args[++i];
    else if (a === '--work') o.work = true; else if (a === '--chat') o.chat = true; else if (a === '--hard') o.hard = true; else if (a === '--quick') o.quick = true;
    else if (a === '--repo') o.repo = args[++i]; else if (a === '--model') o.model = args[++i]; else if (a === '--effort') o.effort = args[++i];
    else if (a === '--cwd') o.cwd = args[++i]; else if (a === '--resume') o.resume = args[++i]; else if (a === '--max-minutes') o.maxMin = Number(args[++i]) || null;
    else text.push(a);
  }
  let prompt = o.file ? fs.readFileSync(o.file, 'utf8') : text.join(' ');
  if (!prompt.trim() || prompt.trim() === '-') prompt = fs.readFileSync(0, 'utf8');
  if (!prompt.trim()) { console.error('没有问题内容：用 --file 或直接写在后面'); process.exit(2); }
  fs.mkdirSync(ROOT, { recursive: true }); cleanup();
  let auto = null;
  if (helper === 'auto') {
    try { auto = await choose(prompt, o); } catch (e) { console.error('自动选择失败：' + e.message); process.exit(3); }
    helper = auto.helper; o.model = o.model || auto.model; o.effort = o.effort || auto.effort; if (auto.chat) o.chat = true;
    log('AUTO pick=' + helper + ':' + o.model + ' by=' + auto.by + ' reason=' + JSON.stringify(auto.reason));
  }
  const model = o.model || (helper === 'go' && o.chat ? 'gpt-6-luna' : DEFAULT_MODEL[helper]);
  if (helper === 'go' && !o.chat && !GO_TOOL_MODELS[model]) o.chat = true;          // 只认 /responses 的模型只能快问
  if (o.chat && o.work) { console.error('快问模式（--chat）读不了也改不了文件，不能 --work'); process.exit(2); }
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const id = ({ gpt: 'g', claude: 'c', go: 'o' }[helper]) + '-' + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '-' + Math.random().toString(16).slice(2, 4);
  fs.mkdirSync(dir(id));
  fs.writeFileSync(path.join(dir(id), 'prompt.txt'), prompt, { mode: 0o600 });
  let cwd = path.resolve(o.cwd), wt = null, branch = null, repo = null;
  if (o.work && o.repo) {
    repo = gitRoot(path.resolve(o.repo));
    if (!repo) { console.error('--repo 不是 git 仓库：' + o.repo + '（现在纳入 git 的：/home/aibox/wx-router、/home/aibox/bin）'); fs.rmSync(dir(id), { recursive: true }); process.exit(2); }
    commitAll(repo, '自动快照：外援 ' + id + ' 开工前', MAIN_AUTHOR);                 // 让工作副本从"现在的真实状态"开始
    branch = 'helper/' + id; wt = path.join(WT_ROOT, id);
    fs.mkdirSync(WT_ROOT, { recursive: true });
    const r = git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'HEAD');
    if (r.status !== 0) { console.error('开 WorkTree 失败：' + r.stderr); fs.rmSync(dir(id), { recursive: true }); process.exit(4); }
    cwd = path.join(wt, path.relative(repo, path.resolve(o.repo)));
  }
  wj(path.join(dir(id), 'meta.json'), { id, helper, model, effort: o.effort, work: o.work, chat: o.chat, title: o.title || cut(prompt, 30), startedAt: d.toISOString(), status: 'running',
    dshPid: findDsh(), cwd, repo, wt, branch, resume: o.resume, maxMin: o.maxMin || (o.work ? 40 : 25), auto });
  const script = new URL(import.meta.url).pathname;
  const tryScope = () => new Promise((resolve) => {
    let r; try { r = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit=helper-' + id, process.execPath, script, '_run', id], { detached: true, stdio: 'ignore', cwd }); } catch { return resolve(null); }
    let settled = false;
    r.on('error', () => { if (!settled) { settled = true; resolve(null); } });
    r.on('exit', (code) => { if (!settled) { settled = true; resolve(code === 0 && meta(id).status !== 'running' ? r : null); } });
    setTimeout(() => { if (!settled) { settled = true; r.unref(); resolve(r); } }, 1500);
  });
  let runner = await tryScope(), how = 'scope';
  if (!runner) { runner = spawn(process.execPath, [script, '_run', id], { detached: true, stdio: 'ignore', cwd }); runner.unref(); how = 'detached'; }
  setMeta(id, { runnerPid: runner.pid, launch: how });
  log(id + ' START ' + helper + ':' + model + ' launch=' + how + (o.work ? ' work' : o.chat ? ' chat' : ' advise') + (branch ? ' wt=' + branch : '') + ' dshPid=' + (meta(id).dshPid || '-') + ' promptChars=' + prompt.length + ' title=' + cut(o.title || prompt, 60));
  const m = meta(id);
  if (auto) console.log('🤖 自动选择：' + who(m) + '（' + auto.by + '：' + auto.reason + '）');
  console.log('已启动外援任务 ' + id + ' · ' + who(m) + '：' + m.title);
  if (branch) console.log('在 WorkTree 里干活：' + wt + '（分支 ' + branch + '），不碰正在跑的文件。做完用 helper diff ' + id + ' 看改动，再 merge 或 discard。');
  else if (o.work) console.log('⚠️ 没给 --repo：直接在 ' + cwd + ' 里改，没有 WorkTree 保护。');
  console.log('它在后台跑，你这一轮结束也不会被杀。查看：helper wait ' + id + ' --max 240 · helper status ' + id);
  process.exit(0);
}

if (cmd === '_run') {
  const id = args[0], m = meta(id), D = dir(id);
  const LIVE = path.join(D, 'live.json');
  const live = { phase: '启动中', activity: [], chars: 0 };
  let lastW = 0;
  const liveWrite = (f) => { if (!f && Date.now() - lastW < 1500) return; lastW = Date.now(); live.updatedAt = new Date().toISOString(); try { fs.writeFileSync(LIVE + '.tmp', JSON.stringify(live)); fs.renameSync(LIVE + '.tmp', LIVE); } catch {} };
  const act = (x) => { live.activity.push({ t: Date.now(), x: cut(x, 160) }); if (live.activity.length > 60) live.activity.shift(); liveWrite(false); };
  const env = { ...process.env, HELPER_LIVE: LIVE };
  let bin, argv = [], mode = 'raw';   // raw = 子进程 stdout 就是结果；codex/dsh = 解析事件流
  const prompt = fs.readFileSync(path.join(D, 'prompt.txt'), 'utf8');
  if (m.helper === 'claude') {
    bin = process.execPath; argv = ['/home/aibox/bin/ask-claude.mjs', ...(m.work ? ['--work'] : []), '--model', m.model, ...(m.effort ? ['--effort', m.effort] : []), '--cwd', m.cwd, ...(m.resume ? ['--resume', m.resume] : []), '--max-minutes', String(m.maxMin), '-'];
  } else if (m.helper === 'gpt' && !m.chat && fs.existsSync('/usr/local/bin/codex')) {
    bin = 'codex'; mode = 'codex';
    argv = ['exec', '-m', m.model, '--sandbox', m.work ? 'workspace-write' : 'read-only', '--skip-git-repo-check', '-C', m.cwd, '--json', ...(m.effort ? ['-c', 'model_reasoning_effort=' + m.effort] : []), '-'];
  } else if (m.helper === 'gpt') {
    bin = process.execPath; argv = ['/home/aibox/bin/ask-codex.mjs', m.model, ...(m.effort ? ['--effort', m.effort] : []), '--stdin'];
  } else if (m.helper === 'go' && !m.chat) {
    const patch = path.join(D, 'go-model.yml');
    fs.writeFileSync(patch, ['# 外援 ' + id + '：这一次 DSH 用 Go 的 ' + m.model + ' 跑', '- id: llm-pi-ai', '  config:', '    providers:', '      opencode-go:', '        displayName: OpenCode Go', '        apiKeyEnv: OPENCODE_GO_API_KEY',
      '        api: openai-completions', '        baseURL: https://opencode.ai/zen/go/v1', '        headers:', '          x-opencode-session: ses_aibox_goadvisor', '        models:', '          - id: ' + m.model, '            name: ' + m.model + ' (Go)',
      '            contextWindow: ' + (GO_TOOL_MODELS[m.model] || 128000), '            input: [text]', '- id: agent-default-model', '  config:', '    provider: opencode-go', '    model: ' + m.model, ''].join('\n'));
    bin = '/usr/local/bin/dsh'; mode = 'dsh'; argv = ['--profile', 'headless', '--patch', patch, '--json', '-'];
    env.DSH_PERMISSION_MODE = m.work ? 'workspace-write' : 'read-only'; env.OPENCODE_SESSION = 'ses_aibox_goadvisor';
  } else {
    bin = process.execPath; argv = ['/home/aibox/bin/ask-go.mjs', m.model, ...(m.effort ? ['--effort', m.effort] : []), '--stdin'];
  }
  // 额度账本：codex / dsh 模式自己记（raw 模式的脚本自己会记）
  const usage = async () => {
    try {
      if (m.helper === 'go') { const s = fs.readFileSync('/home/aibox/.dsh/.credentials.yaml', 'utf8'); const k = ((s.match(/^\s*OPENCODE_GO_API_KEY:\s*(\S+)/m) || [])[1] || '').replace(/^["']|["']$/g, '');
        const u = (await (await fetch('https://opencode.ai/zen/go/v1/usage', { headers: { authorization: 'Bearer ' + k }, signal: AbortSignal.timeout(6000) })).json()).usage || {};
        const w = (x) => (x && x.percent != null ? { u: x.percent, r: x.resetsAt || null } : undefined); return { '5h': w(u.rolling), '7d': w(u.weekly), '30d': w(u.monthly) }; }
      if (m.helper === 'gpt') { const a = JSON.parse(fs.readFileSync('/home/aibox/.codex/auth.json', 'utf8')); const t = a.tokens || {};
        const rl = ((await (await fetch('https://chatgpt.com/backend-api/wham/usage', { headers: { ['Authoriz' + 'ation']: 'Bea' + 'rer ' + t.access_token, 'chatgpt-account-id': t.account_id || '', originator: 'pi', version: '0.158.0' }, signal: AbortSignal.timeout(6000) })).json()).rate_limit) || {};
        const w = (x) => (x && x.used_percent != null ? { u: x.used_percent, r: x.reset_at || null } : undefined); return { '5h': w(rl.primary_window), '7d': w(rl.secondary_window) }; }
    } catch {}
    return null;
  };
  const before = mode === 'raw' ? null : await usage();
  const out = fs.openSync(path.join(D, 'out.txt'), 'w', 0o600), err = fs.openSync(path.join(D, 'err.txt'), 'w', 0o600);
  const stream = mode === 'raw' ? null : fs.openSync(path.join(D, 'stream.jsonl'), 'w', 0o600);
  const child = spawn(bin, argv, { cwd: m.cwd, env, stdio: ['pipe', mode === 'raw' ? out : 'pipe', err], detached: false });
  child.stdin.end(prompt);
  setMeta(id, { childPid: child.pid });
  live.phase = '已交给 ' + who(m); act('开工：' + who(m) + (m.branch ? '，在 WorkTree ' + m.branch : '')); liveWrite(true);
  let final = '', buf = '';
  const onLine = (l) => {
    if (!l.trim()) return; fs.writeSync(stream, l + '\n');
    let j; try { j = JSON.parse(l); } catch { return; }
    if (mode === 'codex') {
      const it = j.item || {};
      if (it.type === 'agent_message' && j.type === 'item.completed') { final = it.text || final; live.phase = '在说明/回答'; act('💬 ' + it.text); }
      else if (it.type === 'command_execution' && j.type === 'item.started') { live.phase = '在跑命令'; act('🔧 ' + it.command); }
      else if (it.type === 'file_change' && j.type === 'item.completed') { live.phase = '在改文件'; act('✏️ ' + JSON.stringify(it.changes || it).slice(0, 140)); }
      else if (it.type === 'reasoning' && it.text) { live.phase = '在思考'; act('💭 ' + it.text); }
      else if (j.type === 'turn.failed' || j.type === 'error') act('✕ ' + JSON.stringify(j.error || j).slice(0, 140));
    } else if (mode === 'dsh') {
      if (j.type === 'text' && j.text) { live.phase = '在说明'; act('💬 ' + j.text); }
      else if (j.type === 'tool_call') { live.phase = '在用工具 ' + j.tool; const i = j.input || {}; act('🔧 ' + j.tool + ' ' + String(i.description || i.command || i.file_path || i.path || '').slice(0, 120)); }
      else if (j.type === 'final') final = j.text || final;
    }
    live.chars = final.length; liveWrite(false);
  };
  if (mode !== 'raw') child.stdout.on('data', (dd) => { buf += dd; const ls = buf.split('\n'); buf = ls.pop(); ls.forEach(onLine); });
  const killAt = setTimeout(() => { act('⏱ 超过 ' + m.maxMin + ' 分钟上限，停下'); try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} } setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 60000); }, m.maxMin * 60000);
  child.on('error', (e) => { setMeta(id, { status: 'failed', endedAt: new Date().toISOString(), error: '启动外援失败：' + e.message }); log(id + ' FAILED spawn ' + e.message); process.exit(1); });
  child.on('close', async (code, signal) => {
    clearTimeout(killAt);
    if (buf) onLine(buf);
    if (mode !== 'raw') { fs.writeSync(out, (final || '').trim() + (final ? '\n\n[' + who(m) + ']' : '')); }
    const cur = meta(id);
    if (cur.status === 'killed') process.exit(0);
    let errTail = ''; try { errTail = fs.readFileSync(path.join(D, 'err.txt'), 'utf8').split('\n').filter((l) => l && !/仍在等待|^\[ask-(codex|go)\]/.test(l)).slice(-3).join(' '); } catch {}
    const ok = code === 0 && (mode === 'raw' || !!final.trim());
    if (mode !== 'raw') record({ t: Date.parse(m.startedAt), end: Date.now(), helper: m.helper, model: m.model, effort: m.effort || 'default', mode: m.work ? 'work' : 'advise', secs: Math.round((Date.now() - Date.parse(m.startedAt)) / 1000), ok, before, after: await usage() });
    const patch = { status: ok ? 'done' : 'failed', endedAt: new Date().toISOString(), exitCode: code, signal: signal || null,
      error: ok ? null : ((code === 3 ? '额度用完或被限流 ' : code === 5 ? '外援超过自己的时间上限 ' : '') + cut(errTail, 300) || '没有产出') };
    if (m.wt) {   // 外援的改动提交到它自己的分支
      const changed = commitAll(m.wt, '外援 ' + id + '（' + who(m) + '）：' + m.title, HELPER_AUTHOR(m));
      patch.changed = changed;
      patch.diffstat = changed ? (git(m.repo, 'diff', '--shortstat', 'HEAD...' + m.branch).stdout || '').trim() + ' | ' + (git(m.repo, 'diff', '--name-only', 'HEAD...' + m.branch).stdout || '').trim().split('\n').join(', ') : '';
      if (!changed) { git(m.repo, 'worktree', 'remove', '--force', m.wt); git(m.repo, 'branch', '-D', m.branch); }
    }
    live.phase = ok ? '完成' : '失败'; liveWrite(true);
    setMeta(id, patch);
    const fin = meta(id);
    log(id + (ok ? ' DONE' : ' FAILED') + ' exit=' + code + (signal ? ' signal=' + signal : '') + ' secs=' + Math.round((Date.parse(fin.endedAt) - Date.parse(fin.startedAt)) / 1000) +
      ' outBytes=' + fs.statSync(path.join(D, 'out.txt')).size + (fin.branch ? ' changed=' + !!fin.changed + (fin.diffstat ? ' diff=' + JSON.stringify(cut(fin.diffstat, 120)) : '') : '') + (ok ? '' : ' err=' + cut(fin.error, 200)) + ' dshAlive=' + !!(fin.dshPid && alive(fin.dshPid)));
    if (!(fin.dshPid && alive(fin.dshPid)) && !process.env.HELPER_NO_NOTIFY) {
      const secs = Date.parse(fin.endedAt) - Date.parse(fin.startedAt);
      const msg = (ok ? '🤝 ' + who(fin) + ' 做完了' : '⚠️ ' + who(fin) + ' 失败了') + '（' + dur(secs) + '）：' + cut(fin.title, 40) +
        (fin.changed ? '\n它在 WorkTree 里改了：' + cut(fin.diffstat, 100) + '（还没合并）' : '') +
        (ok ? '\n给 DSH 发任意一句话（比如「看外援结果」），它会接着处理。' : '\n原因：' + cut(fin.error, 120));
      try { execFileSync('/usr/bin/node', ['/home/aibox/bin/wx-notify.mjs', msg], { timeout: 30000, stdio: 'ignore' }); setMeta(id, { notified: true }); log(id + ' NOTIFY 已发微信'); } catch (e) { log(id + ' NOTIFY 失败 ' + e.message); }
    }
    process.exit(0);
  });
} else if (cmd === 'wait') {
  const id = args[0]; let max = 240;
  const mi = args.indexOf('--max'); if (mi >= 0) max = Math.min(540, Math.max(5, Number(args[mi + 1]) || 240));
  if (!meta(id)) { console.error('没有这个任务：' + id); process.exit(2); }
  const t0 = Date.now(); let lastPrint = 0;
  for (;;) {
    const m = refresh(id);
    if (m.status !== 'running') {
      console.log(line(m));
      if (m.status === 'done') { console.log('\n===== 结果 =====\n' + result(m)); setMeta(id, { delivered: true }); process.exit(0); }
      const partial = result(m); if (partial !== '（没有输出）') console.log('\n===== 已有的部分输出 =====\n' + partial.slice(-3000));
      setMeta(id, { delivered: true }); process.exit(1);
    }
    if (Date.now() - lastPrint >= 30000) { console.log('[' + dur(Date.now() - t0) + '] ' + line(m).replace(/\n\s*/g, ' | ')); lastPrint = Date.now(); }
    if (Date.now() - t0 >= max * 1000) { log(id + ' WAIT 等了 ' + max + 's 还在跑'); console.log('\n还在跑（已等 ' + max + ' 秒）。先给主人说一句进度，再 helper wait ' + id + ' 接着等；它不会因为你这一轮结束而中断。'); process.exit(10); }
    await new Promise((r) => setTimeout(r, 3000));
  }
} else if (cmd === 'status') {
  if (args[0]) { const m = refresh(args[0]); console.log(line(m)); const lv = m && rj(path.join(dir(m.id), 'live.json')); if (lv && lv.activity && lv.activity.length) console.log('   动态：\n' + lv.activity.slice(-10).map((a) => '     ' + new Date(a.t).toTimeString().slice(0, 8) + ' ' + a.x).join('\n')); }
  else {
    let ids = []; try { ids = fs.readdirSync(ROOT).sort().reverse(); } catch {}
    const ms = ids.map(refresh).filter(Boolean);
    const run = ms.filter((m) => m.status === 'running'), rest = ms.filter((m) => m.status !== 'running').slice(0, 8);
    if (!ms.length) console.log('还没有外援任务');
    for (const m of [...run, ...rest]) console.log(line(m) + (m.status !== 'running' && !m.delivered ? '\n   （结果还没被取走：helper result ' + m.id + '）' : ''));
    const qv = quotaView(); console.log('\n额度：Claude ' + (qv.claude ? qv.claude.text : '?') + ' · GPT ' + (qv.gpt ? qv.gpt.text : '?') + ' · Go ' + (qv.go ? qv.go.text : '?'));
  }
} else if (cmd === 'result') {
  const m = refresh(args[0]); if (!m) { console.error('没有这个任务'); process.exit(2); }
  console.log(line(m) + '\n\n' + result(m)); if (m.status !== 'running') setMeta(m.id, { delivered: true });
} else if (cmd === 'diff') {
  const m = meta(args[0]); if (!m || !m.branch) { console.error('这个任务没有 WorkTree'); process.exit(2); }
  if (!m.changed) { console.log('它没有改任何东西'); process.exit(0); }
  const r = git(m.repo, 'diff', 'HEAD...' + m.branch);
  const lines = r.stdout.split('\n'); console.log(lines.slice(0, 400).join('\n') + (lines.length > 400 ? '\n…（共 ' + lines.length + ' 行，只显示前 400 行）' : ''));
} else if (cmd === 'merge') {
  const m = meta(args[0]); if (!m || !m.branch) { console.error('这个任务没有 WorkTree'); process.exit(2); }
  if (m.status === 'running') { console.error('它还在干活，等它做完再合并'); process.exit(2); }
  if (!m.changed) { console.log('它没有改任何东西，不用合并'); process.exit(0); }
  commitAll(m.repo, '自动快照：合并外援 ' + m.id + ' 前', MAIN_AUTHOR);
  const r = git(m.repo, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-m', '合并外援 ' + m.id + '（' + who(m) + '）：' + m.title, m.branch);
  if (r.status !== 0) {
    const conflicts = git(m.repo, 'diff', '--name-only', '--diff-filter=U').stdout.trim();
    git(m.repo, 'merge', '--abort');
    log(m.id + ' MERGE 冲突 ' + conflicts.replace(/\n/g, ','));
    console.log('✕ 合并冲突，已放弃合并（主目录没被改动）。冲突的文件：\n' + conflicts + '\n\n说明外援干活期间，这些文件在主目录里也被改过。先 helper diff ' + m.id + ' 看它改了什么，手动把需要的部分改进去，或者 discard。');
    process.exit(1);
  }
  git(m.repo, 'worktree', 'remove', '--force', m.wt); git(m.repo, 'branch', '-d', m.branch);
  setMeta(m.id, { merged: true, mergedAt: new Date().toISOString() });
  log(m.id + ' MERGE 成功 ' + cut(m.diffstat, 120));
  console.log('✓ 已合并到 ' + m.repo + '：' + m.diffstat + (m.repo === '/home/aibox/wx-router' ? '\n⚠️ 路由代码要重启 wx-router 才生效：用 AGENTS.md「自主重启 wx-router」的方法（systemd-run 跑 wx-router-restart-now.sh，会健康检查、不健康自动回滚）。' : '') + '\n回退：git -C ' + m.repo + ' revert -m 1 HEAD');
} else if (cmd === 'discard') {
  const m = meta(args[0]); if (!m || !m.branch) { console.error('这个任务没有 WorkTree'); process.exit(2); }
  if (m.wt && fs.existsSync(m.wt)) git(m.repo, 'worktree', 'remove', '--force', m.wt);
  git(m.repo, 'branch', '-D', m.branch);
  setMeta(m.id, { discarded: true });
  log(m.id + ' DISCARD');
  console.log('已丢弃 ' + m.id + ' 的全部改动');
} else if (cmd === 'kill') {
  const m = meta(args[0]); if (!m) { console.error('没有这个任务'); process.exit(2); }
  setMeta(m.id, { status: 'killed', endedAt: new Date().toISOString() });
  const grp = (sig) => { try { process.kill(-m.runnerPid, sig); } catch {} for (const p of [m.childPid, m.runnerPid]) { try { process.kill(p, sig); } catch {} } };
  grp('SIGTERM'); await new Promise((r) => setTimeout(r, 3000)); grp('SIGKILL');
  log(m.id + ' KILL 手动停止');
  console.log('已停止 ' + m.id + (m.branch ? '（WorkTree 还在：helper diff / discard ' + m.id + '）' : ''));
} else if (cmd !== '_run') {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, ''));
}
