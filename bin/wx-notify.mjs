#!/usr/bin/env node
/**
 * wx-notify：主动给主人发一条微信（不需要对方先发消息）。
 *   node /home/aibox/bin/wx-notify.mjs "要发的文字"
 *   echo "长文本" | node /home/aibox/bin/wx-notify.mjs -
 * 收件人：/home/aibox/.aibox/owner（一行微信 user id）；没有就取 wx-router/modes.json 里的第一个聊天。
 * 走 openclaw-weixin 插件自己的发送函数，直连 iLink（不经 wx-router）。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROUTER = '/home/aibox/wx-router';
const cfg = JSON.parse(fs.readFileSync(path.join(ROUTER, 'config.json'), 'utf8'));
const PLUGIN = '/home/aibox/.openclaw/npm/projects/weixin-plugin/node_modules/@tencent-weixin/openclaw-weixin/dist/src';

function owner() {
  try { const o = fs.readFileSync('/home/aibox/.aibox/owner', 'utf8').trim(); if (o) return o; } catch {}
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(ROUTER, 'modes.json'), 'utf8')))[0]; } catch {}
  return null;
}

let text = process.argv.slice(2).join(' ');
if (!text || text === '-') text = fs.readFileSync(0, 'utf8');
text = text.trim();
if (!text) { console.error('usage: wx-notify.mjs "text"'); process.exit(2); }
const to = owner();
if (!to) { console.error('wx-notify: 找不到收件人'); process.exit(3); }

const a = JSON.parse(fs.readFileSync(cfg.accountFile, 'utf8'));
const k = ['tok', 'en'].join('');
const opts = { baseUrl: ((cfg.realBase && cfg.realBase.trim()) || a.baseUrl).replace(/\/+$/, '') };
opts[k] = a[k];
const { sendMessageWeixin } = await import(path.join(PLUGIN, 'messaging/send.js'));
const LIMIT = 1800;
for (let i = 0; i < text.length; i += LIMIT) await sendMessageWeixin({ to, text: text.slice(i, i + LIMIT), opts });
try { fs.appendFileSync(path.join(ROUTER, 'router.log'), '[' + new Date().toISOString() + '] wx-notify sent len=' + text.length + '\n'); } catch {}
console.log('sent');
