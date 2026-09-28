#!/usr/bin/env node
/**
 * handoff-store：会话交接的「存档链 + 目录」。wx-router、DSH、每周合并共用。
 * 2026-09-27 Mac 端 Claude 写。
 *
 * 目录结构（都在 /home/aibox/dsh-work/handoffs/）：
 *   NNNN-YYYYMMDD-HHMM-<原因>.md   单份交接，带序号，头部写「上一份」→ 连成一条链
 *   weekly/YYYY-Www.md              每周合并出的周总结（原件挪到 archive/YYYY-Www/）
 *   archive/YYYY-Www/               已合并进周总结的原件（不删）
 *   INDEX.md                        目录：每份一行。每次存档自动重建，别手改
 *
 * 用法（命令行）：
 *   node handoff-store.mjs save --file 草稿.md --title "讲了什么" --keywords "a,b,c" [--reason manual]
 *   node handoff-store.mjs reindex
 *   node handoff-store.mjs last          # 打印最新一份的路径
 */
import fs from 'node:fs';
import path from 'node:path';

export const DIR = process.env.HANDOFF_DIR || '/home/aibox/dsh-work/handoffs';
const WEEKLY = path.join(DIR, 'weekly');
const ARCHIVE = path.join(DIR, 'archive');
const NAME_RE = /^(\d{4})-(\d{8})-(\d{4})-[\w.-]+\.md$/;

