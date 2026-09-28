#!/usr/bin/env node
/**
 * 假 DSH：参数、事件流格式与真的 `dsh --profile headless --json` 一致。行为由消息里的指令控制：
 *   #sleep=毫秒   干这么久（期间每 300ms 打一次工具调用，看门狗不会判卡死）
 *   #hang         一声不吭地卡住（给看门狗杀）
 *   #quota        没带 --patch（走 Go）时报 429
 *   #fail         直接失败、没有 final
 *   #milestone=X  输出一行【进展】X
 *   #usage=N      报告单步输入 N token
 *   #send=路径     回复里带 [[发送:路径]]
 *   #final=X      回复 X（默认 ECHO:<用户原话>）
 * 每次调用记一行到 FAKE_DSH_LOG；FAKE_LOST 文件里列出的 sid 视为"会话不存在"。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const sid = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : null;
const fallback = args.includes('--patch');
let task = '';
for await (const c of process.stdin) task += c;
const log = (o) => { try { fs.appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify(o) + '\n'); } catch {} };
log({ t: Date.now(), pid: process.pid, sid, fallback, args, task });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

let lost = [];
try { lost = fs.readFileSync(process.env.FAKE_LOST, 'utf8').split('\n').filter(Boolean); } catch {}
if (sid && lost.includes(sid)) { process.stderr.write('Error: session ' + sid + ' does not exist; omit --session-id to start a new one\n'); process.exit(1); }

const d = {};
for (const m of task.matchAll(/#(sleep|hang|quota|fail|milestone|usage|send|final)(?:=([^\s#]*))?/g)) d[m[1]] = m[2] ?? true;
if (d.quota && !fallback) { process.stderr.write('HTTP 429 RATE_LIMIT exceeded\n'); process.exit(1); }
if (d.fail) { process.stderr.write('boom\n'); process.exit(1); }

const id = sid || 'sess-' + crypto.randomBytes(4).toString('hex');
out({ type: 'session', sessionId: id });
out({ type: 'status', phase: 'step_start' });
if (d.hang) { await sleep(3600e3); }
if (d.milestone) out({ type: 'text', text: '开始干活\n【进展】' + d.milestone });
const until = Date.now() + Number(d.sleep || 0);
let n = 0;
while (Date.now() < until) {
  const callId = 'c' + (++n);
  out({ type: 'tool_call', tool: 'bash', callId, input: { command: 'sleep 0.3', description: '第 ' + n + ' 步' } });
  await sleep(Math.min(300, Math.max(0, until - Date.now())));
  out({ type: 'tool_result', callId, status: 'completed' });
}
out({ type: 'status', phase: 'step_end', usage: { inputTokens: Number(d.usage || 1000), cacheReadTokens: 0 } });

let final;
if (task.startsWith('请把当前整个会话压缩成一份"交接包"')) final = JSON.stringify({ title: '测试交接-' + id.slice(-4), keywords: ['测试', 'handoff'], task: '继续测试', next_action: '跑下一个场景' });
else if (d.final) final = String(d.final).replace(/_/g, ' ');
else {
  let u = task;
  const i = u.lastIndexOf('【用户消息】'); if (i >= 0) u = u.slice(i + 6);
  const y = u.match(/用户原话：([^\n]*)/); if (y) u = y[1];
  u = u.replace(/#\w+(=[^\s#]*)?/g, '').trim().split('\n').pop().trim();
  final = 'ECHO:' + u;
}
if (d.send) final += '\n[[发送:' + d.send + ']]';
out({ type: 'text', text: final });
out({ type: 'final', text: final });
out({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } });
process.exit(0);
