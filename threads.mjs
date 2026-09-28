// threads.mjs —— 无感多话题记忆（话题线程路由器），2026-09-28 Claude 外援实现
//
// 主人要的：永远只有一个聊天框；系统自己看出这句话该在哪场对话里答；切换完全静默；
// 拿不准就留在原地；说「切错了」系统自己纠回来；永远不反问。
//
// 结构（照 GPT 评审的建议）：
//   一个微信聊天 → 若干「话题线程 Thread」→ 每个线程指向一个 DSH 会话（head）。
//   线程上下文满了照旧走交接换段：旧段冻结进 segments，head 指向新段。切回只进 head，不进旧段。
//   同一时刻前台只有一个线程（fg），dsh-sessions.json / dsh-session-meta.json 里放的永远是前台线程的
//   sid 和 meta —— 所以 proxy.mjs 原有的交接/回忆/叫停/改向逻辑一行不用改，切话题 = 把这两份状态整体换掉。
//
// 判定（实测过：本地 qwen 1.5B 在这题上基本是按位置瞎猜，不能当裁判）：
//   ① 零成本粗筛：短句/确认/指代（继续、好的、第二个…）直接留原地；bigram+idf 词面相似度看像不像别的线程
//   ② 只有「可能该切」时才请裁判：dsh headless 单问一句（DeepSeek，约 6 秒，不跑工具，单独目录不污染主会话）
//   ③ 裁判 + 词面双重门槛才切；裁判挂了/超时/输出乱码 → 一律留原地
//   ④ 防抖：切完后 2 条实质消息内门槛更高
//
// 纯逻辑，依赖全部注入（便于 threads-selftest.mjs 离线自测）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { entities, redact } from '/home/aibox/wx-router/topic-tools.mjs';

// ---------- 阈值（都可被 createRouter 的 opts.th 覆盖） ----------
export const DEFAULT_TH = {
  judgeIfCurBelow: 0.20,   // 当前线程词面相似度低于这个 → 可能跑题了，请裁判
  judgeIfOtherAbove: 0.15, // 某个旧线程词面相似度高于这个且高于当前 → 可能想回去，请裁判
  switchSure: 0.85,        // 裁判把握 ≥ 这个才切回旧线程…
  switchSureNoLex: 0.93,   // …且词面也支持（旧线程 ≥ 当前）；词面不支持时要 ≥ 这个
  newSure: 0.85,           // 开新线程的把握门槛（实测：DeepSeek 对明确新事给 0.85~0.9，对闲聊一律给 C）
  newMaxCurLex: 0.20,      // 开新线程还要求：跟当前线程词面几乎不沾边
  newMinLen: 6,            // 太短的句子不开新线程
  cooldownBonus: 0.07,     // 防抖期内门槛加这么多
  cooldownMsgs: 2,         // 切完后几条实质消息算防抖期
  hintSure: 0.60,          // 用户说「切错了」、系统没切过时，重新找归属的门槛（放宽）
  revertWindowMs: 30 * 60e3, // 「切错了」只撤回 30 分钟内的切换
  revertMaxMsgs: 2,        // 切换后最多再聊了几条仍可撤回
  maxCandidates: 5,        // 裁判最多看几个旧线程
  maxAnchors: 40,          // 每个线程记最近多少句用户原话（做词面画像）
  // ---- 中途插话（steer）分流：问的是「还是同一件事吗」，不是「归哪个会话」 ----
  steerSameSure: 0.55,     // 判「同一件事」的把握门槛（低一点：插话本就该接住，打断是主用途）
  steerOtherSure: 0.85,    // 判「另一件事」的把握门槛（Claude 2026-09-28 建议 0.70→0.85：
                           //   误判成别的话题 = 主人被晾几分钟且没回执，正好踩中他抱怨的"像排队"）
  steerOtherMaxCurLex: 0.10, // 判「另一件事」还要求：跟当前话题词面几乎不沾边
};