const pad = (n, w = 2) => String(n).padStart(w, '0');
function stamp(d = new Date()) {
  return { ymd: d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()), hm: pad(d.getHours()) + pad(d.getMinutes()),
    human: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) };
}
function oneLine(s, max) { return String(s || '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }

// 所有单份交接（顶层 + archive/*），按序号排
export function allHandoffs() {
  const out = [];
  const scan = (d, rel) => {
    let fl = [];
    try { fl = fs.readdirSync(d); } catch { return; }
    for (const f of fl) {
      const m = NAME_RE.exec(f);
      if (m) out.push({ seq: +m[1], ymd: m[2], hm: m[3], name: f, rel: rel ? rel + '/' + f : f, p: path.join(d, f), archived: !!rel });
    }
  };
  scan(DIR, '');
  try { for (const w of fs.readdirSync(ARCHIVE)) scan(path.join(ARCHIVE, w), 'archive/' + w); } catch {}
  return out.sort((a, b) => a.seq - b.seq);
}
export function weeklies() {
  try { return fs.readdirSync(WEEKLY).filter((f) => /^\d{4}-W\d{2}\.md$/.test(f)).sort().map((f) => ({ name: f, rel: 'weekly/' + f, p: path.join(WEEKLY, f) })); } catch { return []; }
}
// 读头部的「- 字段：值」
export function header(p) {
  const h = {};
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n').slice(0, 25);
    const t = lines.find((l) => l.startsWith('# '));
    if (t) h.h1 = t.slice(2).trim();
    for (const l of lines) { const m = /^- (讲了什么|关键词|上一份|时间|触发|覆盖|上一份周总结)：(.*)$/.exec(l); if (m) h[m[1]] = m[2].trim(); }
  } catch {}
  return h;
}

// 存一份交接。body = 正文 markdown（不含头部）。返回 { seq, name, path, prev }
export function saveHandoff({ title, keywords, reason = 'manual', body, sid = '', fp = '', when = new Date() }) {
  fs.mkdirSync(DIR, { recursive: true });
  const all = allHandoffs();
  const last = all[all.length - 1];
  const seq = (last ? last.seq : 0) + 1;
  const s = stamp(when);
  const safeReason = String(reason).replace(/[^\w-]/g, '').slice(0, 20) || 'manual';
  const name = pad(seq, 4) + '-' + s.ymd + '-' + s.hm + '-' + safeReason + '.md';
  const kw = (Array.isArray(keywords) ? keywords : String(keywords || '').split(/[,，、]/)).map((k) => oneLine(k, 20)).filter(Boolean).slice(0, 10);
  const head = [
    '# 交接 #' + pad(seq, 4) + '：' + oneLine(title, 40),
    '',
    '- 序号：' + pad(seq, 4),
    '- 上一份：' + (last ? '#' + pad(last.seq, 4) + '（' + last.rel + '）' : '无（链的起点）'),
    '- 时间：' + s.human,
    '- 触发：' + safeReason,
    '- 讲了什么：' + oneLine(title, 60),
    '- 关键词：' + kw.join('、'),
  ];
  if (sid) head.push('- 会话原文：~/.dsh/sessions/--home-aibox-dsh-work--/' + sid + '/');
  if (fp) head.push('- 指纹：' + fp);
  const p = path.join(DIR, name);
  fs.writeFileSync(p, head.join('\n') + '\n\n' + String(body).trim() + '\n', { mode: 0o600 });
  reindex();
  return { seq, name, path: p, prev: last ? last.name : null };
}

// 交接包 JSON → 可读 markdown 正文
const LABELS = [['intent', '当前目标'], ['project', '项目'], ['task', '任务与完成标准'], ['next_action', '下一步'], ['completed', '已完成'],
  ['remaining', '待办'], ['decisions', '决定和原因'], ['blockers', '卡点'], ['files_changed', '改过的文件'], ['commitments', '未兑现的承诺'],
  ['irreversible', '不可撤销的事（别重做）'], ['pitfalls', '踩过的坑'], ['user_prefs', '用户偏好'], ['notes', '环境事实']];
export function packetToMarkdown(j) {
  const out = [];
  const fmt = (v) => (Array.isArray(v) ? v.map((x) => '- ' + (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') : typeof v === 'object' ? '```json\n' + JSON.stringify(v, null, 2) + '\n```' : String(v));
  for (const [k, label] of LABELS) if (j[k] != null && j[k] !== '' && !(Array.isArray(j[k]) && !j[k].length)) out.push('## ' + label + '\n\n' + fmt(j[k]));
  for (const k of Object.keys(j)) if (!LABELS.some(([x]) => x === k) && !['title', 'keywords'].includes(k)) out.push('## ' + k + '\n\n' + fmt(j[k]));
  return out.join('\n\n');
}

// 重建 INDEX.md：周总结在上，未合并的单份交接在下（新的在前）
export function reindex() {
  fs.mkdirSync(DIR, { recursive: true });
  const L = ['# 交接目录', '',
    '> 自动生成，别手改（`node /home/aibox/bin/handoff-store.mjs reindex` 重建）。',
    '> 查以前的事：先看这里 → 打开对应那一份 → 还不够细再翻会话原文（见 recall 技能）。',
    '> 已合并进周总结的原件在 `archive/<周>/`，周总结末尾列了清单。', ''];
  const ws = weeklies().reverse();
  L.push('## 周总结', '');
  if (!ws.length) L.push('（暂无）');
  else {
    L.push('| 周 | 覆盖 | 讲了什么 | 关键词 | 文件 |', '|---|---|---|---|---|');
    for (const w of ws) { const h = header(w.p); L.push('| ' + w.name.replace('.md', '') + ' | ' + oneLine(h['覆盖'], 30) + ' | ' + oneLine(h['讲了什么'], 80) + ' | ' + oneLine(h['关键词'], 60) + ' | [' + w.rel + '](' + w.rel + ') |'); }
  }
  const open = allHandoffs().filter((x) => !x.archived).reverse();
  L.push('', '## 还没合并的交接（新的在前）', '');
  if (!open.length) L.push('（暂无）');
  else {
    L.push('| # | 时间 | 讲了什么 | 关键词 | 文件 |', '|---|---|---|---|---|');
    for (const x of open) {
      const h = header(x.p);
      const when = h['时间'] || (x.ymd.slice(0, 4) + '-' + x.ymd.slice(4, 6) + '-' + x.ymd.slice(6) + ' ' + x.hm.slice(0, 2) + ':' + x.hm.slice(2));
      L.push('| ' + pad(x.seq, 4) + ' | ' + when + ' | ' + oneLine(h['讲了什么'] || h.h1, 80) + ' | ' + oneLine(h['关键词'], 60) + ' | [' + x.rel + '](' + x.rel + ') |');
    }
  }
  fs.writeFileSync(path.join(DIR, 'INDEX.md'), L.join('\n') + '\n', { mode: 0o600 });
}

// ---------- 命令行 ----------
if (import.meta.url === 'file://' + process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  if (cmd === 'save') {
    if (!opt.file || !opt.title) { console.error('用法：save --file 草稿.md --title "讲了什么" --keywords "a,b,c" [--reason manual]'); process.exit(2); }
    const r = saveHandoff({ title: opt.title, keywords: opt.keywords || '', reason: opt.reason || 'manual', body: fs.readFileSync(opt.file, 'utf8') });
    console.log('已存：' + r.path + '\n上一份：' + (r.prev || '无'));
  } else if (cmd === 'reindex') { reindex(); console.log('已重建 ' + path.join(DIR, 'INDEX.md')); }
  else if (cmd === 'last') { const a = allHandoffs(); console.log(a.length ? a[a.length - 1].p : '（没有）'); }
  else { console.error('命令：save | reindex | last'); process.exit(2); }
}
