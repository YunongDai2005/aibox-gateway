#!/usr/bin/env node
// threads-selftest.mjs —— 无感多话题（threads.mjs）自测
//   node threads-selftest.mjs          离线：假裁判，测状态机（迁移/留原地/切回/开新/防抖/撤回/换段/规则），不花额度
//   node threads-selftest.mjs --live   在线：真 dsh 裁判跑一组标注好的句子，报切换准确率（约 20 次 × 7 秒，花一点 Go 额度）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRouter, makeDshJudge, misrouteClaim, isTrivial, parseJudge, tokens } from '../src/memory/threads.mjs';

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.log('❌ ' + name); } };

// ---- 假的 proxy 状态（dsh-sessions.json / dsh-session-meta.json 的替身）----
function harness({ judge, sid = 'S-main', meta, seeds = [], th } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thr-'));
  const sess = {}, metas = {};
  const CH = 'chatA';
  if (sid) { sess[CH] = sid; metas[CH] = meta || { sid, startedAt: 1, msgCount: 10 }; }
  let clock = 1_000_000;
  const calls = [];
  const r = createRouter({
    stateFile: path.join(dir, 'threads.json'),
    getSid: (c) => sess[c] || null,
    setSid: (c, s) => { if (s) sess[c] = s; else delete sess[c]; },
    getMeta: (c) => metas[c] || null,
    putMeta: (c, m) => { if (m) metas[c] = m; else delete metas[c]; },
    judge: async (p) => { calls.push(p); return typeof judge === 'function' ? judge(p, calls.length) : judge; },
    seedAnchors: () => seeds,
    watchDirs: [],
    now: () => clock,
    th,
  });
  return { r, sess, metas, CH, calls, tick: (ms) => { clock += ms; }, dir,
    // 模拟 DSH 跑完一轮：拿到/保留 sid（新会话时生成新 sid）
    dshRan: (newSid) => { if (!sess[CH]) { sess[CH] = newSid; metas[CH] = { sid: newSid, startedAt: clock, msgCount: 1 }; } } };
}
const J = (pick, sure, extra = {}) => JSON.stringify({ pick, sure, cur_title: '', ...extra });

// ============ 1. 纯函数 ============
{
  const pos = ['切错了', '你切错了', '串台了', '话题串了', '不是这个话题', '不是在聊这个', '我说的是另一件事', '切错了，我说的是报税那个', '你接错话了'];
  const neg = ['不对', '不是这个', '搞错了', '你把两个文件搞混了', '错了', '这个切图切错了位置怎么办', '停', '继续', '不是这个意思，我是说改成红色', '改成python'];
  for (const s of pos) ok(!!misrouteClaim(s), 'misroute 应命中：' + s);
  for (const s of neg) ok(!misrouteClaim(s), 'misroute 不应命中：' + s);
  ok(misrouteClaim('切错了，我说的是报税那个').extra === '我说的是报税那个', 'misroute extra 提取');
  for (const s of ['继续', '好的', '嗯嗯', 'ok', '第二个', '选2', '/new', '可以的。', '1']) ok(isTrivial(s), 'trivial 应命中：' + s);
  for (const s of ['帮我看下日志', '网关又报错了', '继续把圆环颜色改一下']) ok(!isTrivial(s), 'trivial 不应命中：' + s);
  ok(parseJudge('{"pick":"T2","sure":0.9}', ['T1', 'T2']).pick === 'T2', 'parseJudge 正常');
  ok(parseJudge('好的\n{"pick":"t1","sure":"0.95"}\n', ['T1']).pick === 'T1', 'parseJudge 有杂字/小写/字符串数字');
  ok(parseJudge('{"pick":"T3","sure":0.9}', ['T1', 'T2']) === null, 'parseJudge 越界 id → null');
  ok(parseJudge('我觉得是C', ['T1']) === null, 'parseJudge 非 JSON → null');
  ok(parseJudge('{"pick":"C"}', []) === null, 'parseJudge 缺 sure → null');
  ok(tokens('给 wx-router 加个圆环').has('圆环') && tokens('proxy.mjs 报错').has('proxy.mjs'), 'tokens 中文 bigram + 英文词');
}

