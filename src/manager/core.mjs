/**
 * manager：经理。2026-09-28 Mac 端 Claude 写（主人的构想：像跟人聊天一样，它在干活你也能随时说话、商量）。
 *
 * 分工：工人 = DSH（能操作电脑，专心干活，干活时"听不见"）；经理 = 一个快模型（不能操作电脑，永远有空，2 秒回）。
 * 工人空闲时：主人的话照旧直接给工人。工人干活时：主人的话先给经理 ——
 *   经理看工人实时状态 + 最近的对话，秒回主人，并决定怎么处理（action）：
 *     none   只回答（问进度/是不是卡了/闲聊/经理能直接答的）
 *     note   给工人的补充/偏好/新要求，不用打断 → 写进信箱，工人下个阶段看到
 *     redo   工人方向错了、继续做会白做 → 打断，带着新要求在原会话里接着改（有代价，慎用）
 *     stop   主人要停
 *     queue  跟当前任务无关的新事 → 排队，工人做完再做
 *     answer 工人正在等主人回答它的提问（ask-owner），这句就是回答
 * 信箱/提问的文件都在 /home/aibox/.aibox/mgr/。工人那边的命令：mailbox、ask-owner（/home/aibox/bin）。
 * 日志：/home/aibox/.aibox/logs/manager.log（每次：主人原话、工人状态摘要、经理回复、action、耗时、用的模型）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg, paths } from '../core/config.mjs';
import { chat as llmChat, responses as llmResponses } from '../core/llm.mjs';

export const DIR = paths.mgr;
export const MAILBOX = path.join(DIR, 'mailbox.jsonl');
export const QFILE = path.join(DIR, 'question.json');
export const AFILE = path.join(DIR, 'answer.json');
const HIST = path.join(DIR, 'history.json');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(paths.logs, 'manager.log');
const HIST_KEEP = 30;   // 2026-09-28 16→30：经理多记一些上下文（很便宜）

const rj = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const wj = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(p + '.tmp', p); };
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const mins = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'; };
export function log(msg) { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch {} }

// ---------- 开关（每个聊天可以 /经理 开关；默认看 config.managerMode）----------
export function isOn(chat, dflt) { const s = rj(STATE, {}); return s[chat] === undefined ? !!dflt : !!s[chat]; }
export function setOn(chat, on) { const s = rj(STATE, {}); s[chat] = !!on; wj(STATE, s); }

// ---------- 信箱：经理 → 工人 ----------
export function mailboxAdd(text, kind = 'note') {
  fs.mkdirSync(DIR, { recursive: true });
  const item = { id: crypto.randomUUID().slice(0, 8), at: new Date().toISOString(), kind, text, read: false };
  fs.appendFileSync(MAILBOX, JSON.stringify(item) + '\n');
  return item;
}
export function mailboxAll() { try { return fs.readFileSync(MAILBOX, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
export function mailboxUnread() { return mailboxAll().filter((x) => !x.read); }
export function mailboxMarkRead(ids) {
  const all = mailboxAll(); const set = new Set(ids);
  const keep = all.filter((x) => Date.parse(x.at) > Date.now() - 7 * 86400e3).map((x) => (set.has(x.id) ? { ...x, read: true, readAt: new Date().toISOString() } : x));
  fs.writeFileSync(MAILBOX + '.tmp', keep.map((x) => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : '')); fs.renameSync(MAILBOX + '.tmp', MAILBOX);
}

// ---------- 工人提问 ----------
export function pendingQuestion() { const q = rj(QFILE, null); return q && !q.answered ? q : null; }
export function answerQuestion(q, text) { wj(AFILE, { qid: q.id, answer: text, at: new Date().toISOString() }); wj(QFILE, { ...q, answered: true }); }

// ---------- 模型（统一走 core/llm.mjs）----------
const llm = (messages) => llmChat(messages, { session: 'ses_aibox_manager', purpose: 'manager' });

const SYSTEM = `你是主人的「经理」，在微信里跟主人聊天。你手下有个「工人」——DSH，一个能操作这台电脑（AI Box）的 AI，现在正在后台干活。
你看得到工人的实时状态（下面会给），但你自己不能操作电脑、不能查文件。

你要做两件事：
1) 马上回主人，像同事聊天：中文、口语、简短（1-4 句），先给结论。不编造进度，只按状态说；状态里没有的就说不知道、可以问工人。
2) 决定怎么处理主人这句话（action）：
- none：只需要回答。问进度、问是不是卡了、闲聊、你能直接答的。
- note：给当前任务的补充/偏好/新要求，不用打断（工人下个阶段会看信箱）。to_worker 写清楚要转达的话。
- redo：工人方向明显错了、接着做会白做，要立刻打断让它按新要求在原来基础上改。redo 会**马上**打断（手上正在跑的这一步作废），reply 里别说"等它做完这步"。打断有代价，拿不准就用 note（note 是它下个阶段自己看到再调整）。
- stop：主人明确要停下当前任务。
- queue：跟当前任务无关的另一件事，工人做完再做。to_worker 写清任务。
- answer：「工人正在等主人回答」时，这句就是回答。to_worker 写主人的回答（可以帮着整理清楚）。
- split：主人要把前面混在一起的话题拆开（"把话题拆开""前面聊乱了分一下"）。系统会在工人这一轮做完后拆。
3) 主人意思不清楚、或者有几种做法时，先跟主人商量（action=none，在 reply 里问），商量好了再转达。
reply 里说清你打算怎么办（比如"我转告它，拼接时加上"），别说空话。

只输出一个 JSON 对象：{"reply": "给主人的话", "action": "none|note|redo|stop|queue|answer|split", "to_worker": "转达给工人的话（none/stop 时留空）"}`;

// 三家顾问的额度（2026-09-28：主人要经理能看额度、判断用谁；自动派活用 helper start auto，也是经理的模型判断）
export function quotaBrief() {
  try {
    const q = JSON.parse(fs.readFileSync(paths.quota, 'utf8'));
    const w = (ws) => Object.entries(ws || {}).filter(([, x]) => x && x.usedPercent != null).map(([k, x]) => k + '剩' + Math.round(100 - x.usedPercent) + '%').join(' ') || '没有读数';
    const adv = (a) => (a && a.calls != null ? '，约还能 ' + (a.atLeast ? '≥' : '') + a.calls + ' 次' : '');
    return '\n\n【三家顾问额度】（' + Math.round((Date.now() - Date.parse(q.updatedAt)) / 60000) + ' 分钟前）' +
      '\n- Claude（和主人共用）：' + w(q.claude && q.claude.windows) + adv(q.claude && q.claude.advisor) + (q.claude && q.claude.available === false ? '（限流中）' : '') +
      '\n- GPT（ChatGPT Plus）：' + w(q.chatgpt && q.chatgpt.windows) + adv(q.chatgpt && q.chatgpt.advisor) + (q.chatgpt && q.chatgpt.limitReached ? '（已达上限）' : '') +
      '\n- Go 包月：' + w(q.go && q.go.windows) + (q.go && q.go.pace ? '；本月节奏：应用 ' + q.go.pace.expected + '%、实际 ' + q.go.pace.used + '%' : '') + '（强模型按 4 倍扣）' +
      '\n（主人问额度/用谁时照这个说；工人派外援用 helper start auto 会自动按额度选）';
  } catch { return ''; }
}

// 工人状态 → 给经理看的一段文字
export function workerBrief(run, helpers) {
  if (!run) return '工人现在空闲。';
  const now = Date.now();
  const L = ['工人正在做：' + cut(run.task, 150), '已经 ' + mins(now - run.startedAt) + '，第 ' + run.step + ' 步，用了 ' + run.tools + ' 次工具。'];
  if (run.current) L.push('这一刻：' + cut(run.current.label, 100) + '（这一步已 ' + mins(now - run.current.since) + '）');
  L.push('最近一次有动静：' + mins(now - (run.lastAt || run.startedAt)) + '前。（10 分钟以上没动静才算可疑；渲染/编译/等外援时一步几分钟很正常）');
  for (const m of (run.milestones || []).slice(-3)) L.push('进展：' + cut(m.x, 120));
  const ev = (run.events || []).filter((e) => e.k === 'say' || e.k === 'tool').slice(-6);
  if (ev.length) L.push('最近在干的事：\n' + ev.map((e) => '  - ' + (e.k === 'tool' ? '🔧 ' : '💬 ') + cut(e.x, 110)).join('\n'));
  if (helpers) L.push(helpers);
  return L.join('\n');
}

/**
 * 处理一条主人消息（工人忙时）。返回 { reply, action, toWorker, route, ms }
 * ctx = { chat, text, run（live 里的工人运行记录）, helpers（外援在跑的一句话，可空） }
 */
