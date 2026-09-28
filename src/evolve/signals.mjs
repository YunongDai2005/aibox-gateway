/**
 * 不满意信号：从主人的原话和系统事件里找"这次没做好"的迹象，自进化复盘就吃这些。
 *   complaint          抱怨/纠正（「不对」「又错了」「怎么还没」「没反应」…）
 *   noisy              嫌播报太多（「别刷屏」「太多了」）
 *   retry              3 分钟内把同一句话又发了一遍（多半是上次没得到满意结果）
 *   resume_after_kill  任务被看门狗停下后，主人 30 分钟内说「继续」（看门狗可能误杀）
 *   misroute           「切错了」（话题判错）
 *   stop               主人叫停
 *   kill / error       被看门狗停下 / 出错
 * 样本只存打过码的前 80 字，落盘 ~/.aibox/evolve/signals/YYYY-MM-DD.jsonl
 */
import path from 'node:path';
import { paths } from '../core/config.mjs';
import { emit, on, mask, cut } from '../core/log.mjs';
import { appendJsonl, readJsonl } from '../core/store.mjs';
import { dayKey } from '../observe/metrics.mjs';

export const COMPLAINT_RE = /(不对|不是这个|不是这样|错了|又错|搞错|弄错|理解错|没听懂|听不懂|没反应|怎么还没|怎么又|还是不行|还是没|没用|白做|重来|太慢|卡住了|卡死|什么鬼|乱七八糟|答非所问|没明白|跑偏)/;
export const NOISY_RE = /(别刷屏|刷屏|太多了|别报了|少报|别老报|吵)/;
const RESUME_RE = /^(继续|接着|接着做|继续做|go on|continue)[。.!！]?$/i;

const file = (ts = Date.now()) => path.join(paths.evolve, 'signals', dayKey(ts) + '.jsonl');
export function record(kind, chatTag, text = '', extra = {}) {
  const s = { ts: Date.now(), kind, chat: chatTag, text: cut(mask(text), 80), ...extra };
  try { appendJsonl(file(s.ts), s); } catch {}
  emit('signal', { kind, chat: chatTag });
  return s;
}
export function readDay(day) { return readJsonl(path.join(paths.evolve, 'signals', day + '.jsonl')); }

const lastSaid = new Map();     // chatTag -> { text, ts }
const lastKill = new Map();     // chatTag -> ts
export function onUserText(chatTag, said) {
  const s = String(said || '').trim();
  if (!s || s.startsWith('/')) return;
  if (COMPLAINT_RE.test(s) && s.length <= 60) record('complaint', chatTag, s);
  if (NOISY_RE.test(s) && s.length <= 30) record('noisy', chatTag, s);
  const prev = lastSaid.get(chatTag);
  if (prev && prev.text === s && s.length >= 4 && Date.now() - prev.ts < 180000) record('retry', chatTag, s);
  lastSaid.set(chatTag, { text: s, ts: Date.now() });
  const k = lastKill.get(chatTag);
  if (k && RESUME_RE.test(s) && Date.now() - k < 30 * 60000) { record('resume_after_kill', chatTag, s); lastKill.delete(chatTag); }
}

export function start() {
  on('topic.misroute', (e) => record('misroute', e.chat));
  on('stop.done', (e) => { if (e.ok) record('stop', e.chat); });
  on('turn.empty', (e) => { if (e.killedBy) { record('kill', e.chat, '', { by: e.killedBy }); lastKill.set(e.chat, Date.now()); } });
  on('turn.error', (e) => record('error', e.chat, e.error || ''));
}
