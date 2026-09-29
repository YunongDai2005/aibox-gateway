#!/usr/bin/env node
/**
 * mailbox：工人（DSH）看经理转来的主人留言。2026-09-28 Mac 端 Claude 写。
 * 你干活时主人说的话，经理判断是"补充/新要求"的会放进这里。每完成一个阶段、写【进展】之前跑一次：
 *   mailbox          看未读留言（看完自动标记已读）
 *   mailbox --all    看最近全部（含已读）
 * 没看的留言不会丢：你这一轮结束时，路由会把没看的自动作为下一条消息交给你。
 */
import { mailboxUnread, mailboxAll, mailboxMarkRead } from '/home/aibox/wx-router/manager.mjs';
const all = process.argv.includes('--all');
const chat = process.env.AIBOX_CHAT, runId = process.env.AIBOX_RUN_ID;
const items = (all ? mailboxAll().slice(-20) : mailboxUnread()).filter((x) => !x.chat || (x.chat === chat && x.runId === runId));
if (!items.length) { console.log('（没有新留言）'); process.exit(0); }
for (const x of items) console.log('📩 ' + new Date(x.at).toTimeString().slice(0, 5) + (x.read ? '（已读）' : '') + ' 主人（经经理转达）：' + x.text);
if (!all) { mailboxMarkRead(items.map((x) => x.id)); console.log('\n→ 处理完在【进展】里回应一句，主人能看到。'); }
