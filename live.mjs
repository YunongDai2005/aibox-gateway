/**
 * live：DSH 实时进度。wx-router 把 dsh --json 的事件流喂进来，这里整理成
 *   dsh-live.json（仪表盘「DSH 正在做什么」读它）+ 给微信进度播报用的摘要。
 * 2026-09-27 Mac 端 Claude 写。只记说明文字、工具名和描述，不记工具输出内容。
 */
import fs from 'node:fs';

const FILE = '/home/aibox/wx-router/dsh-live.json';
const MAX_EVENTS = 80;
const KEEP_RECENT = 8;
const MILESTONE_RE = /【进展】\s*(.+)/g;

const state = { running: {}, recent: [] };
let nextId = 1, timer = null;

export const cut = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
export const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + ' 秒' : s < 3600 ? Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒' : Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分'; };

function flush() {
  timer = null;
  try {
    const pub = (r) => { const { _calls, ...o } = r; return o; };
    fs.writeFileSync(FILE + '.tmp', JSON.stringify({ updatedAt: Date.now(), running: Object.values(state.running).map(pub), recent: state.recent.map(pub) }));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch {}
}
function save(now) {
  if (now) { if (timer) clearTimeout(timer); flush(); }
  else if (!timer) timer = setTimeout(flush, 700);
}

// 启动时：上次没跑完的（路由被重启）标成"中断"
export function init() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const lost = (j.running || []).map((r) => ({ ...r, status: 'interrupted', endedAt: j.updatedAt, current: null }));
    state.recent = [...lost, ...(j.recent || [])].slice(0, KEEP_RECENT);
  } catch {}
  save(true);
}

const isClaudeCall = (tool, i) => tool === 'bash' && /ask-claude|ask-go|helper(\.mjs)? start (claude|gpt|go)\b/.test((i && i.command) || '');
function toolLabel(tool, input) {
  const i = input || {};
  if (tool === 'codex' || tool === 'codex_max') return '请 GPT 外援：' + cut(i.prompt || i.task || i.description || '', 80);
  if (isClaudeCall(tool, i)) return '请 ' + (/start gpt/.test(i.command) ? 'GPT' : /start go\b|ask-go/.test(i.command) ? 'Go 顾问' : 'Claude') + ' 外援' + (/--work/.test(i.command) ? '（干活）' : '（顾问）') + '：' + cut(i.description || i.command, 80);
  const main = i.description || i.command || i.path || i.file_path || i.filePath || i.url || i.query || i.pattern || i.prompt;
  return tool + (main ? '：' + cut(main, 100) : '');
}

