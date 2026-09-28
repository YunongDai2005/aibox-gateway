/**
 * topic-tools：话题相关的零成本工具（不调模型）。2026-09-28 Mac 端 Claude 写。
 *   entities(text)   —— 参考 Pull 的 Purifier：用正则抽实体（文件/路径/服务名/IP/端口/英文标识符/型号/书名号里的词），毫秒级
 *   extractTurns(sid) —— 从 DSH 会话原文抽出「主人一句 + 助手回复开头」的对话轮，去掉系统注入的提示块
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ENTITY_RES = [
  /(?:\/[\w.@-]+){2,}/g,                                  // 路径 /home/aibox/wx-router/proxy.mjs
  /\b[\w-]+\.(?:mjs|js|ts|py|sh|json|yml|yaml|md|html|css|service|timer|log|conf|gguf|mp4|mkv|txt)\b/gi,   // 文件名
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g,                // IP[:端口]
  /\b(?:[a-z]+[-_][a-z0-9_-]+|[a-z]+[A-Z][A-Za-z0-9]+)\b/g, // wx-router、snake_case、camelCase
  /\b[A-Z][A-Za-z0-9]*(?:[- ]?[A-Z0-9][A-Za-z0-9]*){0,2}\b/g, // PS4、DLNA、OpenClaw、GPT 6
  /[「『《"]([^」』》"]{2,20})[」』》"]/g,                  // 书名号/引号里的词
];
const STOP_ENT = new Set(['OK', 'I', 'A', 'The', 'DSH', 'AI', 'JSON', 'HTTP', 'API', 'URL', 'TODO', 'NEW', 'C']);
export function entities(text) {
  const s = String(text || ''); const out = new Set();
  for (const re of ENTITY_RES) for (const m of s.matchAll(re)) {
    let e = (m[1] || m[0]).trim(); if (e.length < 2 || e.length > 60 || STOP_ENT.has(e)) continue;
    out.add(e.toLowerCase());
  }
  return out;
}
// 系统注入的提示块（交接目录、经理/外援提示、环境对账、checkpoint、system-reminder…）不是主人说的话
const INJECT_RE = /^(【[^】]{2,40}】|<system-reminder>|This is an automatically generated checkpoint|Current runtime context|\[用户在你执行任务的过程中插话\]|background job |请把当前整个会话压缩成)/;
// 密码/口令/令牌一律遮挡（话题卡片、话题表都会存主人原话，绝不能把密码存进去）
export function redact(s) {
  return String(s || '')
    .replace(/(密码|口令|passwd|password|pwd|pin码?)(\s*(是|为|[:：=]))?\s*[^\s，,。；;）)]{3,}/gi, '$1[已遮挡]')
    .replace(/\b(sk-[a-z0-9-]{8,}|ghp_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,})\S*/gi, '[令牌已遮挡]')
    // 单独发来一串「字母+数字」（没有空格、6 位以上）多半是密码
    .replace(/^\s*(?=[^\s]*[A-Za-z])(?=[^\s]*\d)[A-Za-z0-9!@#$%^&*._\\-]{6,}\s*$/, '[疑似密码已遮挡]');
}
function stripInjected(t) {
  let s = String(t || '');
  // 回忆提示：【交接目录 …】 + 若干行目录（## / | / …）+ 空行 + 主人原话
  if (/^\s*【交接目录/.test(s)) {
    const ls = s.split('\n'); let last = 0;
    ls.forEach((l, i) => { if (/^(##|\||…|> |【交接目录)/.test(l.trim())) last = i; });
    s = ls.slice(last + 1).join('\n');
  }
  // 路由把主人原话放在「【用户消息】」之后；插话包装里是「用户原话：」
  const um = s.lastIndexOf('【用户消息】'); if (um >= 0) s = s.slice(um + 6);
  const yw = s.match(/用户原话：([\s\S]*?)\n先判断/); if (yw) s = yw[1];
  // 去掉开头连续的【…】提示块（到空行为止）
  while (/^\s*【[^】]{2,60}】/.test(s)) { const i = s.indexOf('\n\n'); if (i < 0) return ''; s = s.slice(i + 2); }
  return s.trim();
}
export function sessionDirOf(sid) {
  const base = path.join(process.env.AIBOX_HOME || '/home/aibox', '.dsh', 'sessions');
  for (const d of fs.readdirSync(base)) { const p = path.join(base, d, sid); if (fs.existsSync(p)) return p; }
  return null;
}
export function extractTurns(sid) {
  const dir = sessionDirOf(sid); if (!dir) return [];
  const raw = execFileSync('zstdcat', [path.join(dir, 'session.v4.jsonl.zstd')], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8');
  const turns = []; let cur = null; let msgIdx = -1;
  for (const l of raw.split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type === 'user/message') {
      const txt = ((j.data && j.data.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      msgIdx++;
      if (INJECT_RE.test(txt.trim()) && !txt.includes('【用户消息】') && !txt.includes('用户原话：')) continue;
      const u = stripInjected(txt); if (!u || u.length < 2) continue;
      cur = { i: turns.length, msg: msgIdx, at: j.time, sid, user: redact(u).slice(0, 600), reply: '' }; turns.push(cur);
    } else if (j.type === 'assistant/message' && cur) {
      msgIdx++;
      const m = (j.data && j.data.message) || {};
      const txt = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      if (txt.trim()) cur.reply = (cur.reply ? cur.reply + '\n' : '') + txt.trim();
    }
  }
  for (const t of turns) { t.reply = redact(t.reply).slice(-600); t.ents = [...entities(t.user + '\n' + t.reply)].slice(0, 20); }
  return turns;
}
