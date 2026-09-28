// 核心链路：模式切换、放行、会话、去重、线路回落、会话丢失、看门狗、空回复、收发文件
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dsh = async (env) => { await env.say('/dsh'); await env.waitText('已切换'); };

export default [
  {
    name: '默认模式：消息原样放行给 OpenClaw',
    async run(env) {
      const kept = await env.say('你好 openclaw');
      assert.equal(kept.length, 1);
      assert.equal(env.dshCalls().length, 0);
    },
  },
  {
    name: '/dsh 切换 + 第一轮新会话 + 第二轮沿用会话',
    async run(env) {
      await dsh(env);
      assert.equal(env.readJson('wx-router/modes.json').wxid_owner, 'dsh');
      const kept = await env.say('第一句');
      assert.equal(kept.length, 0, 'DSH 模式的消息不该放行');
      await env.waitText('ECHO:第一句');
      await env.idle();
      const sid = env.readJson('wx-router/dsh-sessions.json').wxid_owner;
      assert.ok(sid, '会话 id 已保存');
      await env.say('第二句');
      await env.waitText('ECHO:第二句');
      const calls = env.dshCalls();
      assert.equal(calls[0].sid, null);
      assert.equal(calls.at(-1).sid, sid, '第二轮沿用同一个会话');
      const meta = env.readJson('wx-router/dsh-session-meta.json').wxid_owner;
      assert.equal(meta.sid, sid);
      assert.equal(meta.msgCount, 2);
    },
  },
  {
    name: '同一条消息推两次只处理一次（去重）',
    async run(env) {
      await dsh(env);
      const m = env.msg('重复的消息');
      await env.push(m, m);
      await env.waitText('ECHO:重复的消息');
      await env.idle();
      assert.equal(env.dshCalls().length, 1);
    },
  },
  {
    name: '/mode 回执',
    async run(env) {
      await dsh(env);
      await env.say('/mode');
      const t = await env.waitText('当前：DSH');
      assert.match(t, /会话：下一条消息新开/);
      assert.match(t, /切换：\/dsh \/ai \/local/);
    },
  },
  {
    name: '/new 开新会话，下一条不带旧 sid',
    async run(env) {
      await dsh(env);
      await env.say('先聊一句'); await env.waitText('ECHO:先聊一句'); await env.idle();
      await env.say('/new');
      await env.waitText('DSH 新会话已开');
      assert.equal(env.readJson('wx-router/dsh-sessions.json').wxid_owner, undefined);
      await env.say('新会话第一句'); await env.waitText('ECHO:新会话第一句');
      assert.equal(env.dshCalls().at(-1).sid, null);
    },
  },
  {
    name: 'Go 额度满 → 提示并走 DeepSeek 重试',
    async run(env) {
      await dsh(env);
      await env.say('跑个任务 #quota');
      await env.waitText('Go 额度用完');
      await env.waitText('ECHO:跑个任务');
      const calls = env.dshCalls();
      assert.equal(calls.length, 2);
      assert.equal(calls[0].fallback, false);
      assert.equal(calls[1].fallback, true);
      assert.ok(env.readJson('wx-router/go-state.json').cooldownUntil > Date.now(), '进入冷却');
    },
  },
  {
    name: '两条线路都失败 → 说清楚没返回内容',
    async run(env) {
      await dsh(env);
      await env.say('坏任务 #fail');
      const t = await env.waitText('DSH 没返回内容');
      assert.match(t, /exit=1/);
      assert.equal(env.dshCalls().length, 2);
    },
  },
  {
    name: '会话丢了 → 开新会话重试',
    async setup(env) {
      env.writeJson('wx-router/modes.json', { wxid_owner: 'dsh' });
      env.writeJson('wx-router/dsh-sessions.json', { wxid_owner: 'sess-gone' });
      env.writeJson('wx-router/dsh-session-meta.json', { wxid_owner: { sid: 'sess-gone', startedAt: Date.now(), msgCount: 1, lastMsgAt: Date.now() } });
      fs.writeFileSync(env.files.lost, 'sess-gone\n');
    },
    async run(env) {
      await env.say('还在吗');
      await env.waitText('ECHO:还在吗');
      const calls = env.dshCalls();
      assert.equal(calls[0].sid, 'sess-gone');
      assert.equal(calls.at(-1).sid, null);
      assert.notEqual(env.readJson('wx-router/dsh-sessions.json').wxid_owner, 'sess-gone');
    },
  },
  {
    name: '卡死才杀：长时间没输出被看门狗停下并说明',
    config: { dshIdleMs: 1200 },
    async run(env) {
      await dsh(env);
      await env.say('卡住的任务 #hang');
      const t = await env.waitText('DSH 被停下了', { timeout: 15000 });
      assert.match(t, /判定卡死/);
      assert.match(t, /发「继续」/);
    },
  },
  {
    name: '一直有输出的长任务不会被误杀',
    config: { dshIdleMs: 1200 },
    async run(env) {
      await dsh(env);
      await env.say('长任务 #sleep=3000');
      await env.waitText('ECHO:长任务', { timeout: 15000 });
      assert.ok(!env.texts().some((t) => t.includes('被停下')));
    },
  },
  {
    name: '发回文件：只放行工作目录里真实存在的文件',
    async setup(env) { fs.mkdirSync(env.file('dsh-work/out'), { recursive: true }); fs.writeFileSync(env.file('dsh-work/out/report.txt'), 'hi'); },
    async run(env) {
      await dsh(env);
      await env.say('发我报告 #send=out/report.txt');
      await env.waitFor(() => env.sent().find((x) => x.kind === 'file'), { what: '文件发送' });
      assert.equal(env.sent().find((x) => x.kind === 'file').file, 'report.txt');
      await env.say('发我密码 #send=../../.dsh/.credentials.yaml');
      await env.waitText('ECHO:发我密码');
      await env.idle();
      assert.equal(env.sent().filter((x) => x.kind === 'file').length, 1, '工作目录外的文件被拒');
    },
  },
  {
    name: '收图片：下载到 inbox 并告诉工人路径',
    async run(env) {
      await dsh(env);
      await env.push(env.msg('看看这张图', { image: true }));
      await env.waitCalls(1);
      const task = env.dshCalls()[0].task;
      assert.match(task, /\[用户发来一张图片：.*inbox.*\.png/);
    },
  },
  {
    name: '语音转写当作文字',
    async run(env) {
      await dsh(env);
      await env.push(env.msg(null, { voice: '语音说的话' }));
      await env.waitText('ECHO:语音说的话');
    },
  },
];