// ============ 2. 迁移 + 留原地 ============
{
  const h = harness({ judge: J('C', 0.9), seeds: ['给网关加个上下文圆环', '压缩阈值调高一点', '叫停功能又坏了', 'proxy.mjs 改完帮我重启'] });
  let x = await h.r.route(h.CH, '继续');
  ok(x.action === 'stay' && h.calls.length === 0, '短句「继续」留原地，不请裁判');
  const st = h.r._load().chats[h.CH];
  ok(st && Object.keys(st.threads).length === 1 && st.threads.th1.head === 'S-main', '首次迁移：老会话收编成 th1，head=原 sid');
  ok(st.threads.th1.anchors.length === 4, '迁移时用近期原话做画像');
  x = await h.r.route(h.CH, '网关的圆环颜色再调一下');
  ok(x.action === 'stay' && h.calls.length === 0, '词面明显贴当前话题 → 不请裁判直接留');
  x = await h.r.route(h.CH, '帮我想想周末去哪玩');
  ok(x.action === 'stay' && h.calls.length === 1, '词面不贴 → 请裁判；裁判选 C → 留');
  ok(h.sess[h.CH] === 'S-main', '留原地不动 sid');
}

// ============ 3. 开新话题 → 防抖 → 切回老话题（带对账）→ 撤回 ============
{
  let answer = J('NEW', 0.95, { title: '个税汇算' });
  const h = harness({ judge: () => answer, seeds: ['给网关加个上下文圆环', '压缩阈值调高一点', '叫停功能又坏了', 'proxy.mjs 改完帮我重启'] });
  h.tick(60_000);
  let x = await h.r.route(h.CH, '个税年度汇算要准备哪些材料');
  ok(x.action === 'new' && x.title === '个税汇算', '裁判高把握 NEW → 开新话题');
  ok(!h.sess[h.CH] && h.metas[h.CH] && h.metas[h.CH].fileInjectedAt, '新话题：sid 清空、meta 带 fileInjectedAt（不灌别的话题的交接）');
  ok(/新话题/.test(x.prefix), '新话题有静默提示前缀');
  h.dshRan('S-tax');
  h.r.noteReply(h.CH, '需要准备收入明细、专项附加扣除材料、房贷利息证明……');
  let st = h.r._load().chats[h.CH];
  ok(st.threads.th2.head === 'S-tax', 'DSH 跑完后新 sid 同步回线程 th2');

  // 防抖期：裁判 0.88 想切回 → 门槛 0.85+0.07 → 不切
  answer = J('T1', 0.88);
  h.tick(60_000);
  x = await h.r.route(h.CH, '网关那个叫停的问题还在吗');
  ok(x.action === 'stay', '防抖期内 0.88 不够（需 0.92）→ 留');
  // 再来一条，还在防抖期（cooldown=2）
  answer = J('C', 0.9);
  x = await h.r.route(h.CH, '房贷利息每个月能扣多少');
  ok(x.action === 'stay', '接着聊个税 → 留');
  // 防抖过了：0.9 + 词面支持 → 切回 th1
  answer = J('T1', 0.9);
  h.tick(3600_000);
  x = await h.r.route(h.CH, '网关叫停功能 proxy.mjs 修好了吗');
  ok(x.action === 'switch' && x.resumed && x.to === 'th1', '高把握 + 词面支持 → 切回 th1');
  ok(h.sess[h.CH] === 'S-main', '切回后 sid = th1 的 head（S-main）');
  ok(h.metas[h.CH].resumedAt && h.metas[h.CH].sid === 'S-main', '切回后 meta 带 resumedAt（防止被日切压缩）');
  ok(/老话题/.test(x.prefix) && /个税汇算/.test(x.prefix), '对账前缀：说明是老话题 + 期间聊过什么');
  st = h.r._load().chats[h.CH];
  ok(st.threads.th2.head === 'S-tax' && st.fg === 'th1', '被切走的 th2 保留 head');

  // 用户：切错了 → 撤回到 th2
  const rv = h.r.revert(h.CH);
  ok(rv && rv.to === 'th2' && rv.texts[0].includes('proxy.mjs'), '「切错了」撤回：回 th2，拿到原话');
  ok(h.sess[h.CH] === 'S-tax', '撤回后 sid 回到 S-tax');
  ok(h.r.revert(h.CH) === null, '同一次切换不能撤两遍');
  // 撤回后 3 条内不许再自动切去 th1
  answer = J('T1', 0.99);
  x = await h.r.route(h.CH, '网关叫停 proxy.mjs 再看看');
  ok(x.action === 'stay', '撤回后被屏蔽的线程不会马上又切过去');
}

