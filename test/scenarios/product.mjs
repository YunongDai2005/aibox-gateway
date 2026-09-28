// v2 才有的产品能力：帮助、面板 API、结构化事件、插件开关、自进化
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dsh = async (env) => { await env.say('/dsh'); await env.waitText('已切换'); };
const ymd = (ts) => { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

export default [
  {
    name: '/帮助 列出所有命令', v1: false,
    async run(env) {
      await env.say('/帮助');
      const t = await env.waitText('📖 命令');
      for (const c of ['/dsh', '/进度', '/经理', '/话题', '/进化', '/new']) assert.ok(t.includes(c), '帮助里有 ' + c);
    },
  },
  {
    name: '面板 API：status / metrics / describe / events', v1: false,
    async run(env) {
      await dsh(env);
      await env.say('你好'); await env.waitText('ECHO:你好'); await env.idle();
      const st = await env.api('status');
      assert.equal(st.engine, 'v2');
      assert.ok(st.plugins.some((p) => p.name === 'manager'));
      const m = await env.api('metrics');
      assert.equal(m.today.ok, 1);
      assert.ok(m.today.msgs >= 1);
      const d = await env.api('describe');
      assert.ok(d.stages.context.length >= 3, '上下文阶段挂了多个插件');
      const ev = await env.api('events');
      assert.ok(ev.some((e) => e.type === 'turn.done'));
      const topics = await env.api('topics');
      assert.equal(topics[0].chat, 'wxid_o', '聊天 id 只露前 6 位');
    },
  },
  {
    name: '结构化事件不含对话原文', v1: false,
    async run(env) {
      await dsh(env);
      await env.say('我的秘密内容 ABC'); await env.waitText('ECHO:我的秘密内容'); await env.idle();
      const raw = fs.readFileSync(env.file('.aibox/logs/events.jsonl'), 'utf8');
      assert.ok(!raw.includes('我的秘密内容'), '事件日志里没有原文');
      assert.ok(!raw.includes('wxid_owner'), '事件日志里没有完整聊天 id');
    },
  },
  {
    name: '插件开关：关掉 manager 后干活时的话走改方向', v1: false,
    config: { features: { manager: false } },
    async run(env) {
      await dsh(env);
      const st = await env.api('status');
      assert.ok(!st.plugins.some((p) => p.name === 'manager'));
      await env.say('长任务 #sleep=4000');
      await env.waitFor(() => (env.readJson('wx-router/dsh-live.json', { running: [] }).running || []).length, { what: '开始干活' });
      await new Promise((r) => setTimeout(r, 300));
      await env.say('补充：顺便加个标题');
      await env.waitText(/🔁 收到|📥 收到/);
      assert.ok(!env.texts().some((t) => t.startsWith('🧑‍💼')));
    },
  },
  {
    name: '配置写错 → 拒绝启动（看门狗会回滚）', v1: false, noStart: true,
    async run(_env, { startEnv }) {
      await assert.rejects(() => startEnv({ config: { dshIdleMs: 'abc' } }), /网关启动|配置/);
    },
  },
  {
    name: '自进化：抱怨/重发被记成信号，/进化 能看', v1: false,
    async run(env) {
      await dsh(env);
      await env.say('帮我查一下日志'); await env.waitText('ECHO:帮我查一下日志'); await env.idle();
      await env.say('不对，不是这个'); await env.waitText('ECHO:不对'); await env.idle();
      await env.say('不对，不是这个'); await env.waitText(/ECHO:不对/); await env.idle();
      const sig = fs.readFileSync(env.file('.aibox/evolve/signals/' + ymd(Date.now()) + '.jsonl'), 'utf8');
      assert.match(sig, /"kind":"complaint"/);
      assert.match(sig, /"kind":"retry"/);
      await env.say('/进化');
      await env.waitText('🧬');
    },
  },
  {
    name: '自进化：/复盘 → L1 调参（切错多 → 更谨慎）→ /回滚调参', v1: false,
    async setup(env) {
      // 伪造"昨天"的指标和信号：切错了 3 次、抱怨 3 次
      const y = ymd(Date.now() - 86400e3);
      env.writeJson('.aibox/evolve/metrics/' + y + '.json', { day: y, counters: { 'msg.in': 20, 'turn.done': 10, 'topic.misroute': 3, 'signal.complaint': 3, 'signal.misroute': 3 }, dist: { 'turn.ms': [1000, 2000, 30000] } });
      const lines = ['misroute', 'misroute', 'misroute', 'complaint', 'complaint', 'complaint'].map((k, i) => JSON.stringify({ ts: Date.now() - 86400e3 + i, kind: k, chat: 'wxid_o', text: k === 'complaint' ? '不对不是这个' : '' }));
      fs.mkdirSync(env.file('.aibox/evolve/signals'), { recursive: true });
      fs.writeFileSync(env.file('.aibox/evolve/signals/' + y + '.jsonl'), lines.join('\n') + '\n');
    },
    config: { evolve: { retroHour: 0, proposalMinSignals: 3 } },
    async run(env) {
      // 定时器 10 分钟一次太慢：/复盘 和定时器走同一个函数（只是不请模型写提案）
      await env.say('/复盘');
      const t = await env.waitText('# 复盘', { timeout: 10000 });
      assert.match(t, /threadTh\.switchSure` 0\.75 → 0\.77/);
      const tun = env.readJson('wx-router/tunables.json');
      assert.equal(tun.values.threadTh.switchSure, 0.77);
      await env.say('/回滚调参');
      await env.waitText('已把自动调过的参数全部退回');
      assert.deepEqual(env.readJson('wx-router/tunables.json').values, {});
    },
  },
];
