#!/usr/bin/env node
/**
 * ask-owner：工人（DSH）干活途中问主人一个问题，并等回答。2026-09-28 Mac 端 Claude 写。
 *   ask-owner "字幕要中文还是中英双语？" [--wait 480]
 * 问题会通过微信发给主人；主人的回答经经理整理后写回来，这个命令就打印回答并结束，你接着干。
 * 默认最多等 480 秒（8 分钟）；没等到就打印"没回复"，你按自己的判断继续，并在【进展】里说明你选了什么。
 * 什么时候问：真有几种做法且选错会返工、或者要花钱/删东西/对外发消息。小事自己定，别频繁问。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { QFILE, AFILE, log } from '/home/aibox/wx-router/manager.mjs';
const args = process.argv.slice(2);
let wait = 480; const wi = args.indexOf('--wait'); if (wi >= 0) { wait = Math.min(540, Math.max(30, Number(args[wi + 1]) || 480)); args.splice(wi, 2); }
const q = args.join(' ').trim();
if (!q) { console.error('用法：ask-owner "问题" [--wait 480]'); process.exit(2); }
const id = crypto.randomUUID().slice(0, 8);
fs.mkdirSync('/home/aibox/.aibox/mgr', { recursive: true });
try { fs.unlinkSync(AFILE); } catch {}
fs.writeFileSync(QFILE, JSON.stringify({ id, q, at: new Date().toISOString(), answered: false }, null, 2));
log('ASK id=' + id + ' q=' + JSON.stringify(q.slice(0, 150)));
try { execFileSync('/usr/bin/node', ['/home/aibox/bin/wx-notify.mjs', '❓ 它想问你：' + q + '\n（直接回复就行）'], { timeout: 30000, stdio: 'ignore' }); }
catch (e) { console.log('（微信没发出去：' + e.message + '）按你的判断继续。'); process.exit(0); }
const t0 = Date.now();
for (;;) {
  try { const a = JSON.parse(fs.readFileSync(AFILE, 'utf8')); if (a.qid === id) { log('ANSWERED id=' + id + ' secs=' + Math.round((Date.now() - t0) / 1000)); console.log('主人回答：' + a.answer); process.exit(0); } } catch {}
  if (Date.now() - t0 > wait * 1000) {
    try { const cur = JSON.parse(fs.readFileSync(QFILE, 'utf8')); if (cur.id === id) fs.writeFileSync(QFILE, JSON.stringify({ ...cur, answered: true, expired: true }, null, 2)); } catch {}
    log('ASK TIMEOUT id=' + id);
    console.log('主人 ' + Math.round(wait / 60) + ' 分钟没回复。按你的判断选一个继续做，并在【进展】里说明你选了什么、为什么；主人之后回复会通过信箱转给你。');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