// ============ 4. 保守性：各种"不该切" ============
{
  const seeds = ['给网关加个上下文圆环', '压缩阈值调高一点'];
  // 裁判挂了
  let h = harness({ judge: async () => { throw new Error('boom'); }, seeds });
  let x = await h.r.route(h.CH, '帮我订一张去杭州的高铁票');
  ok(x.action === 'stay' && /judge-fail/.test(x.why), '裁判抛错 → 留');
  // 裁判超时返回 null
  h = harness({ judge: null, seeds });
  x = await h.r.route(h.CH, '帮我订一张去杭州的高铁票');
  ok(x.action === 'stay', '裁判无输出 → 留');
  // NEW 但把握不够
  h = harness({ judge: J('NEW', 0.8), seeds });
  x = await h.r.route(h.CH, '帮我订一张去杭州的高铁票');
  ok(x.action === 'stay', 'NEW 把握 0.8 < 0.85 → 留');
  // NEW 但句子太短
  h = harness({ judge: J('NEW', 0.99), seeds });
  x = await h.r.route(h.CH, '订高铁');
  ok(x.action === 'stay', 'NEW 但句子太短 → 留');
  // 影子模式
  h = harness({ judge: J('NEW', 0.99), seeds });
  const h2 = createRouter({ stateFile: path.join(h.dir, 's.json'), getSid: () => 'S', setSid: () => { throw new Error('影子模式不该写'); }, getMeta: () => ({ sid: 'S' }), putMeta: () => { throw new Error('影子模式不该写'); }, judge: async () => J('NEW', 0.99), shadow: true, seedAnchors: () => seeds });
  x = await h2.route('c', '帮我订一张去杭州的高铁票，下周二出发');
  ok(x.action === 'stay' && /shadow/.test(x.why), '影子模式：判定了但不切');
  // 关闭
  const h3 = createRouter({ stateFile: path.join(h.dir, 'd.json'), getSid: () => 'S', setSid: () => {}, getMeta: () => null, putMeta: () => {}, judge: async () => { throw new Error('关闭时不该调'); }, enabled: false });
  x = await h3.route('c', '帮我订一张去杭州的高铁票');
  ok(x.action === 'stay', 'enabled=false → 永远留');
  // 切回：把握高但词面反对且 < 0.93 → 不切
  let ans = J('NEW', 0.95, { title: '旅行' });
  h = harness({ judge: () => ans, seeds, th: { judgeIfCurBelow: 1.01 } });   // 强制每句都请裁判，专测"词面反对"这道门
  await h.r.route(h.CH, '周末想去杭州玩两天帮我规划'); h.dshRan('S-trip');
  ans = J('C', 0.9); h.tick(10);
  await h.r.route(h.CH, '西湖边住哪比较好'); await h.r.route(h.CH, '去杭州的高铁几点的比较合适');
  ok(h.r._load().chats[h.CH].fg === 'th2', '旅行线程在前台');
  ans = J('T1', 0.9);
  x = await h.r.route(h.CH, '杭州西湖的门票怎么买');
  ok(x.action === 'stay' && /judge-weak/.test(x.why), '裁判想切 0.9、但词面更贴当前 → 不切');
  ans = J('T1', 0.95);
  x = await h.r.route(h.CH, '杭州西湖的船票怎么买');
  ok(x.action === 'switch', '同样情况但裁判 0.95（≥0.93）→ 切（说明门槛是按设计生效的）');
}

