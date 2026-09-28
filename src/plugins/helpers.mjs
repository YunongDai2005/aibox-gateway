/**
 * 外援提醒：helper 启动的外援（Claude / GPT / Go 顾问）脱离 DSH 运行，DSH 这一轮结束后才做完的结果没人看。
 * 下一轮开头由网关（代码，不靠模型记得）告诉它：做完没取走的（每个只提醒一次）、还在跑的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../core/config.mjs';
import { log, emit, tag } from '../core/log.mjs';

const WHO = { gpt: 'GPT', claude: 'Claude', go: 'Go 顾问' };

export function listJobs(limit = 30) {
  let ids = [];
  try { ids = fs.readdirSync(paths.helperJobs).sort().reverse().slice(0, limit); } catch { return []; }
  const out = [];
  for (const id of ids) {
    const p = path.join(paths.helperJobs, id, 'meta.json');
    try { out.push({ id, p, m: JSON.parse(fs.readFileSync(p, 'utf8')) }); } catch {}
  }
  return out;
}

export function helperNote() {
  const done = [], running = [];
  for (const { id, p, m } of listJobs()) {
    const who = (m.helper === 'gpt' ? 'GPT' : m.helper === 'go' ? 'Go 顾问' : 'Claude') + (m.work ? '（干活）' : '（顾问）');
    if (m.status === 'running') running.push('- ' + id + ' ' + who + ' 还在跑：' + m.title + ' → helper status ' + id);
    else if (!m.delivered && !m.announced && Date.parse(m.endedAt || 0) > Date.now() - 3 * 86400e3) {
      done.push('- ' + id + ' ' + who + (m.status === 'done' ? ' ✓ 做完了' : ' ✕ ' + m.status) + '：' + m.title + ' → helper result ' + id);
      try { fs.writeFileSync(p, JSON.stringify({ ...m, announced: true }, null, 2)); } catch {}
    }
  }
  if (!done.length && !running.length) return '';
  return '【外援任务 — 系统自动附上】\n' + (done.length ? '上一轮之后做完、结果还没看的（先看结果再回答主人）：\n' + done.join('\n') + '\n' : '') +
    (running.length ? '还在后台跑的：\n' + running.join('\n') + '\n' : '') + '（别在回复里复述这段）\n\n';
}

// 经理用：一句话说清外援在跑什么
export function helperBrief() {
  const run = listJobs(200).map((x) => x.m).filter((m) => m.status === 'running');
  return run.length ? '工人请的外援在跑：' + run.map((m) => (WHO[m.helper] || m.helper) + '「' + m.title + '」').join('、') : '';
}

export default {
  name: 'helpers', desc: '外援（Claude/GPT/Go）做完的结果，下一轮自动提醒工人去看',
  setup(app) {
    app.stage('context', 40, (T) => {
      const hn = helperNote();
      if (hn) { T.text = hn + T.text; log('helper note attached chat=' + T.chat + ' chars=' + hn.length); emit('helpers.noted', { chat: tag(T.chat) }); }
    });
    app.api('helpers', () => listJobs(20).map(({ id, m }) => ({ id, helper: m.helper, work: !!m.work, status: m.status, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt })));
  },
};
