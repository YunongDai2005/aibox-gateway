#!/usr/bin/env node
// 本地意图分类：判断微信中途消息是「补充 / 纠错 / 叫停 / 新任务」
// 用法: node intent-classify.mjs "用户消息"  → 输出 补充|纠错|叫停|新任务
const URL = 'http://127.0.0.1:11435/v1/chat/completions';
const msg = process.argv.slice(2).join(' ').trim();
if (!msg) { console.log('补充'); process.exit(0); }

const SYS = `你是意图分类器。用户正让助手干活，中途发来一条消息。判断属于哪类，只回一个词。

补充：针对当前任务的加码。加需求、顺便、也考虑、记得加、补充说明 —— 不用打断
纠错：指出当前做法错了。不是X是Y、方向不对、改成别的做法、路径错了 —— 要打断
叫停：让停止。停、别做、取消、算了、不用了 —— 要马上停
新任务：和当前任务完全无关的另一件事，比如问天气、问时间、聊别的 —— 单独排队，不算纠错`;

try {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  const r = await fetch(URL, {
    method: 'POST', signal: ctl.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: msg }],
      max_tokens: 8, temperature: 0,
    }),
  });
  clearTimeout(timer);
  const j = await r.json();
  const t = ((j.choices?.[0]?.message?.content) || '').trim();
  const hit = ['补充', '纠错', '叫停', '新任务'].find((k) => t.includes(k));
  console.log(hit || '补充');   // 拿不准一律当「补充」——最安全，不误杀任务
} catch {
  console.log('补充');          // 服务挂了也不阻塞，退化成原来的排队行为
}