export function startRun({ chat, kind = 'chat', task = '', limitMs = 0, idleMs = 0 }) {
  const run = {
    id: nextId++, chatTag: String(chat || '').slice(0, 6), kind, task: cut(task, 120),
    startedAt: Date.now(), lastAt: Date.now(), limitMs, idleMs, status: 'running', route: 'go', step: 0, tools: 0, ctx: 0,
    // 2026-09-28：上下文水位。ctx=本轮单步输入 token 峰值（≈当前上下文规模），
    // ctxBudget=压缩阈值，ctxWarnPct=警告线，ctxPct=已用百分比，ctxRotate=上次压缩原因。
    // 面板用这几个数画圆环：一眼看出还剩多少、什么时候会被压缩。
    ctxBudget: 0, ctxWarnPct: 0.8, ctxPct: 0, ctxRotate: null,
    current: { kind: 'think', label: '准备中', since: Date.now() }, lastSay: '', milestones: [], events: [], _calls: {},
  };
  const push = (e) => { run.events.push({ t: Date.now(), ...e }); if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS); };
  const listeners = [];
  run.on = (fn) => listeners.push(fn);
  const emit = (ev) => { for (const fn of listeners) { try { fn(ev); } catch {} } };
  run.note = (text, k = 'note') => { push({ k, x: cut(text, 200) }); save(); };
  run.setRoute = (r) => { run.route = r; save(); };
  // 2026-09-28：更新上下文水位。budget/warnPct 由 proxy 按 config 传入；
  // ctxPct>1 就是"已经超过压缩阈值"，面板涂红，说明下次交接就会被压缩。
  run.setCtx = ({ ctx, budget, warnPct, rotate }) => {
    if (Number.isFinite(ctx) && ctx > run.ctx) run.ctx = ctx;
    if (Number.isFinite(budget) && budget > 0) run.ctxBudget = budget;
    if (Number.isFinite(warnPct) && warnPct > 0) run.ctxWarnPct = warnPct;
    if (rotate) run.ctxRotate = rotate;
    run.ctxPct = run.ctxBudget > 0 ? run.ctx / run.ctxBudget : 0;
    save();
  };
  // 喂 dsh --json 的一行事件
  run.event = (j) => {
    if (!j || !j.type) return;
    run.lastAt = Date.now();
    if (j.type === 'status' && j.phase === 'step_start') {
      run.step++;
      run.current = { kind: 'think', label: '思考中', since: Date.now() };
    } else if (j.type === 'status' && j.phase === 'step_end' && j.usage) {
      const it = (j.usage.inputTokens || 0) + (j.usage.cacheReadTokens || 0) + (j.usage.cacheWriteTokens || 0);
      if (it > run.ctx) run.ctx = it;    } else if (j.type === 'text' && j.text && j.text.trim()) {
      const plain = String(j.text).replace(/【进展】.*/g, '').trim(); // 进展单独展示，"刚才说"里不重复
      if (plain) run.lastSay = cut(plain, 400);
      push({ k: 'say', x: cut(j.text, 300) });
      emit({ kind: 'say', text: j.text });
      for (const m of String(j.text).matchAll(MILESTONE_RE)) {
        const x = cut(m[1], 150);
        run.milestones.push({ t: Date.now(), x });
        push({ k: 'milestone', x });
        emit({ kind: 'milestone', text: x });
      }
    } else if (j.type === 'tool_call') {
      run.tools++;
      const label = toolLabel(j.tool, j.input);
      run._calls[j.callId] = { t: Date.now(), idx: run.events.length };
      push({ k: 'tool', tool: j.tool, x: label, id: j.callId });
      run.current = { kind: 'tool', tool: j.tool, label, since: Date.now() };
      if (j.tool === 'codex' || j.tool === 'codex_max' || isClaudeCall(j.tool, j.input)) emit({ kind: 'codex', text: label });
    } else if (j.type === 'tool_result') {
      const c = run._calls[j.callId];
      const ev = run.events.find((e) => e.id === j.callId);
      if (ev) { ev.st = j.status === 'completed' ? 'ok' : 'err'; if (c) ev.ms = Date.now() - c.t; }
      delete run._calls[j.callId];
      if (!Object.keys(run._calls).length) run.current = { kind: 'think', label: '看结果、想下一步', since: Date.now() };
    } else if (j.type === 'error') {
      push({ k: 'err', x: cut(j.message || j.error || JSON.stringify(j), 200) });
    }
    save();
  };
  run.end = (status, info = '') => {
    if (run.status !== 'running') return;
    run.status = status; run.endedAt = Date.now(); run.took = run.endedAt - run.startedAt; run.current = null;
    if (info) push({ k: status === 'done' ? 'done' : 'err', x: cut(info, 200) });
    delete state.running[run.id];
    state.recent.unshift(run);
    state.recent = state.recent.slice(0, KEEP_RECENT);
    save(true);
  };
  state.running[run.id] = run;
  save(true);
  return run;
}

export function runningFor(chat) { return Object.values(state.running).filter((r) => r.chatTag === String(chat || '').slice(0, 6)); }
export function lastFor(chat) { return state.recent.find((r) => r.chatTag === String(chat || '').slice(0, 6)); }

// 给微信看的一段进度摘要
export function describe(run, head = '⏳ 还在做') {
  const L = [head + ' · 已 ' + dur(Date.now() - run.startedAt) + ' · 第 ' + run.step + ' 步 · 用了 ' + run.tools + ' 次工具'];
  if (run.milestones.length) L.push('进展：' + run.milestones[run.milestones.length - 1].x);
  if (run.lastSay) L.push('刚才说：' + cut(run.lastSay, 120));
  if (run.current) L.push('正在：' + (run.current.kind === 'tool' ? cut(run.current.label, 80) : run.current.label) + '（' + dur(Date.now() - run.current.since) + '）');
  return L.join('\n');
}
