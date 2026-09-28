// 干活途中的交互：叫停、经理、改方向、进度、话题
import assert from 'node:assert/strict';

const dsh = async (env) => { await env.say('/dsh'); await env.waitText('已切换'); };
const busy = async (env, task = '长任务 #sleep=4000') => {
  const callsBefore = env.dshCalls().length;
  await env.say(task);
  await env.waitFor(() => (env.readJson('wx-router/dsh-live.json', { running: [] }).running || []).length, { what: '工人开始干活' });
  await env.waitCalls(callsBefore + 1);
};

export default [
  {
    name: '说「停」立刻停下，旧回复不发',
    async run(env) {
      await dsh(env);
      await busy(env);
      await env.say('停');
      await env.waitText('⛔ 停了');
      await env.idle();
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(!env.texts().some((t) => t.startsWith('ECHO:长任务')), '被停的任务不该再回复');
      assert.equal(env.dshCalls().length, 1, '停下后不重跑');
    },
  },
  {
    name: '语音说「停」也能停',
    async run(env) {
      await dsh(env);
      await busy(env);
      await env.push(env.msg(null, { voice: '停下' }));
      await env.waitText('⛔ 停了');
    },
  },
  {
    name: '空闲时说「停」不会被当成叫停',
    async run(env) {
      await dsh(env);
      await env.say('停');
      await env.waitText('ECHO:停');
    },
  },
  {
    name: '经理：干活时补一句 → 经理秒回、进信箱、做完后补交给工人',
    async run(env) {
      await dsh(env);
      await busy(env, '长任务 #sleep=2500');
      await env.say('顺便把结果做成表格');
      await env.waitText('🧑‍💼 好，我转告它');
      await env.waitText('ECHO:长任务', { timeout: 10000 });
      await env.waitFor(() => env.dshCalls().find((c) => c.task.includes('【你刚才干活时主人说的话')), { timeout: 20000, what: '信箱补交' });
      const c = env.dshCalls().find((x) => x.task.includes('【你刚才干活时主人说的话'));
      assert.match(c.task, /顺便把结果做成表格/);
    },
  },
  {
    name: '经理：方向错了 → 打断并在原会话里按新要求改',
    async run(env) {
      await dsh(env);
      await env.say('先建个会话'); await env.waitText('ECHO:先建个会话'); await env.idle();
      await busy(env, '长任务 #sleep=5000');
      await env.say('不对，要用红色');
      await env.waitText('🧑‍💼 好，我让它按新要求改');
      await env.waitFor(() => env.dshCalls().find((c) => c.task.includes('[用户在你执行任务的过程中插话]')), { timeout: 10000, what: '改向重跑' });
      await env.waitText('ECHO:不对，要用红色', { timeout: 10000 });
      const calls = env.dshCalls();
      const redo = calls.find((c) => c.task.includes('[用户在你执行任务的过程中插话]'));
      assert.equal(redo.sid, calls[0].sid ?? calls[1].sid, '沿用原会话');
      assert.ok(!env.texts().some((t) => t.startsWith('ECHO:长任务')), '被打断的旧回复不发');
    },
  },
  {
    name: '经理：问进度 → 只回答不打扰工人',
    async run(env) {
      await dsh(env);
      await busy(env, '长任务 #sleep=2000');
      await env.say('现在怎么样了');
      await env.waitText('🧑‍💼 它还在做');
      await env.waitText('ECHO:长任务', { timeout: 10000 });
      await env.idle();
      assert.equal(env.dshCalls().length, 1);
    },
  },
  {
    name: '经理联系不上 → 这句排队，不丢',
    llmRules: { manager: () => 'ERROR' },
    async run(env) {
      await dsh(env);
      await busy(env, '长任务 #sleep=1500');
      await env.say('做完再帮我看个东西');
      await env.waitText('经理暂时联系不上');
      await env.waitText('ECHO:做完再帮我看个东西', { timeout: 15000 });
    },
  },
  {
    name: '经理下班时：补充走改方向（打断 + 带新要求重跑）',
    async run(env) {
      await dsh(env);
      await env.say('/经理关'); await env.waitText('经理下班了');
      await busy(env, '长任务 #sleep=5000');
      await env.say('补充：要用红色');
      await env.waitText(/🔁 收到，接着改|📥 收到，紧接着执行/);
      await env.waitFor(() => env.dshCalls().find((c) => c.task.includes('[用户在你执行任务的过程中插话]')), { timeout: 10000, what: '改向重跑' });
      await env.waitText('ECHO:补充：要用红色', { timeout: 10000 });
    },
  },
  {
    name: '进度播报：45 秒首报（测试里缩短）+【进展】立即报',
    config: { progressFirstMs: 700, progressEveryMs: 600000, progressGapMs: 200 },
    async run(env) {
      await dsh(env);
      await env.say('长任务 #sleep=2500 #milestone=数据下载完了');
      await env.waitText('📍 数据下载完了', { timeout: 6000 });
      await env.waitText('ECHO:长任务', { timeout: 10000 });
      assert.ok(env.texts().some((t) => /⏳ 还在做|📍/.test(t)));
    },
  },
  {
    name: '/进度：忙时说在做什么，闲时说空闲和上一个任务',
    async run(env) {
      await dsh(env);
      await busy(env, '长任务 #sleep=2000');
      await env.say('/进度');
      await env.waitText('⏳ DSH 正在做');
      await env.waitText('ECHO:长任务', { timeout: 10000 });
      await env.idle();
      await env.say('/进度');
      const t = await env.waitText('✅ DSH 现在空闲');
      assert.match(t, /结果：完成/);
    },
  },
  {
    name: '/话题 列出话题',
    async run(env) {
      await dsh(env);
      await env.say('聊聊路由器'); await env.waitText('ECHO:聊聊路由器'); await env.idle();
      await env.say('/话题');
      await env.waitText('当前话题：');
    },
  },
  {
    name: '话题：裁判判定是新话题 → 静默开新会话',
    llmRules: { judge: (p) => (p.includes('"same"') ? { same: true, sure: 0.9 } : /做饭|菜谱/.test((p.match(/新消息：<<<([\s\S]*?)>>>/) || [])[1] || '') ? { why: '新的事', pivot: true, pick: 'NEW', sure: 0.97, title: '做饭' } : { why: 'x', pivot: false, pick: 'C', sure: 0.9 }) },
    async run(env) {
      await dsh(env);
      await env.say('帮我看下 wx-router 的日志'); await env.waitText('ECHO:帮我看下'); await env.idle();
      await env.say('帮我看下 wx-router 的配置'); await env.waitText('ECHO:帮我看下 wx-router 的配置'); await env.idle();
      const sid1 = env.readJson('wx-router/dsh-sessions.json').wxid_owner;
      await env.say('换个事，今晚做饭有什么菜谱推荐');
      await env.waitText('ECHO:换个事', { timeout: 10000 });
      await env.idle();
      const last = env.dshCalls().at(-1);
      const threads = env.readJson('wx-router/dsh-threads.json');
      const n = Object.keys(threads.chats.wxid_owner.threads).length;
      assert.ok(n >= 2, '开了新话题（现在 ' + n + ' 个）');
      assert.notEqual(last.sid, sid1, '新话题不用旧会话');
    },
  },
  {
    name: '「切错了」：没切过时带着提示重答',
    async run(env) {
      await dsh(env);
      await env.say('第一件事'); await env.waitText('ECHO:第一件事'); await env.idle();
      await env.say('切错了');
      await env.waitFor(() => env.dshCalls().length >= 2, { what: '重答' });
      await env.idle();
      assert.ok(env.dshCalls().at(-1).task.includes('话题放错') || env.dshCalls().at(-1).task.includes('放错了'), '带了提示');
    },
  },
];