export async function decide(ctx) {
  const t0 = Date.now();
  const hist = rj(HIST, {})[ctx.chat] || [];
  const q = pendingQuestion();
  const unread = mailboxUnread();
  const status = workerBrief(ctx.run, ctx.helpers) + quotaBrief() +
    (q ? '\n\n⚠️ 工人正在等主人回答它的提问：「' + cut(q.q, 200) + '」（' + mins(Date.now() - Date.parse(q.at)) + '前问的）' : '') +
    (unread.length ? '\n\n信箱里还有 ' + unread.length + ' 条留言工人还没看：' + unread.map((x) => '「' + cut(x.text, 60) + '」').join('') : '');
  const messages = [{ role: 'system', content: SYSTEM }, ...hist, { role: 'user', content: '【工人实时状态】\n' + status + '\n\n【主人说】' + ctx.text }];
  let out, route;
  try { const r = await llm(messages); route = r.route; out = JSON.parse(r.text.replace(/^```(json)?|```$/g, '').trim()); }
  catch (e) {
    log('ERROR chat=' + ctx.chat + ' ' + cut(String(e.message || e), 200));
    return { reply: null, action: 'fallback', toWorker: '', route: 'none', ms: Date.now() - t0, error: String(e.message || e) };
  }
  const action = ['none', 'note', 'redo', 'stop', 'queue', 'answer', 'split'].includes(out.action) ? out.action : 'none';
  const res = { reply: String(out.reply || '').trim() || '收到。', action: action === 'answer' && !q ? 'note' : action, toWorker: String(out.to_worker || '').trim(), route, ms: Date.now() - t0, question: q };
  const h = rj(HIST, {});
  h[ctx.chat] = [...hist, { role: 'user', content: '【主人说】' + ctx.text + '\n（当时工人：' + cut(ctx.run ? ctx.run.current && ctx.run.current.label : '空闲', 60) + '）' },
    { role: 'assistant', content: JSON.stringify({ reply: res.reply, action: res.action, to_worker: res.toWorker }) }].slice(-HIST_KEEP);
  wj(HIST, h);
  log('chat=' + ctx.chat.slice(0, 8) + ' route=' + route + ' ms=' + res.ms + ' action=' + res.action + ' 主人=' + JSON.stringify(cut(ctx.text, 80)) +
    ' 经理=' + JSON.stringify(cut(res.reply, 120)) + (res.toWorker ? ' 转达=' + JSON.stringify(cut(res.toWorker, 120)) : '') +
    ' 工人=' + JSON.stringify(cut(ctx.run ? (ctx.run.current && ctx.run.current.label) : '空闲', 60)));
  return res;
}

