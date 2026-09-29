/** Reproducible demo: real gateway/session code, deterministic fake external services. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { startEnv, OWNER } from '../test/harness.mjs';

const scenario = [
  { text: 'Build a landing page for my website.', topic: 'Website', note: 'A website conversation starts.' },
  { text: 'Compare battery storage options for my research.', topic: 'Research', note: 'A different subject gets its own session.' },
  { text: 'Add CSV export to my Python tool.', topic: 'Python tool', note: 'A third topic gets a separate session.' },
  { text: 'Make the homepage hero dark.', topic: 'Website', note: 'The website session is restored without a switch command.' },
  { text: 'Show the battery comparison as a bar chart.', topic: 'Research', note: 'The research session is restored.' },
  { text: 'Include column headers in the CSV.', topic: 'Python tool', note: 'The export requirement reaches the original Python session.' },
  { text: 'Also handle empty files.', topic: 'Python tool', note: 'A follow-up stays in the active topic.' },
];
let expectedTopic = '';
// These fixture decisions intentionally do not claim model understanding.
function judge(prompt) {
  if (prompt.includes('"same"')) return { same: true, sure: 0.99 };
  const current = prompt.match(/当前会话 \[C\]：\n  标题：([^\n]+)/)?.[1];
  const blank = prompt.includes('（还没有）');
  const target = [...prompt.matchAll(/\[(T\d+)\] 「([^」]+)」/g)].find(m => m[2] === expectedTopic);
  const pick = current === expectedTopic || blank ? 'C' : target?.[1] || 'NEW';
  return { why: 'Deterministic demo fixture', pivot: pick !== 'C', pick, sure: 0.99, title: expectedTopic, cur_title: blank ? expectedTopic : current };
}
const env = await startEnv({
  llmRules: { judge },
  setup(e) { e.writeJson('wx-router/modes.json', { [OWNER]: 'dsh' }); },
});
const frames = [], sessionIds = new Map(), topicIds = new Map();
try {
  for (const item of scenario) {
    expectedTopic = item.topic;
    const callsBefore = env.dshCalls().length;
    await env.say(item.text);
    await env.waitCalls(callsBefore + 1);
    await env.waitText('ECHO:' + item.text);
    await env.idle();
    const state = env.readJson('wx-router/dsh-threads.json').chats[OWNER];
    const current = state.threads[state.fg];
    const sid = env.readJson('wx-router/dsh-sessions.json')[OWNER];
    assert.equal(current.title, item.topic);
    const resumed = sessionIds.has(item.topic);
    if (resumed) {
      assert.equal(sid, sessionIds.get(item.topic), 'Resumed session identity must be preserved');
      assert.equal(env.dshCalls().at(-1).sid, sid, 'Worker must receive the original session ID');
      assert.equal(state.fg, topicIds.get(item.topic));
    } else {
      assert.ok(![...sessionIds.values()].includes(sid), 'Different topics need different sessions');
      sessionIds.set(item.topic, sid); topicIds.set(item.topic, state.fg);
    }
    const route = env.events().filter(e => e.type === 'topic.route').at(-1);
    const topics = [...sessionIds.keys()].map((title, i) => ({ title, session: 'S' + (i + 1), active: title === item.topic }));
    frames.push({ ...item, action: route.action, session: topics.find(t => t.active).session, topics, verified: true });
  }
  assert.equal(sessionIds.size, 3);
} finally { await env.stop(); env.cleanup(); }

// Exercise the exact selection functions without executing helper CLI startup,
// reading real credentials, starting agents, or making network requests.
const helper = fs.readFileSync(new URL('../bin/helper.mjs', import.meta.url), 'utf8');
const start = helper.indexOf('function quotaView()');
const end = helper.indexOf('// ---------- 状态 / 展示 ----------', start);
assert.ok(start >= 0 && end > start, 'Selection section must exist');
const selectionCode = helper.slice(start, end);
const quota = {
  updatedAt: '2026-01-01T00:00:00Z',
  claude: { ok: true, windows: { fiveHour: { usedPercent: 94 } } },
  chatgpt: { ok: true, windows: { fiveHour: { usedPercent: 28 } } },
  go: { ok: true, windows: { monthly: { usedPercent: 45 } } },
};
let modelCalls = 0;
const context = vm.createContext({
  rj: () => quota,
  fs: { readFileSync: () => 'OPENCODE_GO_API_KEY: demo-fixture-only' },
  cut: (s, n) => String(s).slice(0, n), log: () => {}, AbortSignal,
  fetch: async (_url, options) => {
    modelCalls++;
    const body = JSON.parse(options.body);
    const text = body.messages[1].content;
    const candidates = text.split('【候选】\n')[1];
    assert.ok(!candidates.includes('Claude'), 'Below 10% remaining must be excluded');
    assert.match(text, /72%/); assert.match(text, /55%/);
    const match = candidates.match(/^(\d+)\. GPT /m);
    assert.ok(match);
    return { json: async () => ({ choices: [{ message: { content: JSON.stringify({ pick: Number(match[1]), effort: 'high', reason: 'Fixture decision: coding task; GPT has 72% remaining.' }) } }] }) };
  },
});
const advisor = await new vm.Script(selectionCode + '\nchoose("Review the Python CSV implementation", {work:true, hard:true})').runInContext(context);
assert.equal(advisor.helper, 'gpt'); assert.equal(modelCalls, 1);
const result = {
  schema: 1,
  provenance: { gateway: 'Real v2 routing and session code', model: 'Deterministic fixture responses', worker: 'Fake DSH, no actual project edits', advisor: 'Real quota filter and selection functions; simulated Manager choice', execution: 'Sequential per chat; no concurrent-task or task-bound-mailbox claim' },
  frames,
  advisor: { task: 'Review the Python CSV implementation', quotas: [{name:'Claude',left:6,status:'Excluded: below 10%'},{name:'GPT',left:72,status:'Selected by fixture Manager'},{name:'Go',left:55,status:'Eligible alternative'}], selected: 'GPT', reason: 'Coding task; 72% remaining. Manager choice is simulated.', verified: true },
  checks: ['Three distinct sessions created', 'All three follow-ups reuse the original worker session ID', 'The final follow-up stays in the Python session', 'Advisor below 10% is excluded before Manager selection', 'Manager receives quota data and task requirements'],
};
const out = new URL('../docs/demo/trace.json', import.meta.url);
fs.writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
console.log('Verified demo: 7 messages, 3 sessions, 3 resumed sessions, advisor quota filtering.');
