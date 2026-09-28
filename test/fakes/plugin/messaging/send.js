// 假的微信发送：把发出去的消息记进 FAKE_SENT（jsonl）
import fs from 'node:fs';
export async function sendMessageWeixin({ to, text, opts }) {
  fs.appendFileSync(process.env.FAKE_SENT, JSON.stringify({ t: Date.now(), kind: 'text', to, text, ctx: !!(opts && opts.contextToken) }) + '\n');
  return { ok: true };
}
