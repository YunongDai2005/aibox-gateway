// JSON 状态文件的小工具：读不到给默认值；写入先写 .tmp 再改名（断电也不会留半截文件）
import fs from 'node:fs';
import path from 'node:path';

export function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(obj, null, 2));
  fs.renameSync(p + '.tmp', p);
}
export function appendJsonl(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
}
export function readJsonl(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
// 按聊天分键的 JSON 文件（modes.json、dsh-sessions.json 这类）
export function keyed(p) {
  return {
    all: () => readJson(p, {}),
    get: (k) => readJson(p, {})[k],
    set(k, v) { const m = readJson(p, {}); if (v === undefined || v === null) delete m[k]; else m[k] = v; fs.writeFileSync(p, JSON.stringify(m, null, 2)); },
  };
}
