#!/usr/bin/env node
/**
 * topic-split：把一个已经混了好几件事的话题「往回拆开」。2026-09-28 Mac 端 Claude 写（主人要的"往回切"）。
 *
 * 做法（参考三份资料）：
 *   1. 逐轮目录（Pull 的 M0 目录）：每轮 = 时间 + 主人原话 + 助手回复开头 + 实体（零模型调用；密码一律遮挡）
 *   2. 整体分组（LightMem 的"按话题分组"）：把整份目录交给会思考的模型（Go · gpt-6-luna），按"是不是同一件事"分组，
 *      允许一个话题分散在不同时间（聊着聊着又回来）
 *   3. 每组写一张卡片（LightMem：摘要和细节分开存）+ 原文位置（Pull：可逆，原文不删，随时能展开）
 *   4. 最近在聊的那组留在原来的会话里（接着干活不断片）；其它组各开一个新话题，第一句话进来时把卡片当交接包带上
 * 旧会话一字不删；所有状态文件先备份；默认只预览，加 --apply 才真的改。
 *
 *   node topic-split.mjs [--apply] [--chat <微信聊天ID>] [--max-turns 160]
 * 日志 /home/aibox/.aibox/logs/topics.log；每次拆分的完整结果 /home/aibox/.aibox/topics/split-<时间>.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractTurns, entities, redact } from './topic-tools.mjs';
import { cfg, paths } from '../core/config.mjs';
import { responses } from '../core/llm.mjs';

const STATE = paths.threads;
const OUTDIR = paths.topics;
const LOG = path.join(paths.logs, 'topics.log');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const maxTurns = Number(args[args.indexOf('--max-turns') + 1]) || 160;
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const hm = (ms) => new Date(ms).toTimeString().slice(0, 5);
function log(m) { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\n'); } catch {} }
async function think(prompt, effort = 'medium') {
  const txt = await responses(cfg.llm.judgeModel || 'gpt-6-luna', prompt, { session: 'ses_aibox_topicsplit', maxTokens: 16000, effort, timeoutMs: 300000, purpose: 'topic-split' });
  const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
  return JSON.parse(txt.slice(a, b + 1));
}

// ---------- 读状态 ----------
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const chat = args.includes('--chat') ? args[args.indexOf('--chat') + 1] : Object.keys(st.chats)[0];
const c = st.chats[chat];
if (!c) { console.error('话题表里没有这个聊天'); process.exit(2); }
const fg = c.threads[c.fg];
const head = (JSON.parse(fs.readFileSync(paths.sessions, 'utf8')) || {})[chat] || fg.head;
const sids = [...(fg.segments || []), head].filter(Boolean);
let turns = []; for (const s of sids) turns = turns.concat(extractTurns(s));
turns = turns.filter((t) => !/^\[疑似密码已遮挡\]$/.test(t.user)).sort((a, b) => a.at - b.at).slice(-maxTurns);
turns.forEach((t, i) => { t.i = i; });
if (turns.length < 6) { console.log('这个话题只有 ' + turns.length + ' 轮，不用拆'); process.exit(0); }
console.log('要拆的话题：「' + fg.title + '」，' + sids.length + ' 段会话，共 ' + turns.length + ' 轮（' + hm(turns[0].at) + '–' + hm(turns.at(-1).at) + '）');

// ---------- 1. 逐轮目录（零模型调用）----------
const dirLines = turns.map((t) => '#' + t.i + ' ' + hm(t.at) + ' 主人：' + cut(t.user, 110) + ' ｜助手：' + cut(t.reply, 70) + (t.ents.length ? ' ｜实体：' + t.ents.slice(0, 5).join(',') : ''));

// ---------- 2. 整体分组 ----------
const groupPrompt = `下面是主人和 AI 助手在同一个聊天窗口里的一段对话目录（每行一轮：主人说的话 + 助手回复开头 + 提到的实体）。
这段对话混了好几件不同的事。请按"是不是同一件事（同一个目标/问题/任务）"把所有轮分组。
要求：
- 一件事可以分散在不同时间（中途聊别的，后来又回来）——同一件事的轮放同一组。
- 追问、确认、催进度、"好的/再试一次"这类短句，归到它接着的那件事。
- 一次性的小事（查个单号、问个天气）单独成组。
- 分组别太碎：同一个大目标下的连续子步骤算一件事；但目标明显不同就分开。
- 每一轮都要归到某一组；组数通常 3~10 个。
- last 字段：最后几轮在做的那件事是哪一组（它会留在当前会话里继续）。
只输出 JSON：{"groups":[{"title":"≤12字标题","turns":[轮号...]}],"last":组下标}

对话目录：
${dirLines.join('\n')}`;
console.log('让 gpt-6-luna 分组（' + groupPrompt.length + ' 字）…');
const g = await think(groupPrompt, 'medium');
const groups = (g.groups || []).map((x) => ({ title: cut(x.title, 16), turns: [...new Set((x.turns || []).map(Number).filter((n) => turns[n]))].sort((a, b) => a - b) })).filter((x) => x.turns.length);
const lastIdx = Number.isInteger(g.last) && groups[g.last] ? g.last : groups.findIndex((x) => x.turns.includes(turns.length - 1));
const covered = new Set(groups.flatMap((x) => x.turns));
const missing = turns.filter((t) => !covered.has(t.i)).map((t) => t.i);
if (missing.length && groups[lastIdx]) { groups[lastIdx].turns.push(...missing); groups[lastIdx].turns.sort((a, b) => a - b); }

// ---------- 3. 每组一张卡片 ----------
async function card(grp) {
  const ts = grp.turns.map((i) => turns[i]);
  const body = ts.map((t) => '#' + t.i + ' ' + hm(t.at) + ' 主人：' + cut(t.user, 300) + '\n   助手：' + cut(t.reply, 260)).join('\n');
  const r = await think(`下面是一段对话里关于「${grp.title}」这件事的全部轮次（已从混合对话里挑出来）。
给以后接手这件事的助手写一张交接卡片。只写事实，别编，别写密码。
只输出 JSON：{"title":"≤12字","summary":"一句话：这件事是什么、做到哪了","done":["做成了什么"],"decisions":["定了什么、为什么"],"pitfalls":["踩过的坑"],"todo":["还没做完的/下一步"],"files":["涉及的文件/设备/地址"]}
（每个数组 0~6 条，没有就给空数组）

${body}`, 'low');
  return r;
}
const cards = [];
for (let k = 0; k < groups.length; k++) {
  const grp = groups[k];
  let cd; try { cd = await card(grp); } catch (e) { cd = { title: grp.title, summary: '（卡片生成失败：' + e.message + '）', done: [], decisions: [], pitfalls: [], todo: [], files: [] }; }
  const ts = grp.turns.map((i) => turns[i]);
  // 原文位置：按会话分，给出 session-grep 能直接展开的范围（Pull：折叠但可展开）
  const where = Object.entries(ts.reduce((m, t) => { (m[t.sid] = m[t.sid] || []).push(t.msg); return m; }, {}))
    .map(([s, ms]) => s + ' 第 ' + Math.min(...ms) + '–' + Math.max(...ms) + ' 条（python3 ' + path.join(paths.bin, 'session-grep.py') + ' --show ' + s.replace('session-', '').slice(0, 8) + ' --from ' + Math.min(...ms) + ' --to ' + Math.max(...ms) + '）');
  cards.push({ ...cd, title: cut(cd.title || grp.title, 16), turns: grp.turns, first: ts[0].at, last: ts.at(-1).at, where, isLast: k === lastIdx });
  console.log((k === lastIdx ? '▶ ' : '  ') + '「' + cards.at(-1).title + '」 ' + grp.turns.length + ' 轮 ' + hm(ts[0].at) + '–' + hm(ts.at(-1).at) + '：' + cut(cd.summary, 80));
}
const md = (cd) => [
  '【话题拆分交接】这个会话是从一段混了好几件事的对话里拆出来的，只管「' + cd.title + '」这一件事（别的事在别的会话里，你不用管）。',
  '一句话：' + (cd.summary || ''),
  ...[['做成了', cd.done], ['决定', cd.decisions], ['踩过的坑', cd.pitfalls], ['待办/下一步', cd.todo], ['涉及', cd.files]].filter(([, a]) => a && a.length).map(([k, a]) => k + '：\n' + a.map((x) => '- ' + redact(x)).join('\n')),
  '原文在哪（要细节就展开这几条，别整段读）：\n' + cd.where.map((w) => '- ' + w).join('\n'),
].join('\n');

fs.mkdirSync(OUTDIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(OUTDIR, 'split-' + stamp + '.json'), JSON.stringify({ chat, from: fg.id, fromTitle: fg.title, sids, groups: cards, dir: dirLines }, null, 2), { mode: 0o600 });
if (!APPLY) { console.log('\n（只是预览，加 --apply 才会真的拆开。完整结果：' + path.join(OUTDIR, 'split-' + stamp + '.json') + '）'); process.exit(0); }

// ---------- 4. 写回话题表 ----------
const now = Date.now();
for (const f of ['dsh-threads.json', 'dsh-sessions.json', 'dsh-session-meta.json']) fs.copyFileSync(path.join(W, f), path.join(W, f + '.bak-split-' + stamp));
const st2 = JSON.parse(fs.readFileSync(STATE, 'utf8'));      // 重新读一次，尽量缩短和路由同时写的窗口
const c2 = st2.chats[chat];
const made = [];
for (const cd of cards) {
  const ts = cd.turns.map((i) => turns[i]);
  const anchors = ts.filter((t) => t.user.length > 3).slice(-40).map((t) => ({ t: cut(redact(t.user), 200), at: t.at }));
  const ents = {}; for (const t of ts) for (const e of entities(t.user + '\n' + t.reply)) ents[e] = t.at;
  if (cd.isLast) {             // 留在当前会话：只换标题和画像，会话不动
    const t = c2.threads[c2.fg];
    Object.assign(t, { title: cd.title, titleAuto: true, anchors, ents, lastReply: cut(redact(ts.at(-1).reply), 300) });
    made.push('▶ ' + cd.title + '（留在当前会话）');
    continue;
  }
  c2.seq = (c2.seq || 0) + 1;
  const id = 'th' + c2.seq;
  const text = md(cd);
  c2.threads[id] = { id, title: cd.title, titleAuto: true, origin: 'split', head: null, segments: [], createdAt: now, lastActiveAt: cd.last, anchors, ents, lastReply: cut(redact(ts.at(-1).reply), 300), status: 'open',
    // 切到这个话题时：路由把 meta 装进会话元数据 → 第一句话进来时把卡片当交接包注入（proxy 原有机制）
    meta: { fileInjectedAt: now, msgCount: 0, pendingHandoff: { ts: now, from: 'split:' + fg.id, fp: crypto.createHash('sha256').update(text).digest('hex').slice(0, 16), text } } };
  made.push(id + ' ' + cd.title);
  // 同时进交接存档链，recall 查得到
  try {
    process.env.HANDOFF_DIR = path.join(cfg.dshCwd, 'handoffs');
    const hs = await import(path.join(paths.bin, 'handoff-store.mjs'));
    hs.saveHandoff({ title: '话题拆分：' + cd.title, keywords: [cd.title, ...(cd.files || []).slice(0, 5)], reason: 'split', body: text });
  } catch (e) { log('handoff archive ERROR ' + e.message); }
}
fs.writeFileSync(STATE + '.tmp', JSON.stringify(st2, null, 2)); fs.renameSync(STATE + '.tmp', STATE);
log('SPLIT chat=' + chat.slice(0, 6) + ' from=' + fg.id + ' turns=' + turns.length + ' → ' + made.join(' | '));
console.log('\n✓ 已拆开：\n  ' + made.join('\n  ') + '\n旧会话一字未删；状态文件备份后缀 .bak-split-' + stamp);
