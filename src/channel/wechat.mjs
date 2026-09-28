/**
 * 微信通道（Tencent iLink）。网关是插在 OpenClaw 微信插件和 iLink 之间的透明代理：
 *   插件 → 网关 :8787 → iLink。getupdates 的响应里，归网关管的消息被摘掉，其余原样还给插件。
 * 发消息/收发媒体借用插件自己的 send.js / media 模块（不重复实现加解密和 CDN 协议）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { cfg, paths } from '../core/config.mjs';
import { log, errText } from '../core/log.mjs';

// ---------- 账号 / 地址 ----------
export function acct() { return JSON.parse(fs.readFileSync(cfg.accountFile, 'utf8')); }
export function realBase() { return ((cfg.realBase && cfg.realBase.trim()) || acct().baseUrl || '').replace(/\/+$/, ''); }
export function cdnBase() { try { return (acct().cdnBaseUrl || '').trim() || cfg.cdnBase; } catch { return cfg.cdnBase; } }
export function sendOpts(msg) {
  const a = acct();
  const k = ['tok', 'en'].join('');
  const opts = { baseUrl: realBase(), contextToken: msg.context_token };
  opts[k] = a[k];
  return opts;
}

// ---------- 插件模块（懒加载） ----------
let sendMod = null, mediaMods = null;
async function loadSend() {
  if (!sendMod) sendMod = (await import(path.join(cfg.pluginDir, 'messaging/send.js'))).sendMessageWeixin;
  return sendMod;
}
async function loadMedia() {
  if (!mediaMods) {
    const dl = await import(path.join(cfg.pluginDir, 'media/media-download.js'));
    const sm = await import(path.join(cfg.pluginDir, 'messaging/send-media.js'));
    const mime = await import(path.join(cfg.pluginDir, 'media/mime.js'));
    mediaMods = { downloadMediaFromItem: dl.downloadMediaFromItem, sendWeixinMediaFile: sm.sendWeixinMediaFile, extFromMime: mime.getExtensionFromMime };
  }
  return mediaMods;
}

// ---------- 消息字段 ----------
export function chatKey(msg) { return msg.session_id || msg.group_id || msg.from_user_id || 'unknown'; }
export function textOf(msg) {
  const items = (msg && msg.item_list) || [];
  return items.filter((i) => i && i.type === 1 && i.text_item && i.text_item.text != null).map((i) => String(i.text_item.text)).join('');
}
export function voiceText(msg) {
  return ((msg && msg.item_list) || []).filter((i) => i && i.type === 3 && i.voice_item && i.voice_item.text).map((i) => String(i.voice_item.text)).join('');
}
const seenMsgs = new Map();
export function seenBefore(msg) {
  const id = msg && (msg.message_id ?? msg.client_id ?? (msg.seq != null ? chatKey(msg) + '#' + msg.seq : null));
  if (id == null) return false;
  const k = String(id);
  if (seenMsgs.has(k)) return true;
  seenMsgs.set(k, Date.now());
  if (seenMsgs.size > 2000) { const cut = Date.now() - 3600e3; for (const [kk, ts] of seenMsgs) if (ts < cut) seenMsgs.delete(kk); }
  return false;
}

// ---------- 发文字（超长拆成多条） ----------
export async function reply(msg, text) {
  const send = await loadSend();
  const LIMIT = 1800;
  const s = String(text);
  for (let i = 0; i < s.length; i += LIMIT) {
    await send({ to: msg.from_user_id, text: s.slice(i, i + LIMIT), opts: sendOpts(msg) });
  }
}
export const replySoft = (msg, text) => reply(msg, text).catch(() => {});

// ---------- 收媒体：与插件 process-message 相同的优先级：图片 > 视频 > 文件 > 语音(无转写) ----------
export function pickMedia(msg) {
  const items = (msg && msg.item_list) || [];
  const has = (m) => m && (m.encrypt_query_param || m.full_url);
  return items.find((i) => i.type === 2 && has(i.image_item && i.image_item.media))
    || items.find((i) => i.type === 5 && has(i.video_item && i.video_item.media))
    || items.find((i) => i.type === 4 && has(i.file_item && i.file_item.media))
    || items.find((i) => i.type === 3 && has(i.voice_item && i.voice_item.media) && !(i.voice_item && i.voice_item.text))
    || null;
}
// 下载入站媒体到 <dshCwd>/inbox，返回给模型看的一行说明
export async function inboundMedia(msg) {
  const item = pickMedia(msg);
  if (!item) return null;
  const { downloadMediaFromItem, extFromMime } = await loadMedia();
  const inbox = path.join(cfg.dshCwd, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const saveMedia = async (buf, mime, _dir, maxBytes, fileName) => {
    if (maxBytes && buf.length > maxBytes) throw new Error('media too large');
    let ext = '';
    try { ext = mime ? (extFromMime(mime) || '') : ''; } catch {}
    if (!ext) {
      if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
      else if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
      else if (buf.slice(0, 4).toString() === 'GIF8') ext = '.gif';
      else if (buf.slice(8, 12).toString() === 'WEBP') ext = '.webp';
      else ext = '.bin';
    }
    if (!ext.startsWith('.')) ext = '.' + ext;
    const safe = fileName ? String(fileName).replace(/[\/\\\0]/g, '_').slice(-80) : '';
    const fp = path.join(inbox, Date.now() + '-' + (safe || ('media' + ext)));
    fs.writeFileSync(fp, buf);
    return { path: fp };
  };
  const r = await downloadMediaFromItem(item, { cdnBaseUrl: cdnBase(), saveMedia, log: () => {}, errLog: (e) => log('dsh media ' + e), label: 'dsh' });
  if (r.decryptedPicPath) return '[用户发来一张图片：' + r.decryptedPicPath + '（请用 read_image 查看）]';
  if (r.decryptedFilePath) return '[用户发来一个文件：' + r.decryptedFilePath + '（' + (r.fileMediaType || '') + '）]';
  if (r.decryptedVoicePath) return '[用户发来一段语音，没有文字转写：' + r.decryptedVoicePath + '（' + (r.voiceMediaType || '') + '）]';
  if (r.decryptedVideoPath) return '[用户发来一段视频：' + r.decryptedVideoPath + ']';
  return '[用户发来了图片/文件/语音，但下载失败]';
}

// ---------- 发文件：模型在回复里写 [[发送:路径]]，只放行 dshCwd 下真实存在的文件 ----------
export function extractSends(text) {
  const root = cfg.dshCwd;
  const files = [];
  const out = String(text).replace(/\[\[\s*发送\s*[:：]\s*([^\]]+?)\s*\]\]/g, (_m, p) => {
    const abs = path.resolve(root, p.trim());
    let ok = false;
    try {
      const real = fs.realpathSync(abs), realRoot = fs.realpathSync(root);
      ok = abs.startsWith(root + path.sep) && real.startsWith(realRoot + path.sep) && fs.statSync(abs).isFile();
    } catch {}
    if (ok) { if (!files.includes(abs)) files.push(abs); } else log('dsh send REJECTED path=' + abs);
    return '';
  }).trim();
  return { text: out, files };
}
export async function sendFiles(msg, files) {
  const { sendWeixinMediaFile } = await loadMedia();
  for (const fp of files) {
    try {
      await sendWeixinMediaFile({ filePath: fp, to: msg.from_user_id, text: '', opts: sendOpts(msg), cdnBaseUrl: cdnBase() });
      log('dsh media sent ' + path.basename(fp));
    } catch (e) {
      log('dsh media send ERROR ' + path.basename(fp) + ' ' + errText(e));
      await replySoft(msg, '⚠️ 文件发送失败：' + path.basename(fp));
    }
  }
}

// ---------- 透明代理 ----------
// onUpdates(msgs) → { keep: [...] , consumed: n }：决定哪些消息留给 OpenClaw
export function createProxy({ onUpdates }) {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://127.0.0.1');
    const ep = u.pathname.replace(/^\/+/, '');
    if (ep === 'healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"engine":"v2"}'); return; }
    const target = realBase() + '/' + ep + (u.search || '');
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'content-length' || lk === 'connection') continue;
      headers[k] = v;
    }
    try {
      const r = await fetch(target, { method: req.method, headers, body: raw.length ? raw : undefined });
      const text = await r.text();
      if (ep.endsWith('bot/getupdates') && r.status === 200) {
        let j = null;
        try { j = JSON.parse(text); } catch {}
        if (j && Array.isArray(j.msgs)) {
          const { keep, consumed } = await onUpdates(j.msgs);
          if (consumed) { j.msgs = keep; log('filtered ' + consumed + ' msg(s), forwarded ' + keep.length); }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(j));
          return;
        }
      }
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
      res.end(text);
    } catch (e) {
      log('proxy ERROR ' + ep + ' ' + errText(e));
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: -1, errmsg: 'wx-router proxy error' }));
    }
  });
}

// ---------- 主动发给主人（不需要对方先发消息；与 bin/wx-notify.mjs 同一做法） ----------
// 收件人：~/.aibox/owner（一行微信 user id）；没有就取 modes.json 里的第一个聊天
export function ownerId() {
  try { const o = fs.readFileSync(paths.owner, 'utf8').trim(); if (o) return o; } catch {}
  try { return Object.keys(JSON.parse(fs.readFileSync(paths.modes, 'utf8')))[0] || null; } catch { return null; }
}
export async function notifyOwner(text) {
  const to = ownerId();
  if (!to) { log('notifyOwner: 找不到收件人'); return false; }
  const send = await loadSend();
  const a = acct();
  const k = ['tok', 'en'].join('');
  const opts = { baseUrl: realBase() };
  opts[k] = a[k];
  const s = String(text);
  for (let i = 0; i < s.length; i += 1800) await send({ to, text: s.slice(i, i + 1800), opts });
  log('notifyOwner sent len=' + s.length);
  return true;
}
