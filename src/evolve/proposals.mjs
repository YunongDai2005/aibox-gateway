/**
 * L2 改进提案的生命周期（每一步主人都看得到，关键两步必须主人点头）：
 *
 *   proposed ──/批准 N──▶ building ──外援做完+测试通过──▶ ready ──/上线 N──▶ shipped
 *       │                    │                              │
 *   /否决 N              failed / test_failed           /否决 N（丢弃分支）
 *
 *   building：helper 在 WorkTree（分支 helper/<编号>）里实现，不碰正在跑的代码
 *   ready：   在 WorkTree 里跑过 test/run.mjs 全部通过
 *   shipped： 合并进主目录，再跑一遍测试，通过后由看门狗安全重启（不健康自动回滚）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { paths, APP_DIR } from '../core/config.mjs';
import { log, emit, cut } from '../core/log.mjs';
import { readJson, writeJson } from '../core/store.mjs';

const dir = () => path.join(paths.evolve, 'proposals');
const file = (id) => path.join(dir(), id + '.json');
const pad = (n) => String(n).padStart(4, '0');

export function list() {
  try { return fs.readdirSync(dir()).filter((f) => /^\d{4}\.json$/.test(f)).sort().map((f) => readJson(path.join(dir(), f), null)).filter(Boolean); } catch { return []; }
}
export function get(id) { return readJson(file(pad(Number(id))), null); }
function put(p) { writeJson(file(p.id), p); return p; }
function patch(id, x) { const p = get(id); if (!p) return null; return put({ ...p, ...x, history: [...(p.history || []), { at: Date.now(), status: x.status || p.status, note: x.note || '' }] }); }

export function add(p) {
  const n = list().reduce((m, x) => Math.max(m, Number(x.id)), 0) + 1;
  const id = pad(n);
  const clean = {
    id, status: 'proposed', createdAt: Date.now(), day: p.day,
    title: cut(p.title, 40), problem: cut(p.problem, 400), change: cut(p.change, 600), kind: ['code', 'prompt', 'config'].includes(p.kind) ? p.kind : 'code',
    risk: ['低', '中', '高'].includes(p.risk) ? p.risk : '中', verify: cut(p.verify, 300), expected: cut(p.expected, 200), evidence: p.evidence || {},
    history: [{ at: Date.now(), status: 'proposed' }],
  };
  put(clean);
  emit('evolve.proposal', { id, kind: clean.kind, risk: clean.risk });
  return clean;
}

function helperBin() {
  const a = path.join(paths.bin, 'helper');
  if (fs.existsSync(a)) return [a];
  return [process.execPath, path.join(paths.bin, 'helper.mjs')];
}

export function taskText(p) {
  return `# 网关自进化 #${p.id}：${p.title}

你在网关代码仓库的一个独立工作副本（WorkTree）里干活，改动不会影响正在跑的网关。

## 要解决的问题
${p.problem}

## 建议的改法
${p.change}

## 怎么验证
${p.verify}

## 要求
1. 先读 README.md 和 docs/ARCHITECTURE.md，按插件结构改；能在插件里改就别动核心（src/core、src/agent）。
2. 改完必须跑 \`node test/run.mjs\`，全部通过；给这个改动补一个回放测试场景（test/scenarios/）。
3. 不许：改安全规则（stop-rules）、扩大工人权限、删数据、动凭证、改 config.json 里主人的设置。
4. 不要 merge、不要重启服务 —— 主人会在微信里用 /上线 ${Number(p.id)} 决定。
5. 最后用 3~5 句话总结改了什么、测试结果。
`;
}

export function approve(id) {
  const p = get(id);
  if (!p) return { ok: false, msg: '没有这个提案' };
  if (p.status !== 'proposed') return { ok: false, msg: '这个提案现在是「' + p.status + '」，不能批准' };
  const tf = path.join(dir(), p.id + '-task.md');
  fs.writeFileSync(tf, taskText(p));
  const [bin, ...pre] = helperBin();
  const r = spawnSync(bin, [...pre, 'start', 'auto', '--work', '--repo', APP_DIR, '--hard', '--title', '网关进化#' + Number(p.id) + ' ' + p.title, '--file', tf], { encoding: 'utf8', timeout: 120000, env: { ...process.env } });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/已启动外援任务 (\S+)/);
  if (!m) { patch(id, { status: 'failed', note: '外援没启动：' + cut(out, 200) }); log('evolve approve FAILED #' + p.id + ' ' + cut(out, 200)); return { ok: false, msg: '外援没启动起来：' + cut(out, 120) }; }
  patch(id, { status: 'building', jobId: m[1], note: cut(out.split('\n').find((l) => l.includes('自动选择')) || '', 120) });
  emit('evolve.approve', { id: p.id, job: m[1] });
  return { ok: true, job: m[1], msg: out.split('\n').filter((l) => /自动选择|已启动/.test(l)).join('\n') };
}

export function reject(id) {
  const p = get(id);
  if (!p) return { ok: false, msg: '没有这个提案' };
  if (p.jobId && ['building', 'ready', 'test_failed'].includes(p.status)) {
    const [bin, ...pre] = helperBin();
    spawnSync(bin, [...pre, p.status === 'building' ? 'kill' : 'discard', p.jobId], { encoding: 'utf8', timeout: 60000 });
    if (p.status === 'building') spawnSync(bin, [...pre, 'discard', p.jobId], { encoding: 'utf8', timeout: 60000 });
  }
  patch(id, { status: 'rejected' });
  emit('evolve.reject', { id: p.id });
  return { ok: true, msg: '已否决 #' + Number(p.id) };
}

export function runTests(cwd) {
  const r = spawnSync(process.execPath, ['test/run.mjs'], { cwd, encoding: 'utf8', timeout: 10 * 60000, env: { ...process.env, AIBOX_HOME: '', AIBOX_ROOT: '' } });
  const out = (r.stdout || '') + (r.stderr || '');
  const sum = (out.match(/(\d+) 通过.*?(\d+) 失败/) || []);
  return { ok: r.status === 0, out: cut(out.split('\n').slice(-6).join(' '), 300), passed: Number(sum[1] || 0), failed: Number(sum[2] || 0) };
}

// 定时推进：building 的看外援做完没 → 在它的 WorkTree 里跑测试
export function poll(notify) {
  for (const p of list().filter((x) => x.status === 'building')) {
    const m = readJson(path.join(paths.helperJobs, p.jobId, 'meta.json'), null);
    if (!m || m.status === 'running') continue;
    if (m.status !== 'done' || !m.changed) {
      patch(p.id, { status: 'failed', note: m.status !== 'done' ? '外援失败：' + cut(m.error, 120) : '外援没改任何文件' });
      notify('🧬 进化 #' + Number(p.id) + '「' + p.title + '」没做成：' + (m.status !== 'done' ? cut(m.error, 80) : '外援没改任何文件') + '。');
      continue;
    }
    const t = runTests(m.wt);
    if (t.ok) {
      patch(p.id, { status: 'ready', diffstat: m.diffstat, tests: t });
      notify('🧬 进化 #' + Number(p.id) + '「' + p.title + '」做好了，测试全过（' + t.passed + ' 项）。\n改动：' + cut(m.diffstat, 160) + '\n发 /上线 ' + Number(p.id) + ' 合并并安全重启；不要就 /否决 ' + Number(p.id) + '。');
    } else {
      patch(p.id, { status: 'test_failed', diffstat: m.diffstat, tests: t });
      notify('🧬 进化 #' + Number(p.id) + '「' + p.title + '」做完了但测试没过（' + t.failed + ' 项失败），不会上线。\n' + t.out);
    }
  }
}

// 上线：合并 → 主目录再测一遍 → 看门狗安全重启（不健康自动回滚）
export function ship(id, { idle }) {
  const p = get(id);
  if (!p) return { ok: false, msg: '没有这个提案' };
  if (p.status !== 'ready') return { ok: false, msg: '#' + Number(p.id) + ' 现在是「' + p.status + '」，只有测试通过（ready）的才能上线' };
  if (!idle()) return { ok: false, msg: '工人正在干活，重启会打断它。等它做完再发 /上线 ' + Number(p.id) + '。' };
  const git = (...a) => spawnSync('git', ['-C', APP_DIR, ...a], { encoding: 'utf8' });
  const before = git('rev-parse', 'HEAD').stdout.trim();
  const [bin, ...pre] = helperBin();
  const r = spawnSync(bin, [...pre, 'merge', p.jobId], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0 || /冲突|✕/.test(r.stdout || '')) { patch(p.id, { status: 'merge_failed', note: cut(r.stdout + r.stderr, 200) }); return { ok: false, msg: '合并失败（主目录没动）：' + cut(r.stdout, 120) }; }
  const t = runTests(APP_DIR);
  if (!t.ok) {
    git('reset', '--hard', before);
    patch(p.id, { status: 'test_failed', note: '合并后主目录测试没过，已退回 ' + before.slice(0, 7), tests: t });
    return { ok: false, msg: '合并后测试没过，已自动退回，服务没重启。' + t.out };
  }
  const script = path.join(paths.bin, 'wx-router-restart-now.sh');
  try { spawn('systemd-run', ['--user', '--collect', '--quiet', '--unit=wx-router-evolve-' + Date.now(), script], { detached: true, stdio: 'ignore' }).unref(); } catch (e) { return { ok: false, msg: '合并好了，但没法安排重启：' + e.message }; }
  patch(p.id, { status: 'shipped', shippedAt: Date.now(), from: before });
  emit('evolve.ship', { id: p.id });
  return { ok: true, msg: '✅ 已合并，测试通过（' + t.passed + ' 项）。3 秒后安全重启，结果看门狗会单独发微信告诉你（不健康自动回滚）。' };
}
