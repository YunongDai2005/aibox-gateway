import { createRouter } from '/home/aibox/wx-router/threads.mjs';
import fs from 'fs';
const SF='/tmp/peek-state2.json';
try{fs.unlinkSync(SF)}catch{}
let judgeReply='{"pick":"C","sure":0.9}';
const r=createRouter({
  stateFile:SF, log:(m)=>console.log('  [log]',m), getSid:()=>null, getMeta:()=>null, seedAnchors:()=>[],
  judge:async()=>judgeReply
});
// 建话题1
await r.route('c1','帮我修一下 wx-router 代理代码的排队问题',{fullText:'x'});
// 强制开话题2（/new）
r.forceNew('c1');
judgeReply='{"pick":"NEW","sure":0.9,"title":"杭州旅游"}';
await r.route('c1','明天去杭州旅游有什么推荐',{fullText:'y'});
console.log('--- 话题建好 ---');
console.log('summary:', r.summary('c1').threads.map(t=>t.id+':'+t.title).join(' | '));
// 当前是话题2（杭州）。测：一句明显属于话题1的话
const a=await r.peekTopic('c1','wx-router 的代理代码排队还是有问题');
console.log('测「回到话题1」→', JSON.stringify(a), '(期望 same=false)');
// 测：一句属于话题2的话
const b=await r.peekTopic('c1','杭州西湖边有什么好吃的');
console.log('测「留在话题2」→', JSON.stringify(b), '(期望 same=true)');