// ============ 5. 换段（交接）+ /new ============
{
  const h = harness({ judge: J('C', 0.9), seeds: ['网关圆环'] });
  await h.r.route(h.CH, '网关圆环再看看');
  // proxy 交接换段：sid 变了
  h.sess[h.CH] = 'S-main-2'; h.metas[h.CH] = { sid: 'S-main-2', startedAt: 5 };
  h.r.noteReply(h.CH, 'ok');
  let st = h.r._load().chats[h.CH];
  ok(st.threads.th1.head === 'S-main-2' && st.threads.th1.segments.includes('S-main'), '交接换段：head 跟新段，旧段冻结进 segments');
  const id = h.r.forceNew(h.CH);
  delete h.sess[h.CH]; delete h.metas[h.CH];   // proxy 的 /new 随后清空
  st = h.r._load().chats[h.CH];
  ok(id === 'th2' && st.fg === 'th2' && st.threads.th1.head === 'S-main-2', '/new：开 th2，th1 的会话保留可切回');
  ok(h.r.forceNew(h.CH) === 'th2', '连发两次 /new 不重复开空话题');
  const n0 = h.calls.length;
  const x = await h.r.route(h.CH, '网关圆环的事再说说');
  ok(x.action === 'stay' && h.calls.length === n0, '/new 后第一句不请裁判、不被拉回旧话题');
  ok(h.r._load().chats[h.CH].threads.th2.title.startsWith('网关圆环'), '/new 的话题用第一句当临时标题');
}

// ============ 6. 「切错了」但没切过：放宽门槛找归属 ============
{
  let answer = J('NEW', 0.95, { title: '个税' });
  const h = harness({ judge: () => answer, seeds: ['网关圆环', '压缩阈值'] });
  await h.r.route(h.CH, '个税年度汇算要准备哪些材料'); h.dshRan('S-tax');
  h.tick(40 * 60_000);   // 过了撤回窗口
  answer = J('C', 0.9);
  await h.r.route(h.CH, '网关压缩阈值那个事情怎么样了');   // 被留在个税话题（该切没切）
  ok(h.r.revert(h.CH) === null, '超出窗口不能撤回');
  ok(h.r.lastUserText(h.CH).includes('压缩阈值'), '能拿到上一句');
  answer = J('T1', 0.65);
  const x = await h.r.route(h.CH, '不是这个话题', { hint: { prev: h.r.lastUserText(h.CH) } });
  ok(x.action === 'switch' && x.to === 'th1' && x.reask.includes('压缩阈值'), 'hint 模式 0.65 即可切回，并返回要重答的上一句');
  ok(h.sess[h.CH] === 'S-main', 'hint 切回后 sid 正确');
}

console.log(`\n离线自测: ${pass}/${pass + fail} ${fail === 0 ? 'PASS ✅' : 'FAIL ❌'}`);

