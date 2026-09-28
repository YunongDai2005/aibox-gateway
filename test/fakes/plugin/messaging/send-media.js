import fs from 'node:fs';
import path from 'node:path';
export async function sendWeixinMediaFile({ filePath, to }) {
  fs.appendFileSync(process.env.FAKE_SENT, JSON.stringify({ t: Date.now(), kind: 'file', to, file: path.basename(filePath) }) + '\n');
  return { ok: true };
}
