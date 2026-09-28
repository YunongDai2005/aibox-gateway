// 自进化的纯逻辑单元测试：调参护栏、回滚、信号检测、提案生命周期、复盘报告
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-evo-'));
const home = path.join(tmp, 'home'), root = path.join(home, 'wx-router');
fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(path.join(home, 'bin'), { recursive: true }); fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
fs.writeFileSync(path.join(home, '.dsh/.credentials.yaml'), 'OPENCODE_GO_API_KEY: k\n');
// 假模型：复盘提案
const llm = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ output_text: JSON.stringify({ proposals: [{ title: '话题判定加例子', problem: '切错 3 次', change: 'topics 插件', kind: 'prompt', risk: '低', verify: '回放', expected: '少切错' }] }) }));
});
await new Promise((r) => llm.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ threadTh: { switchSure: 0.75 }, llm: { goBase: 'http://127.0.0.1:' + llm.address().port }, evolve: { proposalMinSignals: 1 } }));
process.env.AIBOX_HOME = home; process.env.AIBOX_ROOT = root; process.env.AIBOX_CONFIG = path.join(root, 'config.json');

const tunables = await import('../src/evolve/tunables.mjs');
const signals = await import('../src/evolve/signals.mjs');
const proposals = await import('../src/evolve/proposals.mjs');
const retro = await import('../src/evolve/retro.mjs');
const metrics = await import('../src/observe/metrics.mjs');
const { mask } = await import('../src/core/log.mjs');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('✓ ' + name); };
const quiet = { misroutes: 0, resumeAfterKill: 0 };
const input = (o) => ({ misroutes: 0, noisy: 0, progressQueries: 0, resumeAfterKill: 0, quietDays: quiet, ...o });

t('切错 ≥2 次 → 话题门槛 +0.02（从主人的 0.75 起）', () => {
  const ch = tunables.tune(input({ misroutes: 2 }));
  const k = ch.find((c) => c.key === 'threadTh.switchSure');
  assert.equal(k.from, 0.75); assert.equal(k.to, 0.77);
});
t('一直切错也不会超过上限 0.92', () => {
  for (let i = 0; i < 20; i++) tunables.tune(input({ misroutes: 5 }));
  assert.equal(tunables.currentValue(tunables.TUNABLES[0]), 0.92);
});
t('一周没切错 → 慢慢回到基准，但不越过基准', () => {
  for (let i = 0; i < 30; i++) tunables.tune(input({ quietDays: { misroutes: 7, resumeAfterKill: 0 } }));
  assert.equal(tunables.currentValue(tunables.TUNABLES[0]), 0.75);
});
t('嫌吵 → 播报间隔变长；常问进度 → 变短', () => {
  tunables.tune(input({ noisy: 1 }));
  assert.equal(tunables.currentValue(tunables.TUNABLES.find((x) => x.key === 'progressEveryMs')), 300000);
  tunables.tune(input({ progressQueries: 3 }));
  assert.equal(tunables.currentValue(tunables.TUNABLES.find((x) => x.key === 'progressEveryMs')), 240000);
});
t('回滚最近一次 L1 改动', () => {
  tunables.tune(input({ resumeAfterKill: 1 }));
  const k = tunables.TUNABLES.find((x) => x.key === 'dshIdleMs');
  assert.equal(tunables.currentValue(k), 840000);
  const r = tunables.rollbackLast('测试');
  assert.equal(r.key, 'dshIdleMs');
  assert.equal(tunables.currentValue(k), 720000);
});
t('全部回滚', () => { tunables.tune(input({ misroutes: 3 })); tunables.resetAll(); assert.deepEqual(tunables.state().values, {}); });

