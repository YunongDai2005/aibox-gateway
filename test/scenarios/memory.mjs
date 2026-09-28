// 记忆：会话交接、回忆目录、外援提醒、上下文水位
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const preset = (env, meta) => {
  env.writeJson('wx-router/modes.json', { wxid_owner: 'dsh' });
  env.writeJson('wx-router/dsh-sessions.json', { wxid_owner: 'sess-old' });
  env.writeJson('wx-router/dsh-session-meta.json', { wxid_owner: { sid: 'sess-old', startedAt: Date.now(), msgCount: 5, lastMsgAt: Date.now(), ...meta } });
};
const INDEX = '# 交接目录\n\n| # | 时间 | 标题 | 关键词 | 文件 |\n|---|---|---|---|---|\n| 0001 | 2026-09-27 10:00 | 修好 wx-router 看门狗 | wx-router, 看门狗 | [0001](0001-20260927-1000-daily.md) |\n| 0002 | 2026-09-28 11:00 | 装知识库 | kb, 知识库 | [0002](0002-20260928-1100-idle.md) |\n';

export default [
  {
    name: '上下文到预算 → 先做交接包，再开新会话注入，成功回复后消费',
    setup: (env) => preset(env, { ctxIn: 200000 }),
    async run(env) {
      await env.say('接着干');
      await env.waitText('🆕 DSH 换了新会话（会话上下文快满了）');
      await env.waitText('ECHO:接着干', { timeout: 10000 });
      await env.idle();
      const calls = env.dshCalls();
      assert.ok(calls[0].task.startsWith('请把当前整个会话压缩成一份"交接包"'), '第一步是生成交接包');
      assert.equal(calls[0].sid, 'sess-old');
      assert.equal(calls[1].sid, null, '新会话');
      assert.match(calls[1].task, /【上一会话交接包/);
      const meta = env.readJson('wx-router/dsh-session-meta.json').wxid_owner;
      assert.ok(!meta.pendingHandoff, '交接包已消费');
      const files = fs.readdirSync(env.file('dsh-work/handoffs')).filter((f) => /^\d{4}-/.test(f));
      assert.equal(files.length, 1, '交接包落盘进存档链');
    },
  },
  {
    name: '跨过凌晨 4 点 → 日切交接',
    setup: (env) => preset(env, { startedAt: Date.now() - 2 * 86400e3 }),
    async run(env) {
      await env.say('早上好');
      await env.waitText('🆕 DSH 换了新会话（新的一天）');
      await env.waitText('ECHO:早上好', { timeout: 10000 });
    },
  },
  {
    name: '会话太短（<3 条）不花 token 做交接，直接冷切',
    setup: (env) => preset(env, { ctxIn: 200000, msgCount: 1 }),
    async run(env) {
      await env.say('继续');
      await env.waitText('旧对话不带入');
      await env.waitText('ECHO:继续', { timeout: 10000 });
      assert.ok(!env.dshCalls()[0].task.startsWith('请把当前整个会话压缩'));
    },
  },
  {
    name: '新会话首条附交接目录 + 预筛最像的几份',
    setup: (env) => { fs.writeFileSync(env.file('dsh-work/handoffs/INDEX.md'), INDEX); },
    async run(env) {
      await env.say('/dsh'); await env.waitText('已切换');
      await env.say('看门狗那个还好吗');
      await env.waitCalls(1);
      const task = env.dshCalls()[0].task;
      assert.match(task, /【交接目录 — 系统自动附上（新会话）/);
      assert.match(task, /系统预筛[\s\S]*0001-20260927-1000-daily\.md/);
    },
  },
  {
    name: '老会话里提到以前的事 → 附目录；普通消息不附',
    setup: (env) => { preset(env, {}); fs.writeFileSync(env.file('dsh-work/handoffs/INDEX.md'), INDEX); },
    async run(env) {
      await env.say('今天天气怎样'); await env.waitText('ECHO:今天天气怎样'); await env.idle();
      assert.ok(!env.dshCalls()[0].task.includes('【交接目录'));
      await env.say('上次那个知识库弄好了吗'); await env.waitCalls(2);
      assert.match(env.dshCalls()[1].task, /你提到了以前的事/);
    },
  },
  {
    name: '外援做完没取走 → 下一轮开头提醒一次',
    setup: (env) => {
      preset(env, {});
      const d = env.file('.aibox/helper-jobs/c-0929-120000-ab');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ id: 'c-0929-120000-ab', helper: 'claude', status: 'done', title: '查资料', endedAt: new Date().toISOString() }));
    },
    async run(env) {
      await env.say('在吗'); await env.waitText('ECHO:在吗'); await env.idle();
      assert.match(env.dshCalls()[0].task, /【外援任务 — 系统自动附上】[\s\S]*c-0929-120000-ab/);
      await env.say('再问一句'); await env.waitText('ECHO:再问一句');
      assert.ok(!env.dshCalls()[1].task.includes('【外援任务'), '只提醒一次');
    },
  },
  {
    name: '上下文用到 85% → 提醒一次',
    setup: (env) => preset(env, {}),
    async run(env) {
      await env.say('干活 #usage=140000');
      await env.waitText('上下文用到 88%');
      await env.idle();
      await env.say('再干 #usage=145000'); await env.waitText('ECHO:再干');
      await env.idle();
      assert.equal(env.texts().filter((t) => t.includes('上下文用到')).length, 1, '只提醒一次');
    },
  },
];