// ---------- 文本工具 ----------
const STOP = new Set(['那个','这个','怎么','什么','现在','已经','可以','帮我','一下','我们','你们','他们','的时','时候','不是','就是','还有','没有','知道','告诉','看看','咱们','一个','这样','那样','然后','因为','所以','如果','但是','还是','或者','的话','我的','你的','他的','是不','不要','需要','应该','能不','好的','是的','给我','我想','你看','你再','再看','一点','有点','这么','那么','为什么','了吗','了没','吗？','了，','的，']);
export function tokens(s) {
  const txt = String(s || '').toLowerCase();
  const out = new Set();
  // 英文/文件名/服务名整体保留（wx-router、proxy.mjs、502 这类是最强的话题信号）
  for (const w of txt.match(/[a-z0-9][a-z0-9._\-]*[a-z0-9]/g) || []) if (w.length >= 3 || /[a-z]/.test(w)) out.add(w);
  const cjk = txt.replace(/[^一-龥]+/g, ' ');
  for (const seg of cjk.split(/\s+/)) for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  for (const w of STOP) out.delete(w);
  out.delete('');
  return out;
}
// 转场词（arXiv 2605.09268：显式转场线索能显著提高"换话题"的识别率）→ 一定请裁判，并在题目里点出来
const PIVOT_CUE_RE = /(换个话题|说个别的|另外|对了|顺便问|顺便说|还有个事|还有件事|问个事|插一句|题外话|先不说这个|先放一放|说回|回到(之前|刚才|那个|上次)|之前那个|上次那个|前面那个|那件事|那个事)/;
export function pivotCue(s) { const m = String(s || '').match(PIVOT_CUE_RE); return m ? m[0] : null; }
// 短句/确认/指代：这些一律留在当前线程，连裁判都不请
const TRIVIAL_RE = /^(继续|接着|接着做|接着来|好|好的|好吧|好滴|行|行吧|可以|可以的|嗯+|哦+|噢|对|对的|是的|没错|ok|okay|收到|谢谢|多谢|谢了|辛苦了?|再来|再试|再试一次|重试|就这样|就这么办|按你说的|按你说的做|第[一二三四五六七八九十\d]+个|选[一二三四五六七八九十\d]+|[1-9])[。！!，,~～.…]*$/i;
export function isTrivial(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  if (t.startsWith('/')) return true;
  if (t.length <= 3) return true;
  return TRIVIAL_RE.test(t);
}
// 「切错了」—— 用户说话题/会话放错了。刻意不收「不对」「不是这个」「搞错了」「搞混了」：那些多半是纠正做法（steer），不是换话题。
const MISROUTE_RE = /^(你)?(切错了|切错会话了|切错话题了|串台了|串了|走错片场了|话题错了|话题串了|对话串了|不是(在)?(聊|说)这个(话题|事)?|不是这个话题|不是这件事|说的不是这件事|我说的是另一件事|我说的是另外一件事|我说的不是这个事|你接错话了|你接错了话题)/;
export function misrouteClaim(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 40) return null;
  const m = t.match(MISROUTE_RE);
  if (!m) return null;
  const extra = t.slice(m[0].length).replace(/^[，,。.！!：:\s]+/, '').replace(/^(啊|吧|呀|哦)[，,。.！!\s]*/, '').trim();
  return { extra };
}
const cut = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const ago = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? m + ' 分钟前' : m < 1440 ? Math.round(m / 60) + ' 小时前' : Math.round(m / 1440) + ' 天前'; };
const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });

// ---------- 裁判输出解析 ----------
export function parseJudge(out, ids) {
  const s = String(out || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j; try { j = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  const pick = String(j.pick || '').trim().toUpperCase();
  const sure = Number(j.sure);
  if (!Number.isFinite(sure)) return null;
  if (pick !== 'C' && pick !== 'NEW' && !ids.includes(pick)) return null;
  const pivot = typeof j.pivot === 'boolean' ? j.pivot : (String(j.pivot).toLowerCase() === 'true' ? true : String(j.pivot).toLowerCase() === 'false' ? false : undefined);
  return { pick, pivot, why: cut(j.why || '', 80), sure: Math.max(0, Math.min(1, sure)), title: cut(j.title || '', 16), curTitle: cut(j.cur_title || '', 16) };
}

// 中途插话裁判的输出解析：{"same":true,"sure":0.8}
export function parseSteerJudge(out) {
  const s = String(out || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j; try { j = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  const sure = Number(j.sure);
  if (!Number.isFinite(sure)) return null;
  // same 兼容布尔与字符串写法
  let same;
  if (typeof j.same === 'boolean') same = j.same;
  else { const v = String(j.same).trim().toLowerCase(); if (v === 'true') same = true; else if (v === 'false') same = false; else return null; }
  return { same, sure: Math.max(0, Math.min(1, sure)) };
}

// ---------- 切回时的环境对账：那段时间里被改过的文件 ----------
const SKIP_DIRS = new Set(['inbox', 'outbox', 'node_modules', '.git', 'archive', 'helper-jobs', '.cache']);
const SKIP_FILE = /(\.bak|\.bak-|\.good$|\.before-restart$|router\.log|dsh-live\.json|dsh-sessions\.json|dsh-session-meta\.json|dsh-threads\.json|go-state\.json|\.tmp$|\.log$|\.jsonl$|\.swp$)/;
export function changedFilesSince(dirs, since, { maxDepth = 3, limit = 12 } = {}) {
  const hits = [];
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.dsh') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < maxDepth && !SKIP_DIRS.has(e.name)) walk(p, depth + 1); continue; }
      if (!e.isFile() || SKIP_FILE.test(e.name)) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs > since) hits.push({ p, m: st.mtimeMs });
      if (hits.length > 2000) return;
    }
  };
  for (const d of dirs) walk(d, 1);
  hits.sort((x, y) => y.m - x.m);
  return hits.slice(0, limit);
}

// ---------- 裁判：dsh headless 单问一句 ----------
// 单独 cwd（不读 dsh-work/AGENTS.md、会话不混进主会话目录）；不传 --session-id（每次全新，不带历史）；
// 超时/失败返回 null → 调用方一律"留在原地"。
export function makeDshJudge({ bin, cwd, fallbackPatch, useFallback, timeoutMs = 40000, log = () => {} }) {
  let lastPrune = 0;
  const prune = () => {
    if (Date.now() - lastPrune < 6 * 3600e3) return;
    lastPrune = Date.now();
    try {
      const root = path.join(process.env.HOME || '/home/aibox', '.dsh', 'sessions');
      const dir = path.join(root, '-' + cwd.replace(/\//g, '-') + '--');
      if (!fs.existsSync(dir) || !/thread-judge/.test(dir)) return;
      let n = 0;
      for (const e of fs.readdirSync(dir)) {
        const p = path.join(dir, e);
        try { if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600e3) { fs.rmSync(p, { recursive: true, force: true }); n++; } } catch {}
      }
      if (n) log('thread judge pruned ' + n + ' old session(s)');
    } catch {}
  };
  return (prompt) => new Promise((resolve) => {
    try { fs.mkdirSync(cwd, { recursive: true }); } catch {}
    prune();
    const args = ['--profile', 'headless'];
    if (useFallback && useFallback()) args.push('--patch', fallbackPatch);
    args.push('-');
    let out = '', done = false;
    const child = spawn(bin, args, { cwd, env: { ...process.env, DSH_PERMISSION_MODE: 'read-only', OPENCODE_SESSION: 'ses_thread_judge' }, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    const fin = (v) => { if (done) return; done = true; clearTimeout(t); resolve(v); };
    const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} log('thread judge TIMEOUT'); fin(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); if (out.length > 20000) out = out.slice(-20000); });
    child.on('error', (e) => { log('thread judge spawn ERROR ' + e.message); fin(null); });
    child.on('close', () => fin(out));
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// ---------- 路由器 ----------
// deps:
//   stateFile                      线程表落盘位置
//   getSid(chat) / setSid(chat,sid) 前台会话 sid（proxy 的 dsh-sessions.json）
//   getMeta(chat) / putMeta(chat,m) 前台会话 meta（proxy 的 dsh-session-meta.json；m=null 删除）
//   judge(prompt) → Promise<string|null>
//   seedAnchors(chat) → string[]   首次迁移时拿来给「老主线」做画像（近期用户原话）
//   watchDirs                      切回时对账扫哪些目录
//   log, now, th, enabled, shadow
export function createRouter(deps) {
  const th = { ...DEFAULT_TH, ...(deps.th || {}) };
  const now = deps.now || Date.now;
  const log = deps.log || (() => {});
  const enabled = deps.enabled !== false;
  const shadow = !!deps.shadow;            // 影子模式：照常判定、写日志，但永不真切

  function load() { try { return JSON.parse(fs.readFileSync(deps.stateFile, 'utf8')); } catch { return { version: 1, chats: {} }; } }
  function save(st) {
    const tmp = deps.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
    fs.renameSync(tmp, deps.stateFile);
  }
  function newThread(c, { title, origin, titleAuto = true }) {
    c.seq = (c.seq || 0) + 1;
    const id = 'th' + c.seq;
    c.threads[id] = { id, title: title || '新话题', titleAuto, origin, head: null, segments: [], meta: null, createdAt: now(), lastActiveAt: now(), anchors: [], lastReply: '', status: 'open' };
    return c.threads[id];
  }
  // 首次见到这个聊天：把现有会话收编成第一个线程「老主线」
  function ensure(st, chat) {
    let c = st.chats[chat];
    if (c) return c;
    c = st.chats[chat] = { fg: null, seq: 0, cooldown: 0, lastSwitch: null, lastUser: null, threads: {} };
    const t = newThread(c, { title: '之前的主线对话', origin: 'migrate' });
    t.head = deps.getSid(chat) || null;
    t.meta = deps.getMeta(chat) || null;
    let seeds = []; try { seeds = (deps.seedAnchors && deps.seedAnchors(chat)) || []; } catch {}
    t.anchors = seeds.filter((s) => s && !isTrivial(s)).slice(0, th.maxAnchors).map((x) => ({ t: cut(x, 200), at: now() }));
    c.fg = t.id;
    log('threads migrate chat=' + String(chat).slice(0, 6) + ' head=' + (t.head || '-') + ' seeds=' + t.anchors.length);
    return c;
  }
  // 前台线程的真实 sid/meta 在 proxy 那两份文件里（交接换段、改向重跑都会改它），每次用前先同步回线程表
  function syncFg(c, chat) {
    const t = c.threads[c.fg];
    if (!t) return;
    const sid = deps.getSid(chat) || null;
    // 交接换段 / 冷切：旧段冻结进 segments（只读历史），head 跟着 proxy 走；sid 被清空时 head 也清空，
    // 绝不把一个已经交接掉的旧段当 head 再唤醒（那会时间线分叉）
    if (t.head && t.head !== sid && !t.segments.includes(t.head)) t.segments.push(t.head);
    t.head = sid;
    t.meta = deps.getMeta(chat) || null;
  }
  function openThreads(c) { return Object.values(c.threads).filter((t) => t.status === 'open'); }

  // ---- 实体画像（参考 Pull 的 Purifier：文件/服务/IP/英文标识/书名号词，零模型调用、毫秒级）----
  function addEntities(t, text) {
    t.ents = t.ents || {};
    for (const e of entities(text)) t.ents[e] = now();
    const keys = Object.keys(t.ents);
    if (keys.length > 80) keys.sort((a, b) => t.ents[a] - t.ents[b]).slice(0, keys.length - 80).forEach((k) => delete t.ents[k]);
  }
  function entScores(c, text) {
    const q = entities(text); const res = new Map();
    for (const t of openThreads(c)) { const e = t.ents || {}; let n = 0; for (const x of q) if (e[x]) n++; res.set(t.id, q.size ? n / q.size : 0); }
    return { res, n: q.size };
  }
  // ---- 词面画像：线程内所有用户原话 + 标题 → bigram；idf 跨全部线程的句子算 ----
  function lexScores(c, text) {
    const q = tokens(text);
    const docs = [];
    const perThread = new Map();
    for (const t of openThreads(c)) {
      const set = new Set();
      const all = [t.title, ...t.anchors.map((a) => a.t)];
      for (const s of all) { const tk = tokens(s); docs.push(tk); for (const w of tk) set.add(w); }
      if (t.lastReply) for (const w of tokens(t.lastReply)) set.add(w);
      perThread.set(t.id, set);
    }
    const N = docs.length || 1;
    const df = (w) => { let n = 0; for (const d of docs) if (d.has(w)) n++; return n; };
    const idf = new Map();
    let denom = 0;
    // 哪个话题里都没出现过的 bigram（多半是跨词碎片"的圆""环颜"）只轻计 0.15，不然长句永远得分很低
    for (const w of q) {
      const d = df(w);
      let inAny = d > 0;
      if (!inAny) for (const set of perThread.values()) if (set.has(w)) { inAny = true; break; }
      const v = inAny ? Math.log(1 + N / (1 + d)) : 0.15;
      idf.set(w, v); denom += v;
    }
    const res = new Map();
    for (const [id, set] of perThread) {
      let num = 0;
      for (const w of q) if (set.has(w)) num += idf.get(w);
      res.set(id, denom > 0 ? num / denom : 0);
    }
    return res;
  }

  // 中途插话（steer）专用 prompt。
  // 与 buildPrompt 的关键区别：那边问「这句该交给哪个会话」，默认答案是 C（留住最安全）；
  // 这里问的是「这句是不是还在说同一件事」，**没有默认偏向**，就是要一个干脆的是/否。
  // 因为插话的动作是"打断正在跑的任务" —— 判错的代价是两个方向都不小，必须问对问题。
  function buildSteerPrompt(cur, text) {
    const recent = cur.anchors.slice(-6).map((a) => '   - ' + cut(a.t, 70)).join('\n') || '   （还没有）';
    let p = '你是话题一致性裁判。不要调用任何工具，不要解释，直接输出一行 JSON。\n' +
      '场景：主人正在让助手做一件任务，助手还在做。主人现在又发来一句。\n' +
      '你要判断：**主人这句新话，还是在说刚才这件任务吗？**\n' +
      '现在时间：' + fmtTime(now()) + '\n\n' +
      '正在进行的任务：\n  标题：' + cur.title + '\n  最近几句（旧→新）：\n' + recent + '\n' +
      (cur.lastReply ? '  助手说到哪了：' + cut(cur.lastReply, 200) + '\n' : '') + '\n' +
      '主人现在这句：<<<' + cut(text, 300) + '>>>\n\n' +
      '判断规则：\n' +
      '1. 这句是在**修改、补充、纠正、追问**上面这件任务 → same=true。\n' +
      '   例：改要求、加条件、换个做法、催进度、问"到哪了"、说"不对再改改"、"把日志也加上"。\n' +
      '2. 这句是**另一件不相干的事** → same=false。\n' +
      '   例：正在改代码，突然问"杭州那边吃饭有推荐吗"；正在写方案，突然问"明天天气"。\n' +
      '3. 对当前任务**成果的后续处理** → same=true。\n' +
      '   例："记到知识库里"、"写进交接"、"发给我"、"总结一下"、"这个坑记下来"、"再检查一遍"。\n' +
      '   这些虽然不含任务关键词，但都是接着当前任务在做，算同一件事。\n' +
      '4. 判断依据是**内容是否相关**，不是句子长短、也不是有没有礼貌。\n' +
      '5. 真的拿不准才选 true。别因为"怕打断"就一律 true —— 那这个功能就白做了。\n' +
      '6. sure 是你对 same 的把握（0~1），要诚实。\n' +
      '输出格式：{"same":true,"sure":0.0}';
    return p;
  }

  function buildPrompt(c, text, cands, hint, cue) {
    const cur = c.threads[c.fg];
    const recent = cur.anchors.slice(-5).map((a) => '   - ' + cut(a.t, 70)).join('\n') || '   （还没有）';
    const allTitles = openThreads(c).filter((t) => t.id !== cur.id && !cands.includes(t)).sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 30)
      .map((t) => '「' + t.title + '」（' + ago(now() - t.lastActiveAt) + '）');
    let p = '你是话题路由裁判。不要调用工具，直接输出一个 JSON 对象。\n' +
      '背景：主人只用一个微信聊天框，后台按"话题"分成几个会话，每个会话只记自己那件事的上下文。话题分对了，助手更专注、也更省；分错了，助手会把不相干的旧内容带进来答错。\n' +
      '现在时间：' + fmtTime(now()) + '\n\n' +
      '当前会话 [C]：\n  标题：' + cur.title + '\n  主人最近几句（旧→新）：\n' + recent + '\n' +
      (cur.lastReply ? '  助手上一条回复：' + cut(cur.lastReply, 160) + '\n' : '') + '\n';
    if (cands.length) {
      p += '最可能相关的旧会话：\n';
      cands.forEach((t, i) => {
        p += '[T' + (i + 1) + '] 「' + t.title + '」（上次聊：' + ago(now() - t.lastActiveAt) + '）\n  主人说过：' +
          (t.anchors.slice(-4).map((a) => cut(a.t, 50)).join(' / ') || '（无）') + (t.lastReply ? '\n  助手说到：' + cut(t.lastReply, 80) : '') + '\n';
      });
    }
    if (allTitles.length) p += '其它旧会话（只有标题，不能选；如果新消息明显属于它们，说明候选没列全，在 why 里写出标题）：' + allTitles.join('、') + '\n';
    p += '\n';
    if (hint) {
      p += '注意：主人刚说「' + cut(hint.claim, 40) + '」——他上一句「' + cut(hint.prev, 120) + '」被放错会话了。请判断他要聊的事属于哪个 T，或是 NEW。可以放宽，比较像就选那个 T。\n';
      p += '新消息：<<<' + cut(hint.prev + '\n' + hint.claim, 300) + '>>>\n\n';
    } else {
      p += '新消息：<<<' + cut(text, 300) + '>>>\n' + (cue ? '（主人用了转场词「' + cue + '」—— 常常意味着换话题或回到旧话题，认真判断）\n' : '') + '\n';
    }
    p += '分两步判断（先想清楚再选）：\n' +
      '第一步 pivot：这条新消息的**主题**（在说哪件事/哪个东西）还是 C 在做的那件事吗？\n' +
      '  - 是 C 的继续、补充、追问、对上一条回复的反应、催进度、确认 → pivot=false。\n' +
      '  - 说的是另一件事（另一个设备/项目/问题/任务）→ pivot=true。\n' +
      '  - 别因为"前面一直在聊 C"就默认没换：前面聊得越久，越容易漏掉换话题，要按这条消息本身的主题判断。\n' +
      '第二步（只有 pivot=true 才做）：它属于哪个旧会话 T？都不是 → NEW。\n' +
      '  - 小的一次性问题（问天气、查个单号、翻译一句）也选 NEW，不要塞进 C —— 否则 C 里混进不相干的内容。\n' +
      '  - pivot=false 时 pick 必须是 C。\n' +
      'sure = 你对最终 pick 的把握（0~1），诚实给。why = 一句话理由（先写它）。\n' +
      '输出：{"why":"一句话理由","pivot":true或false,"pick":"C 或 T1/T2… 或 NEW","sure":0.0,"title":"pick=NEW 时给新话题起的标题（≤12字）","cur_title":"用≤12字概括 C 在聊什么"}';
    return p;
  }

  // 把前台从当前线程换到 target：先把当前 sid/meta 存回线程，再把 target 的装进 proxy 的两份文件
  function swapTo(c, chat, target) {
    syncFg(c, chat);
    const from = c.threads[c.fg];
    if (from) from.lastActiveAt = Math.max(from.lastActiveAt, now());
    if (target.head) {
      deps.setSid(chat, target.head);
      // resumedAt：proxy 的日切判定用它（否则切回一个昨天的线程会立刻被"日切"压缩掉，白切）
      deps.putMeta(chat, { ...(target.meta || {}), sid: target.head, startedAt: (target.meta && target.meta.startedAt) || now(), resumedAt: now(), lastMsgAt: now() });
    } else {
      deps.setSid(chat, null);
      // 新线程：fileInjectedAt 置上 → proxy 不会把"最近一份手写交接"当成上一会话灌进来（那是别的话题的）
      deps.putMeta(chat, { ...(target.meta || {}), fileInjectedAt: now(), msgCount: (target.meta && target.meta.msgCount) || 0 });
    }
    c.fg = target.id;
  }
  function addAnchor(t, text) {
    if (!text || isTrivial(text)) return;
    text = redact(text);                                   // 话题表里绝不存密码
    addEntities(t, text);
    t.anchors.push({ t: cut(text, 200), at: now() });
    if (t.anchors.length > th.maxAnchors) t.anchors.splice(0, t.anchors.length - th.maxAnchors);
  }
  function reconcileNote(c, target, prevActive) {
    const gap = now() - prevActive;
    const others = openThreads(c).filter((t) => t.id !== target.id && t.lastActiveAt > prevActive).map((t) => '「' + t.title + '」');
    let files = [];
    try { files = changedFilesSince(deps.watchDirs || [], prevActive); } catch {}
    let s = '【系统提示 — 主人看不到这段，别在回复里提"切换/会话/话题"这些事，像一直在聊一样自然接上】\n' +
      '主人这条消息接的是你这个会话里的老话题「' + target.title + '」。你上次在这里说话是 ' + ago(gap) + '（' + fmtTime(prevActive) + '），现在是 ' + fmtTime(now()) + '。\n';
    if (others.length) s += '这段时间主人在别的会话里还聊过：' + others.slice(0, 5).join('、') + '（那边的事你不知道，需要时按交接目录/知识库查）。\n';
    if (files.length) s += '这段时间里这些文件被改过 —— 你记得的内容可能过期了，涉及它们先重新看一眼再下结论：\n' +
      files.map((f) => '- ' + f.p + '（' + new Date(f.m).toTimeString().slice(0, 5) + '）').join('\n') + '\n';
    return s + '\n';
  }
  function newThreadNote(prevTitle) {
    return '【系统提示 — 主人看不到这段，别在回复里提】主人开了个新话题（跟之前的「' + prevTitle + '」无关），这是专门给它的新会话。以前的事按交接目录/知识库查，别提"新会话"。\n\n';
  }

  // 主入口：在 proxy 把消息交给 DSH 之前调用
  // 返回 { action: 'stay'|'switch'|'new', prefix, resumed, title, why, reask? }
  async function route(chat, text, opts = {}) {
    const st = load();
    const c = ensure(st, chat);
    syncFg(c, chat);
    const cur = c.threads[c.fg];
    const clean = String(text || '').trim();
    const res = { action: 'stay', prefix: '', resumed: false, title: cur.title, why: '' };
    const finish = (r) => {
      const t = c.threads[c.fg];
      if (!opts.hint) {
        if (t.titleAuto && t.title === '新话题' && !isTrivial(clean)) t.title = cut(clean, 12);
        addAnchor(t, clean);
      }
      t.lastActiveAt = now();
      if (!opts.hint && !isTrivial(clean)) {
        c.lastUser = { text: cut(redact(opts.fullText || clean), 1200), at: now(), thread: c.fg };
        if (r.action === 'stay' && c.lastSwitch && c.lastSwitch.to === c.fg && c.lastSwitch.texts.length <= th.revertMaxMsgs) c.lastSwitch.texts.push(opts.fullText || clean);
      }
      save(st);
      return { ...r, title: t.title };
    };
    if (!enabled) return finish({ ...res, why: 'disabled' });
    if (!opts.hint && isTrivial(clean)) return finish({ ...res, why: 'trivial' });
    // 刚 /new 的空话题：第一句就留在这（主人明确要新开，别一上来就被拉回旧话题）
    if (!opts.hint && !cur.head && cur.anchors.length === 0 && cur.origin === 'cmd-new') return finish({ ...res, why: 'fresh-new' });

    const qtext = opts.hint ? (opts.hint.prev + ' ' + clean) : clean;
    const lex0 = lexScores(c, qtext), ent = entScores(c, qtext);
    const lex = new Map([...lex0].map(([id, v]) => [id, Math.max(v, (ent.res.get(id) || 0))]));   // 词面、实体取强的那个
    const cue = opts.hint ? null : pivotCue(clean);
    const curLex = lex.get(cur.id) || 0;
    const others = openThreads(c).filter((t) => t.id !== cur.id);
    const byLex = others.slice().sort((a, b) => (lex.get(b.id) || 0) - (lex.get(a.id) || 0));
    const byRecent = others.slice().sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const cands = [];
    for (const t of [...byLex.slice(0, 3), ...byRecent.slice(0, 2), ...byLex.slice(3)]) {
      if (cands.length >= th.maxCandidates) break;
      if (!cands.includes(t) && !(c.blocked && c.blocked.id === t.id && c.blocked.left > 0)) cands.push(t);
    }
    const bestOther = byLex[0] ? (lex.get(byLex[0].id) || 0) : 0;
    const inCooldown = (c.cooldown || 0) > 0;
    if (!opts.hint) {
      if (c.cooldown > 0) c.cooldown--;
      if (c.blocked && c.blocked.left > 0) { c.blocked.left--; if (!c.blocked.left) c.blocked = null; }
    }
    const needJudge = !!opts.hint || !!cue || curLex < th.judgeIfCurBelow || (bestOther >= th.judgeIfOtherAbove && bestOther > curLex);
    const lexTag = 'cur=' + curLex.toFixed(2) + ' best=' + bestOther.toFixed(2) + (byLex[0] ? '(' + byLex[0].id + ')' : '');
    if (!needJudge) return finish({ ...res, why: 'lex-stay ' + lexTag });

    const ids = cands.map((_, i) => 'T' + (i + 1));
    let out = null;
    try { out = await deps.judge(buildPrompt(c, clean, cands, opts.hint ? { prev: opts.hint.prev, claim: clean } : null, cue)); } catch (e) { log('thread judge ERROR ' + String((e && e.message) || e)); }
    const j = parseJudge(out, ids);
    if (j && j.pivot === false && j.pick !== 'C') { j.pick = 'C'; }            // 先判"没换话题"就一律留下（两步判定的护栏）
    if (!j) { log('thread judge unusable chat=' + String(chat).slice(0, 6) + ' out=' + JSON.stringify(cut(out || '', 120))); return finish({ ...res, why: 'judge-fail ' + lexTag }); }
    if (j.curTitle && cur.titleAuto && (cur.anchors.length < 4 || cur.anchors.length % 8 === 0)) cur.title = j.curTitle;   // 刚开始时起名，之后每 8 条刷新一次（不随每次判定漂移，也不永远卡在第一个名字）
    const bonus = inCooldown && !opts.hint ? th.cooldownBonus : 0;
    const jTag = 'judge=' + j.pick + '@' + j.sure.toFixed(2) + (j.why ? ' 「' + j.why + '」' : '') + (cue ? ' cue=' + cue : '') + ' ' + lexTag + (inCooldown ? ' cooldown' : '');

    // —— 切回某个旧线程 ——
    if (j.pick.startsWith('T')) {
      const target = cands[ids.indexOf(j.pick)];
      const tLex = lex.get(target.id) || 0;
      const ok = opts.hint
        ? j.sure >= th.hintSure
        : j.sure >= th.switchSure + bonus && (tLex >= curLex || j.sure >= th.switchSureNoLex + bonus);
      if (!ok) return finish({ ...res, why: 'judge-weak ' + jTag });
      if (shadow) { log('thread SHADOW would switch ' + cur.id + '→' + target.id); return finish({ ...res, why: 'shadow ' + jTag }); }
      const prevActive = target.lastActiveAt;
      swapTo(c, chat, target);
      c.cooldown = th.cooldownMsgs;
      c.lastSwitch = { from: cur.id, to: target.id, kind: 'resume', at: now(), texts: [opts.fullText || clean] };
      if (opts.hint) { c.lastSwitch.texts = [opts.hint.prev]; addAnchor(target, opts.hint.prev); }
      return finish({ action: 'switch', resumed: true, prefix: reconcileNote(c, target, prevActive), why: jTag, from: cur.id, to: target.id,
        reask: opts.hint ? opts.hint.prev : undefined });
    }
    // —— 开新线程 ——
    if (j.pick === 'NEW') {
      const ok = opts.hint
        ? j.sure >= th.hintSure
        : j.sure >= th.newSure + bonus && curLex < th.newMaxCurLex && clean.length >= th.newMinLen;
      if (!ok) return finish({ ...res, why: 'judge-weak ' + jTag });
      if (shadow) { log('thread SHADOW would open new'); return finish({ ...res, why: 'shadow ' + jTag }); }
      const t = newThread(c, { title: j.title || cut(opts.hint ? opts.hint.prev : clean, 12), origin: opts.hint ? 'misroute' : 'judge' });
      swapTo(c, chat, t);
      c.cooldown = th.cooldownMsgs;
      c.lastSwitch = { from: cur.id, to: t.id, kind: 'new', at: now(), texts: [opts.hint ? opts.hint.prev : (opts.fullText || clean)] };
      if (opts.hint) addAnchor(t, opts.hint.prev);
      return finish({ action: 'new', resumed: false, prefix: newThreadNote(cur.title), why: jTag, from: cur.id, to: t.id,
        reask: opts.hint ? opts.hint.prev : undefined });
    }
    return finish({ ...res, why: jTag });
  }

  // 「切错了」且刚切过：撤回。返回要在原线程重答的原话；没有可撤回的返回 null
  function revert(chat) {
    const st = load();
    const c = ensure(st, chat);
    const ls = c.lastSwitch;
    if (!ls || now() - ls.at > th.revertWindowMs || ls.texts.length > th.revertMaxMsgs || c.fg !== ls.to || !c.threads[ls.from]) return null;
    syncFg(c, chat);
    const wrong = c.threads[ls.to], back = c.threads[ls.from];
    // 错放的原话从错线程画像里拿掉，挪回原线程
    const set = new Set(ls.texts.map((x) => cut(x, 200)));
    wrong.anchors = wrong.anchors.filter((a) => !set.has(a.t));
    swapTo(c, chat, back);
    for (const x of ls.texts) addAnchor(back, x);
    if (ls.kind === 'new' && wrong.anchors.length === 0) wrong.status = 'dropped'; // 误开的新线程直接作废
    c.blocked = { id: wrong.id, left: 3 };   // 接下来 3 条不许再自动切去那边
    c.cooldown = 3;
    c.lastSwitch = null;
    back.lastActiveAt = now();
    save(st);
    log('thread revert chat=' + String(chat).slice(0, 6) + ' ' + wrong.id + '→' + back.id + ' n=' + ls.texts.length);
    return { texts: ls.texts, from: wrong.id, to: back.id, title: back.title,
      prefix: '【系统提示 — 主人看不到这段，别在回复里提】主人刚才下面这句话被系统放错到了另一个会话里回答，他说放错了。现在回到这个会话，请接着这里的上下文重新回答它。\n\n' };
  }
  // 「切错了」但没切过 → 可能是该切没切。拿上一句去找归属（放宽门槛）
  function lastUserText(chat) {
    const c = load().chats[chat];
    if (!c || !c.lastUser || now() - c.lastUser.at > th.revertWindowMs) return null;
    return c.lastUser.text;
  }
  function noteReply(chat, reply) {
    const st = load();
    const c = st.chats[chat];
    if (!c) return;
    syncFg(c, chat);
    const t = c.threads[c.fg];
    if (t) { t.lastReply = cut(redact(reply), 300); addEntities(t, reply); t.lastActiveAt = now(); }
    save(st);
  }
  // /new：开一个空的新线程；旧线程原样保留，以后照样能自动切回去
  function forceNew(chat) {
    const st = load();
    const c = ensure(st, chat);
    syncFg(c, chat);
    const old = c.threads[c.fg];
    if (old) old.lastActiveAt = now();
    // 当前线程本来就是空的（刚 /new 过还没说话）就不重复开
    if (old && !old.head && old.anchors.length === 0) { save(st); return old.id; }
    const t = newThread(c, { title: '新话题', origin: 'cmd-new' });
    c.fg = t.id;
    c.lastSwitch = null; c.cooldown = 0;
    save(st);
    log('thread /new chat=' + String(chat).slice(0, 6) + ' ' + (old ? old.id : '-') + '→' + t.id);
    return t.id;
  }
  function summary(chat) {
    const c = load().chats[chat];
    if (!c) return null;
    const open = Object.values(c.threads).filter((t) => t.status === 'open');
    return { fg: c.threads[c.fg], count: open.length, threads: open.sort((a, b) => b.lastActiveAt - a.lastActiveAt) };
  }
  // 只看不改：判断这句话是否属于「当前正在跑的那个话题」，用于中途插话（steer）的分流。
  // 与 route() 的区别：绝不 swapTo、不写盘、不推进 cooldown，纯查询。
  // 返回 { same: true|false|'unknown', sure, why }
  //   same=true      同一个话题 → 调用方直接打断并在原会话续跑
  //   same=false     不同话题   → 调用方开新会话
  //   same='unknown' 判不出来   → 调用方保守选「同一话题」（插话是用户明确要调整当前任务，留住更安全）
  async function peekTopic(chat, text) {
    try {
      if (!enabled) return { same: 'unknown', sure: 0, why: 'disabled' };
      const clean = String(text || '').trim();
      if (!clean || isTrivial(clean)) return { same: 'unknown', sure: 0, why: 'trivial' };
      const st = load();
      const c = st.chats && st.chats[chat];
      if (!c) return { same: true, sure: 0, why: 'no-thread-yet' };
      const cur = c.threads[c.fg];
      if (!cur) return { same: true, sure: 0, why: 'no-fg' };
      const lex = lexScores(c, clean);
      const curLex = lex.get(cur.id) || 0;
      const others = openThreads(c).filter((t) => t.id !== cur.id);
      let bestOther = 0, bestId = null;
      for (const t of others) { const v = lex.get(t.id) || 0; if (v > bestOther) { bestOther = v; bestId = t.id; } }
      const lexTag = 'cur=' + curLex.toFixed(2) + ' best=' + bestOther.toFixed(2) + (bestId ? '(' + bestId + ')' : '');
      // 词面已足够支持「就是当前话题」→ 不必花钱请裁判
      if (curLex >= 0.28 && curLex >= bestOther) return { same: true, sure: 0, why: 'lex-same ' + lexTag };
      // 词面已足够支持「是别的旧话题」→ 直接判不同
      if (bestOther >= 0.40 && bestOther > curLex * 1.6) return { same: false, sure: 0, why: 'lex-other ' + lexTag };
      // 拿不准：请一次裁判，问「还是同一件事吗」（用 steer 专用 prompt，不是路由 prompt）
      let out = null;
      try { out = await deps.judge(buildSteerPrompt(cur, clean)); }
      catch (e) { log('peek judge ERROR ' + String((e && e.message) || e)); return { same: 'unknown', sure: 0, why: 'judge-err ' + lexTag }; }
      const j = parseSteerJudge(out);
      if (!j) return { same: 'unknown', sure: 0, why: 'judge-fail ' + lexTag };
      const jTag = 'judge same=' + j.same + '@' + j.sure.toFixed(2) + ' ' + lexTag;
      // 判成「不同话题」要够自信才真的分流；判成「同一话题」同样要够自信才打断。
      // 两边都不够自信 → unknown，调用方按同一话题处理（保守）。
      if (j.same) return { same: j.sure >= th.steerSameSure ? true : 'unknown', sure: j.sure, why: jTag };
      // 判「另一件事」：把握够 + 词面也不支持当前话题（Claude 建议），两个条件都满足才分流
      if (j.sure >= th.steerOtherSure && curLex <= th.steerOtherMaxCurLex) return { same: false, sure: j.sure, why: jTag };
      return { same: 'unknown', sure: j.sure, why: jTag };
    } catch (e) {
      log('peekTopic ERROR chat=' + String(chat).slice(0, 6) + ' ' + String((e && e.message) || e));
      return { same: 'unknown', sure: 0, why: 'error' };
    }
  }

  return { route, revert, lastUserText, noteReply, forceNew, summary, peekTopic, _load: load };
}