t('信号：抱怨、嫌吵、重发、停后又让继续', () => {
  signals.start();
  signals.onUserText('abc', '不对，不是这个');
  signals.onUserText('abc', '别刷屏了');
  signals.onUserText('abc', '帮我查下日志');
  signals.onUserText('abc', '帮我查下日志');
  const day = signals.readDay(metrics.dayKey());
  const kinds = day.map((x) => x.kind);
  assert.ok(kinds.includes('complaint') && kinds.includes('noisy') && kinds.includes('retry'), kinds.join(','));
});
t('打码：密码/令牌不进信号样本', () => {
  assert.equal(mask('密码是 hunter2abc'), '密码是 hunter2abc'.replace('hunter2abc', 'hunter2abc'));   // 没有 "密码:" 形式的不误伤
  assert.match(mask('password: hunter2'), /password: \*\*\*/);
  assert.match(mask('token sk_live_ABCDEF1234567890XYZ'), /\*\*\*/); // gitleaks:allow -- synthetic redaction test fixture, not a credential
});

t('提案：新增 / 列表 / 否决', () => {
  const p = proposals.add({ title: '测试', problem: 'p', change: 'c', kind: 'code', risk: '低' });
  assert.equal(p.id, '0001');
  assert.equal(proposals.list().length, 1);
  proposals.reject(1);
  assert.equal(proposals.get(1).status, 'rejected');
});
t('提案：批准 → 外援开工 → 做完测试通过 → ready', () => {
  // 假 helper：打印启动成功；假 WorkTree：里面的 test/run.mjs 直接通过
  const hb = path.join(home, 'bin/helper');
  fs.writeFileSync(hb, '#!/bin/sh\necho "🤖 自动选择：Claude"\necho "已启动外援任务 c-test-01 · Claude：x"\n'); fs.chmodSync(hb, 0o755);
  const p = proposals.add({ title: '第二个', problem: 'p', change: 'c', kind: 'code', risk: '低' });
  const r = proposals.approve(p.id);
  assert.ok(r.ok, r.msg);
  assert.equal(proposals.get(p.id).status, 'building');
  const wt = path.join(tmp, 'wt'); fs.mkdirSync(path.join(wt, 'test'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'test/run.mjs'), 'console.log("5 通过，0 失败")');
  const jd = path.join(home, '.aibox/helper-jobs/c-test-01'); fs.mkdirSync(jd, { recursive: true });
  fs.writeFileSync(path.join(jd, 'meta.json'), JSON.stringify({ status: 'done', changed: true, wt, diffstat: '1 file changed' }));
  const said = [];
  proposals.poll((x) => said.push(x));
  assert.equal(proposals.get(p.id).status, 'ready');
  assert.match(said[0], /测试全过（5 项）/);
});
t('上线：工人忙时拒绝', () => {
  const r = proposals.ship(2, { idle: () => false });
  assert.equal(r.ok, false); assert.match(r.msg, /工人正在干活/);
});

// 复盘：伪造昨天的数据
const y = metrics.dayKey(Date.now() - 86400e3);
fs.mkdirSync(path.join(home, '.aibox/evolve/metrics'), { recursive: true });
fs.writeFileSync(path.join(home, '.aibox/evolve/metrics', y + '.json'), JSON.stringify({ day: y, counters: { 'turn.done': 8, 'turn.empty': 2, 'topic.misroute': 3 }, dist: { 'turn.ms': [1000, 5000] } }));
fs.writeFileSync(path.join(home, '.aibox/evolve/signals', y + '.jsonl'), '{"kind":"misroute","chat":"a"}\n{"kind":"complaint","chat":"a","text":"不对"}\n');
const r = await retro.runRetro(null, { day: y });
assert.equal(r.changes.find((c) => c.key === 'threadTh.switchSure').to, 0.77);
assert.equal(r.props.length, 1);
assert.match(r.md, /# 复盘/); assert.match(r.md, /成功率 \| 80%/);
assert.ok(fs.existsSync(path.join(home, '.aibox/evolve/reports', y + '.md')));
n++; console.log('✓ 复盘：报告 + L1 调参 + L2 提案');

llm.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n自进化单元测试 ' + n + ' 项全过');
process.exit(0);