// 工人自己的回复也记进经理的对话历史（经理才知道工人刚交付了什么）
export function noteWorkerReply(chat, text) {
  const h = rj(HIST, {});
  h[chat] = [...(h[chat] || []), { role: 'user', content: '【工人刚回复主人】' + cut(text, 400) }, { role: 'assistant', content: '{"reply":"","action":"none","to_worker":""}' }].slice(-HIST_KEEP);
  wj(HIST, h);
}

// ===== 话题裁判（2026-09-28）：替代原来"每判一次启动一整个 DSH"的裁判 =====
// threads.mjs 把判定题目（prompt）交给 judge(prompt) → 返回一段含 JSON 的文字（{"pick":"C|T1..|NEW","sure":0~1,...}）。
// 一审：经理的快模型（2~3 秒）。它说要切走（T/NEW）但把握 < 0.9 → 二审：GPT-6 Luna（会思考，约 10 秒，Go 里最省的强模型）。
// 依据：arXiv 2605.09268 —— 不思考的开源模型常常察觉不到话题转换、还有位置偏差；会思考的模型判得准。
const goResponses = (model, prompt) => llmResponses(model, prompt, { session: 'ses_aibox_topicjudge', purpose: 'topic-judge' });
const judgeModel = () => cfg.llm.judgeModel || 'gpt-6-luna';
function parsePick(s) { try { const a = s.indexOf('{'), b = s.lastIndexOf('}'); const j = JSON.parse(s.slice(a, b + 1)); return { pick: String(j.pick || '').toUpperCase(), sure: Number(j.sure) }; } catch { return null; } }
export function makeTopicJudge({ log: plog = () => {} } = {}) {
  return async (prompt) => {
    const t0 = Date.now();
    let first = null, route = '';
    try { const r = await llmChat([{ role: 'user', content: prompt }], { session: 'ses_aibox_manager', purpose: 'topic-judge' }); first = r.text; route = r.route; } catch (e) { plog('topic judge fast ERROR ' + e.message); }
    const p1 = first && parsePick(first);
    let out = first, how = '一审 ' + route;
    if (prompt.includes('"same"')) { log('TOPIC 插话同题判定 ' + route + ' ms=' + (Date.now() - t0)); return first; }   // 插话「还是同一件事吗」题：格式不同，不走复核
    const cueC = p1 && p1.pick === 'C' && prompt.includes('转场词');          // 有转场词却判「留下」→ 也复核（论文：转场词常被忽略）
    if (!p1 || cueC || (p1.pick !== 'C' && !(p1.sure >= 0.9))) {
      try { const second = await goResponses(judgeModel(), prompt); if (parsePick(second)) { out = second; how = '二审 gpt-6-luna（一审 ' + (p1 ? p1.pick + '@' + p1.sure : '失败') + '）'; } }
      catch (e) { plog('topic judge 2nd ERROR ' + e.message); }
    }
    const p = out && parsePick(out);
    log('TOPIC ' + how + ' → ' + (p ? p.pick + '@' + p.sure : '无法解析') + ' ms=' + (Date.now() - t0));
    return out;
  };
}