// ============ 在线：真裁判 ============
if (process.argv.includes('--live')) {
  const judge = makeDshJudge({ bin: '/usr/local/bin/dsh', cwd: '/home/aibox/.aibox/thread-judge', fallbackPatch: '/home/aibox/.dsh/profiles/headless/fallback-deepseek.yml', useFallback: () => false });
  // 场景：前台=网关开发；旧话题=个税、杭州旅行。exp: C=该留 / th2 / th3 / NEW
  const cases = [
    ['那两份工资的话是不是要补税', 'th2'], ['房贷利息那张表我填好了，下一步干嘛', 'th2'],
    ['灵隐寺要不要提前预约', 'th3'], ['酒店订好了没', 'th3'], ['去杭州的高铁改成周六早上', 'th3'],
    ['网关日志里又报502了', 'C'], ['面板那个圆环颜色改深一点', 'C'], ['继续刚才那个', 'C'], ['你再检查一遍', 'C'],
    ['今天天气怎么样', 'C'], ['帮我翻译一下 good morning', 'C'], ['这个方案有什么风险', 'C'], ['那就按你说的第二种来', 'C'],
    ['帮我规划一下下个月搬家的事，先列个清单', 'NEW'], ['我想开始学日语，帮我定个三个月计划', 'NEW'],
    ['上次那个个税的事，专项附加扣除我还没填完', 'th2'], ['叫停功能测一下还灵不灵', 'C'], ['杭州那边吃饭有推荐吗', 'th3'],
  ];
  let right = 0, wrongSwitch = 0, missed = 0, n = 0;
  for (const [msg, exp] of cases) {
    let clock = 5_000_000;
    const sess = { c: 'S-gw' }, metas = { c: { sid: 'S-gw', startedAt: 1 } };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thr-live-'));
    const sf = path.join(dir, 't.json');
    fs.writeFileSync(sf, JSON.stringify({ version: 1, chats: { c: { fg: 'th1', seq: 3, cooldown: 0, lastSwitch: null, lastUser: null, threads: {
      th1: { id: 'th1', title: '微信网关 wx-router 开发', titleAuto: false, origin: 'migrate', head: 'S-gw', segments: [], meta: null, createdAt: 1, lastActiveAt: clock, status: 'open', lastReply: '好，圆环已经加到面板上了，压缩阈值调到 60 万。',
        anchors: ['给网关加个上下文圆环', '压缩阈值调高一点', '叫停功能怎么又坏了', 'proxy.mjs 改完帮我重启', '面板上显示一下进度'].map((t) => ({ t, at: 1 })) },
      th2: { id: 'th2', title: '准备个税年度汇算', titleAuto: false, origin: 'judge', head: 'S-tax', segments: [], meta: { sid: 'S-tax', startedAt: 1 }, createdAt: 1, lastActiveAt: clock - 3 * 3600e3, status: 'open', lastReply: '',
        anchors: ['个税app里专项附加扣除怎么填', '房贷利息能扣多少', '我去年换了工作两份工资'].map((t) => ({ t, at: 1 })) },
      th3: { id: 'th3', title: '杭州周末旅行', titleAuto: false, origin: 'judge', head: 'S-trip', segments: [], meta: { sid: 'S-trip', startedAt: 1 }, createdAt: 1, lastActiveAt: clock - 24 * 3600e3, status: 'open', lastReply: '',
        anchors: ['周末想去杭州玩两天', '西湖附近住哪', '高铁票帮我看看'].map((t) => ({ t, at: 1 })) },
    } } } }));
    const r = createRouter({ stateFile: sf, getSid: (c) => sess[c], setSid: (c, s) => { sess[c] = s; }, getMeta: (c) => metas[c], putMeta: (c, m) => { metas[c] = m; }, judge, now: () => clock, watchDirs: [] });
    const t0 = Date.now();
    const x = await r.route('c', msg);
    const got = x.action === 'stay' ? 'C' : x.action === 'new' ? 'NEW' : x.to;
    n++;
    if (got === exp) right++;
    else if (got !== 'C') wrongSwitch++;
    else missed++;
    console.log((got === exp ? '✅' : got === 'C' ? '➖ 漏切' : '❌ 切错') + ' ' + msg + ' → ' + got + '（应 ' + exp + '） ' + x.why + ' ' + (Date.now() - t0) + 'ms');
  }
  console.log(`\n在线裁判: 对 ${right}/${n}，切错 ${wrongSwitch}（必须接近 0），漏切 ${missed}（可接受，留在原地）`);
}
process.exit(fail === 0 ? 0 : 1);
