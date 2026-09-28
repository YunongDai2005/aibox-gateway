/**
 * 每个聊天一条显式队列：普通任务尾插，改向重跑/撤回重答用 priority 插队首。
 * 同一聊天同一时刻只跑一个任务（不能并发写同一个 DSH 会话）。
 * 任务抛错只记日志，绝不冒泡成 unhandledRejection 把进程带走。
 */
import { log } from '../core/log.mjs';

const queues = new Map(); // chat -> { running, items: [{fn, resolve, reject}] }

export function enqueue(chat, fn, opts) {
  let q = queues.get(chat);
  if (!q) { q = { running: false, items: [] }; queues.set(chat, q); }
  const p = new Promise((resolve, reject) => {
    const item = { fn, resolve, reject };
    if (opts && opts.priority) q.items.unshift(item);
    else q.items.push(item);
    pump(chat);
  });
  return p.catch((e) => { log('enqueueChat 任务异常 ' + chat + '：' + String((e && e.stack) || e)); });
}

function pump(chat) {
  const q = queues.get(chat);
  if (!q || q.running) return;
  const item = q.items.shift();
  if (!item) return;
  q.running = true;
  Promise.resolve()
    .then(() => item.fn())
    .then((v) => item.resolve(v), (e) => item.reject(e))
    .finally(() => {
      q.running = false;
      if (!q.items.length && !q.running) queues.delete(chat);
      else pump(chat);
    });
}

export function queueState(chat) { const q = queues.get(chat); return q ? { running: q.running, waiting: q.items.length } : { running: false, waiting: 0 }; }
export function queueBusy(chat) { const q = queues.get(chat); return !!(q && (q.running || q.items.length)); }
export function allQueues() { return [...queues.entries()].map(([chat, q]) => ({ chat, running: q.running, waiting: q.items.length })); }
