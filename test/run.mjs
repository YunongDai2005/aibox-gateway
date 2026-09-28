#!/usr/bin/env node
/**
 * 跑回放测试。  node test/run.mjs [--engine v2|v1|both] [--only 关键词] [-j 并发]
 * 默认只跑 v2（新引擎）；--engine both 同时跑老引擎做对照（标了 v1:false 的场景跳过）。
 * 退出码：0 全过，1 有失败。自进化上线前必须全过。
 */
import { startEnv, APP_DIR } from './harness.mjs';
import core from './scenarios/core.mjs';
import interaction from './scenarios/interaction.mjs';
import memory from './scenarios/memory.mjs';
import product from './scenarios/product.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const engines = opt('--engine', 'v2') === 'both' ? ['v2', 'v1'] : [opt('--engine', 'v2')];
const only = opt('--only', '');
const J = Number(opt('-j', '4'));
const all = [...core, ...interaction, ...memory, ...product].filter((s) => !only || s.name.includes(only));

const jobs = [];
for (const engine of engines) for (const s of all) if (!(engine === 'v1' && s.v1 === false)) jobs.push({ engine, s });

async function runOne({ engine, s }) {
  const t0 = Date.now();
  if (s.noStart) {
    try { await s.run(null, { startEnv: (o) => startEnv({ engine, ...o }) }); return { ok: true, ms: Date.now() - t0 }; }
    catch (e) { return { ok: false, ms: Date.now() - t0, err: e.message }; }
  }
  let env;
  try {
    env = await startEnv({ engine, config: s.config, setup: s.setup, llmRules: s.llmRules });
    env.appDir = APP_DIR;
    await s.run(env, { startEnv });
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.message, detail: env ? '\n    发出的消息：' + JSON.stringify(env.texts()).slice(0, 600) + '\n    DSH 调用：' + env.dshCalls().length + '\n    日志尾：' + env.log().split('\n').slice(-8).join('\n      ') + (env.stderr ? '\n    stderr：' + env.stderr.slice(-400) : '') : '' };
  } finally {
    if (env) { await env.stop(); if (!process.env.KEEP_TMP) env.cleanup(); }
  }
}

// 纯逻辑单元测试（自测脚本）
const unit = [
  ['话题路由离线自测', [path.join(APP_DIR, 'test/threads-selftest.mjs')]],
  ['自进化单元测试', [path.join(APP_DIR, 'test/unit-evolve.mjs')]],
];
let pass = 0, fail = 0;
for (const [name, a] of unit) {
  if (only && !name.includes(only)) continue;
  const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 120000, env: { ...process.env } });
  if (r.status === 0) { pass++; console.log('✓ [unit] ' + name); }
  else { fail++; console.log('✗ [unit] ' + name + '\n    ' + ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-12).join('\n    ')); }
}

const results = new Array(jobs.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(J, jobs.length) }, async () => {
  while (next < jobs.length) {
    const i = next++;
    results[i] = await runOne(jobs[i]);
    const { engine, s } = jobs[i], r = results[i];
    console.log((r.ok ? '✓' : '✗') + ' [' + engine + '] ' + s.name + '  ' + (r.ms / 1000).toFixed(1) + 's' + (r.ok ? '' : '\n    ' + r.err + (r.detail || '')));
  }
}));
for (const r of results) r.ok ? pass++ : fail++;
console.log('\n' + pass + ' 通过，' + fail + ' 失败');
process.exit(fail ? 1 : 0);
