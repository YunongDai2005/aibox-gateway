#!/usr/bin/env node
/**
 * wx-router: 在 Tencent iLink 前面做本机透明代理，实现"同一微信会话切换多个模型"
 * 模式：/local 本地 Ollama | /ai OpenClaw | /dsh DSH（本体 DeepSeek，可调 codex 子代理）
 * 本地/DSH 模式的消息从 getupdates 响应里摘出来，主 OpenClaw 永远看不到。
 * DSH 模式：每个聊天一条持久 DSH 会话（/new 重开）；支持收发图片/文件，
 *   入站媒体存 <dshCwd>/inbox，DSH 在回复里写 [[发送:路径]] 即可把 <dshCwd> 下的文件发回微信。
 * 维护：2026-09-26 由 Mac 端 Claude 合并（OpenClaw 版 + 会话/媒体）。改前先备份。
 * 维护：2026-09-27 加"会话交接"（参考 agent-session-harness + Zylos + project-handoff）：三个触发
 *   daily=凌晨4点日切 / idle=隔3小时没说话 / context=上下文估算到70%，65% 先预警一次；
 *   旧会话先自压缩成交接包（14 字段 + sha256 指纹，见 HANDOFF_PROMPT），存 dsh-session-meta.json 的
 *   pendingHandoff，新会话每条消息注入，首次回复末尾回写指纹确认收到、成功回复后才消费。
 *   回滚：cp proxy.mjs.bak-09272121-prehandoff proxy.mjs && sudo systemctl restart wx-router
 * 维护：2026-09-27 23:30 Mac 端 Claude 加"交接存档链"：每个自动交接包同时落盘成 handoffs/NNNN-*.md
 *   （带序号 + 上一份，/home/aibox/bin/handoff-store.mjs 负责，顺带重建 INDEX.md）；
 *   手写交接兜底只认 NNNN-*.md（INDEX.md、weekly/、archive/ 不会被当成交接灌进去）。
 *   回滚：cp proxy.mjs.bak-*-prechain proxy.mjs 后重启
 * 维护：2026-09-27 加"回忆提示"：新会话首条 / 用户提到以前的事（RECALL_RE 关键词）时，
 *   把 handoffs/INDEX.md 的行（≤2500 字）附在消息前，DSH 一定看得到目录。回滚：cp proxy.mjs.bak-*-prerecallidx
 * 维护：2026-09-28 加强"自动回忆"：① 关键词表大幅放宽（时间词/追问词/指代词/复现词）；
 *   ② 目录上限 2500→6000 字；③ 新增 rankHandoffs()：把你原话和交接标题/关键词按中文 bigram 求交集，
 *   预筛出最像的 3 份放在最前面（DSH 不用一份份翻）。回滚：cp proxy.mjs.bak-*-prerecall2
 * 维护：2026-09-28 调高压缩阈值：dshContextBudget 135000→600000（DeepSeek V4 窗口是 1M，之前只用 13%），
 *   预警 80%→85%，闲置换会话 3→8 小时。回滚：cp config.json.bak-*-prebigctx
 * 维护：2026-09-27 加"实时进度"（live.mjs）：dsh 事件流 → dsh-live.json（仪表盘读）；
 *   微信播报：45 秒后首报，之后最多 4 分钟一次；【进展】行和 GPT 外援立即转发（间隔 ≥45 秒，每任务 ≤10 条）；
 *   /进度（/状态）随时查。回滚：cp proxy.mjs.bak-*-prelive
 * 维护：2026-09-27 超时改"卡死才杀"：12 分钟无输出=卡死；总上限 60 分钟，45 分钟微信提醒；被杀时回报做到哪。回滚：*-preidle
 * 维护：2026-09-28 加"中途叫停"（interjection 第一阶段）：干活途中发「停」「先别做了」这类
 *   明确叫停（硬规则 /home/aibox/bin/stop-rules.mjs，纯正则不走模型），立即中断当前 DSH 进程。
 *   机制：每轮 runDsh 领 runId+generation 租约，五处回调校验 isCurrent；中断顺序=先失效→置 stopping→
 *   再 SIGINT(2s)→SIGTERM(3s)→SIGKILL；被中断轮次不发回复、不走 fallback、不生成交接包。
 *   入口分流在 seenBefore 之后、enqueueDsh 之前（绕开串行队列，否则打断不了）。
 *   本阶段边界：只认明确叫停，其余一律不打断（AI 分类器留到第二阶段）。
 *   回滚：cp proxy.mjs.bak-09280935-preinterrupt proxy.mjs && sudo systemctl restart wx-router
 * 维护：2026-09-28 方案甲「改方向（steer）」：任务运行途中发「补充：…」「改成…」这类
 *   改向指令（硬规则 /home/aibox/bin/steer-rules.mjs，纯正则零成本，自测 33/33），
 *   立即中断当前轮 + 沿用同一 sid 自动重跑，把用户新话包装成"中途插话"指令带给模型。
 *   与叫停的区别：叫停中断后不重跑；改方向中断后自动重跑（上下文保留）。
 *   防抖动（2026-09-28 修 ⑥）：不再是 20 秒冷却，改成「合并批次」——
 *   第一句立刻中断重跑，之后 12 秒内的补充攒成一批只再中断一次，每轮最多 3 批。
 *   判定保守：>40 字不触发、疑问句(吗/呢/?/？)不触发、「别停」类不触发、/ 命令不触发。
 *   交接（handoff）进行中不打断、不叫停，退回普通排队（2026-09-28 修 ④）。
 *   回滚：cp proxy.mjs.bak-09281015-presteer proxy.mjs && sudo systemctl restart wx-router
 * 维护：2026-09-28 Claude 外援加「无感多话题记忆」（threads.mjs）：一个聊天框背后按话题分成多个 DSH 会话，
 *   每条普通消息出队后、交给 DSH 前先判定归属（词面粗筛 → 必要时 dsh 裁判单问一句），有把握才静默切换，
 *   切换 = 把 dsh-sessions.json / dsh-session-meta.json 整体换成目标话题的（原有交接/回忆/叫停/改向不动）。
 *   切回老话题时消息前附"环境对账"（隔了多久、别的话题聊过啥、期间改过的文件）。「切错了」→ 撤回重答。
 *   /new = 开新话题，旧的还能自动切回。开关：config.json threadRouter=false 关、threadRouterShadow=true 只记日志不切。
 *   自测：node /home/aibox/wx-router/threads-selftest.mjs。回滚：cp proxy.mjs.bak-09281430-prethreads proxy.mjs 后重启
 * 维护：2026-09-28 Mac 端 Claude 加「经理」（manager.mjs，主人的构想：像跟人聊天，它干活时也能随时说话、商量）：
 *   工人（DSH）干活时，主人的话（含语音转写）先给经理：快模型 2 秒回，看工人实时状态决定 none/note/redo/stop/queue/answer；
 *   note 进信箱（工人用 mailbox 看，没看的这一轮结束后自动补交）；工人用 ask-owner 问主人，主人的回答经经理写回。
 *   经理开着时代替原来的「改方向」判定（不再按规则打断）；「停」照旧秒停。/经理 看状态，/经理开 /经理关。
 *   同时修：叫停只看文字、不看语音转写 → 语音说「停」一直不生效。回滚：cp proxy.mjs.bak-*-premanager 后重启
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import * as live from './live.mjs';
import { isHardStop } from '/home/aibox/bin/stop-rules.mjs';
import { isSteer } from '/home/aibox/bin/steer-rules.mjs';
import { createRouter, makeDshJudge, misrouteClaim } from './threads.mjs';
import * as mgr from './manager.mjs';

const ROOT = '/home/aibox/wx-router';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

// ---------- 全局兜底（2026-09-28 补） ----------
// 之前全文没有兜底：任何一个没接住的异常都会让 Node 直接杀进程。
// 本服务是 Restart=always，会被自动拉起 —— 但代价是当时那一整轮任务全丢，
// 主人看到的就是「发了消息没反应」，而且日志里连堆栈都没有。
// ask-codex 就是这么死的（0 字节 stdout/stderr，查了半天）。
// 这里只记录、不退出：让正在跑的轮次有机会自己收尾。
// 注意：故意不复用下面的 log()（它自己也可能出问题），直接同步写文件，这层兜底不依赖任何其它函数。
const _fatalLog = (msg) => {
  try { fs.appendFileSync('/home/aibox/wx-router/router.log', '[' + new Date().toISOString() + '] 【致命】' + msg + '\n'); } catch {}
};
process.on('uncaughtException', (e) => _fatalLog('uncaughtException: ' + String((e && e.stack) || e)));
process.on('unhandledRejection', (e) => _fatalLog('unhandledRejection: ' + String((e && e.stack) || e)));
const PLUGIN = '/home/aibox/.openclaw/npm/projects/weixin-plugin/node_modules/@tencent-weixin/openclaw-weixin/dist/src';
const modesFile = path.join(ROOT, 'modes.json');
const logFile = path.join(ROOT, 'router.log');
const LOCAL_TIMEOUT_MS = cfg.localTimeoutMs || 180000;
// 2026-09-27 改"卡死才杀"：连续 DSH_IDLE_MS 没有任何输出才判定卡死（bash 单条命令上限 10 分钟，所以取 12 分钟）；
// DSH_TIMEOUT_MS 只是总上限兜底（防绕圈烧额度），到 DSH_WARN_MS 先微信提醒
const DSH_TIMEOUT_MS = cfg.dshTimeoutMs || 3600000;
const DSH_IDLE_MS = cfg.dshIdleMs || 720000;
const DSH_WARN_MS = cfg.dshWarnMs || 2700000;
const DSH_BIN = cfg.dshBin || '/usr/local/bin/dsh';
const DSH_CWD = path.resolve(cfg.dshCwd || '/home/aibox/dsh-work');
const DSH_INBOX = path.join(DSH_CWD, 'inbox');
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';
const dshSessFile = path.join(ROOT, 'dsh-sessions.json');

let sendMessageWeixin = null;
async function loadSend() {
  if (!sendMessageWeixin) {
    const mod = await import(path.join(PLUGIN, 'messaging/send.js'));
    sendMessageWeixin = mod.sendMessageWeixin;
  }
  return sendMessageWeixin;
}
function log(msg) { try { fs.appendFileSync(logFile, '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch {} }
function acct() { return JSON.parse(fs.readFileSync(cfg.accountFile, 'utf8')); }
function realBase() { return ((cfg.realBase && cfg.realBase.trim()) || acct().baseUrl || '').replace(/\/+$/, ''); }
function cdnBase() { try { return (acct().cdnBaseUrl || '').trim() || CDN_BASE; } catch { return CDN_BASE; } }
function modes() { try { return JSON.parse(fs.readFileSync(modesFile, 'utf8')); } catch { return {}; } }
function setMode(chat, mode) { const m = modes(); m[chat] = mode; fs.writeFileSync(modesFile, JSON.stringify(m, null, 2)); log('mode ' + chat + ' -> ' + mode); }
function textOf(msg) {
  const items = (msg && msg.item_list) || [];
  return items.filter((i) => i && i.type === 1 && i.text_item && i.text_item.text != null).map((i) => String(i.text_item.text)).join('');
}
const seenMsgs = new Map(); // msgId -> ts
function seenBefore(msg) {
  const id = msg && (msg.message_id ?? msg.client_id ?? (msg.seq != null ? chatKey(msg) + '#' + msg.seq : null));
  if (id == null) return false;
  const k = String(id);
  if (seenMsgs.has(k)) return true;
  seenMsgs.set(k, Date.now());
  if (seenMsgs.size > 2000) { const cut = Date.now() - 3600e3; for (const [kk, ts] of seenMsgs) if (ts < cut) seenMsgs.delete(kk); }
  return false;
}
function chatKey(msg) { return msg.session_id || msg.group_id || msg.from_user_id || 'unknown'; }
function sendOpts(msg) {
  const a = acct();
  const k = ['tok', 'en'].join('');
  const opts = { baseUrl: realBase(), contextToken: msg.context_token };
  opts[k] = a[k];
  return opts;
}

// 超长文本拆成多条发
async function reply(msg, text) {
  const send = await loadSend();
  const LIMIT = 1800;
  const s = String(text);
  for (let i = 0; i < s.length; i += LIMIT) {
    await send({ to: msg.from_user_id, text: s.slice(i, i + LIMIT), opts: sendOpts(msg) });
  }
}

async function answerLocal(msg, text) {
  const chat = chatKey(msg);
  const t0 = Date.now();
  if (!text) { await reply(msg, '⚠️ 本地模型只能处理文字。图片/文件请发 /dsh 切到 DSH。').catch(() => {}); return; }
  const stopSlow = slowNotice(msg, '本地模型');
  try {
    let lastErr = null;
    let answer = '';
    for (let attempt = 1; attempt <= 2 && !answer; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), LOCAL_TIMEOUT_MS);
      try {
        const r = await fetch(cfg.ollamaUrl.replace(/\/+$/, '') + '/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: ctl.signal,
          body: JSON.stringify({ model: cfg.localModel, stream: false, keep_alive: -1, think: false, messages: [{ role: 'user', content: text }] }),
        });
        const j = await r.json();
        answer = (j && j.message && j.message.content) || '';
      } catch (e) {
        lastErr = e;
      } finally {
        clearTimeout(timer);
      }
      if (!answer && attempt === 1) { await new Promise((r) => setTimeout(r, 1500)); }
    }
    stopSlow();
    if (answer) {
      await reply(msg, answer);
      log('local reply sent chat=' + chat + ' len=' + answer.length + ' took=' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } else {
      await reply(msg, '⚠️ 本地模型没响应（' + String((lastErr && lastErr.message) || '空回复') + '）。再发一次，或发 /ai 切回我。').catch(() => {});
      log('local FAILED chat=' + chat + ' err=' + String((lastErr && lastErr.message) || 'empty'));
    }
  } catch (e) {
    log('local ERROR chat=' + chat + ' err=' + String((e && e.message) || e));
    await reply(msg, '⚠️ 本地链路出错：' + String((e && e.message) || e) + '\n发 /ai 可以切回我。').catch(() => {});
  }
}

// ---------- DSH：会话 ----------
function dshSessions() { try { return JSON.parse(fs.readFileSync(dshSessFile, 'utf8')); } catch { return {}; } }
function setDshSession(chat, sid) { const m = dshSessions(); if (sid) m[chat] = sid; else delete m[chat]; fs.writeFileSync(dshSessFile, JSON.stringify(m, null, 2)); }
// OpenCode Go 主力；额度满（或 Go 故障）时叠加 fallback 补丁回落 DeepSeek 官方 API
const FALLBACK_PATCH = '/home/aibox/.dsh/profiles/headless/fallback-deepseek.yml';
const goStateFile = path.join(ROOT, 'go-state.json');
const GO_COOLDOWN_MS = cfg.goCooldownMs || 60 * 60 * 1000;
function goCooldownUntil() { try { return JSON.parse(fs.readFileSync(goStateFile, 'utf8')).cooldownUntil || 0; } catch { return 0; } }
function setGoCooldown(ms) { fs.writeFileSync(goStateFile, JSON.stringify({ cooldownUntil: Date.now() + ms, at: new Date().toISOString() }, null, 2)); }
// 用完一次模型就顺手刷新额度（事件驱动，60 秒内最多一次）；空闲时靠 aibox-quota.timer 每 30 分钟兜底
let lastQuotaRefresh = 0;
function refreshQuota() {
  if (Date.now() - lastQuotaRefresh < 60000) return;
  lastQuotaRefresh = Date.now();
  try { spawn('/usr/bin/node', ['/home/aibox/bin/aibox-quota.mjs'], { detached: true, stdio: 'ignore' }).unref(); } catch {}
}
function noFinal(r) { return !(r.final && String(r.final).trim()); }
function isQuotaErr(t) { return /QUOTA|RATE_LIMIT|\b429\b|limit|exceed|insufficient|额度/i.test(t || ''); }
function ocSession(chat, sid) { return 'ses_' + crypto.createHash('sha1').update(chat + '|' + (sid || '')).digest('hex').slice(0, 24); }
// dshQueue 的声明挪到 enqueueChat 那里了（2026-09-28 改向 v2 步骤 1：改成显式队列）

// ---------- 中途插话：可中断运行（GPT 出稿，2026-09-28） ----------
// 思路：每轮 runDsh 领一个不可复用的 runId + generation 租约；
// stdout/stderr/close/timer 五处回调全部先校验 isCurrent，旧轮回调拿不到权限。
// 中断顺序必须是「失效 → 置 stopping → 再发信号」，反过来旧回调会抢先发旧回复。
const activeRuns = new Map();      // chat -> control { runId, generation, pid, state, interrupt() }
const dshGenerations = new Map();  // chat -> 当前有效 generation

function registerActiveRun(chat, kind) {
  return (control) => {
    control.kind = kind || 'chat';   // 'chat' = 用户任务（可中断）；'handoff' = 收尾交接（不可中断）
    activeRuns.set(chat, control);
    return {
      // 同时校验 runId、generation 和注册表对象（三者一致才算"这一轮还活着"）
      isCurrent(expectedRunId = control.runId) {
        const a = activeRuns.get(chat);
        return !!a && a === control && a.runId === expectedRunId
          && a.generation === control.generation
          && dshGenerations.get(chat) === control.generation;
      },
      ownsRunId(expectedRunId = control.runId) {
        const a = activeRuns.get(chat);
        return !!a && a === control && a.runId === expectedRunId;
      },
      // 先让 generation 失效，stdout/timer 后续回调立刻失去权限
      invalidate(expectedRunId = control.runId) {
        if (!this.ownsRunId(expectedRunId)) return false;
        if (dshGenerations.get(chat) === control.generation) dshGenerations.set(chat, control.generation + 1);
        return true;
      },
      unregister(expectedRunId = control.runId) {
        if (!this.ownsRunId(expectedRunId)) return false;
        activeRuns.delete(chat);
        return true;
      },
    };
  };
}
function beginDshGeneration(chat) { const g = (dshGenerations.get(chat) || 0) + 1; dshGenerations.set(chat, g); return g; }
function delay(ms) { return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }); }
function signalProcessGroup(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, sig); return true; } catch { return false; } // 只打本次 spawn 的进程组
}
// 外部控制路径：中断某个聊天的当前轮次
async function interruptCurrentRun(chat, expectedRunId) {
  const a = activeRuns.get(chat);
  if (!a) return false;
  if (expectedRunId && a.runId !== expectedRunId) return false;
  return a.interrupt(a.runId);
}

// ---------- 方案甲：改方向（steer）----------
// 用户在任务运行中发「补充/改成…」→ 中断当前轮 + 同一 sid 立刻重跑（上下文不丢）。
// 与「叫停」的区别：叫停中断后不重跑；改方向中断后自动带着新指令重跑。
// ---------- 改向节奏控制（2026-09-28 修 ⑥）----------
// 老实现是「同一 chat 20 秒冷却」：冷却期内的改向直接退回普通排队 —— 结果是用户急着补第二句
// 反而不生效，而 20 秒后又可以再打断一次。两头都不对。
// 新实现换成「合并批次（sealed batch）」，符合微信上的真实说话方式（人是一句一句补的）：
//   · 用户发出改向 → 立刻中断 + 重跑（第一句绝不等待，反馈最快）
//   · 随后 STEER_MERGE_MS 窗口内的补充不再重复中断，而是攒进 pendingSteer
//   · 窗口结束时把这批话合并成一条指令，只再中断一次
//   · 每轮原始任务最多合并 STEER_MAX 批，防止用户狂发把任务永远打断在原地
// 好处：连补三句只产生一次额外中断，而不是三次；也不会像老实现那样把话丢掉。
const STEER_MERGE_MS = 12000;      // 首批之后，多久内的补充合并成一批
const STEER_MAX = 3;               // 每轮原始任务最多几批改向
const pendingSteer = new Map();    // chat -> { timer, texts: [], batches }

function clearPendingSteer(chat) {
  const p = pendingSteer.get(chat);
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  pendingSteer.delete(chat);
}
// 返回 true 表示这句已被合并吸收（调用方不要再走自己的分支）
function absorbSteer(chat, text, msg) {
  let p = pendingSteer.get(chat);
  if (!p) { p = { timer: null, texts: [], batches: 0 }; pendingSteer.set(chat, p); }
  if (p.batches >= STEER_MAX) return false;      // 额度用完了，交给调用方按普通消息排队
  // text == null：只开窗口、不攒文字。调用方那句已经在入队执行了，
  // 再攒进来会在 12 秒后被合并重跑一遍（Claude 2026-09-28 审出的 Bug 2）。
  if (text != null) p.texts.push(text);
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => flushSteer(chat, p, msg), STEER_MERGE_MS);
  p.timer.unref?.();
  return true;
}
// 合并窗口到点：把攒下的话并成一批，打断当前轮接着做
function flushSteer(chat, p, msg) {
  const before = pendingSteer.get(chat);
  if (!before || before !== p) return;
  pendingSteer.delete(chat);
  p.timer = null;
  const merged = p.texts.join('\n');
  if (!merged.trim()) return;                    // 只开了窗口没攒到话 → 什么都不用做
  // 窗口结束时若这轮已经跑完了，就没什么可打断的，退回普通排队
  if (!activeRuns.has(chat)) {
    log('steer batch flushed (no active run) chat=' + chat + ' n=' + p.texts.length);
    enqueueChatSafe(chat, () => answerDsh(msg, wrapSteer(merged)), { priority: true });
    return;
  }
  const a = activeRuns.get(chat);
  if (a.kind === 'handoff') {
    log('steer batch deferred (handoff) chat=' + chat);
    enqueueChatSafe(chat, () => answerDsh(msg, merged));
    return;
  }
  p.batches++;
  log('steer batch flush chat=' + chat + ' n=' + p.texts.length + ' batch=' + p.batches);
  enqueueChatSafe(chat, () => answerDsh(msg, wrapSteer(merged)), { priority: true });
  interruptCurrentRun(chat, a.runId)
    .then((ok) => log('steer batch interrupt ' + (ok ? 'done' : 'noop') + ' chat=' + chat))
    .catch((e) => log('steer batch ERROR ' + String((e && e.message) || e)));
}
// 2026-09-28：中断路径也要把新拿到的 sessionId 落盘，否则改向重跑拿不到 sid、会开新会话丢上下文。
// 正常成功路径（第 749 行附近）本来就会保存；这里只补中断分支，逻辑保持一致。
function saveDshSessionIfAny(chat, r) {
  try {
    if (r && r.sessionId) { setDshSession(chat, r.sessionId); setDshMeta(chat, r.sessionId); }
  } catch (e) { log('saveDshSessionIfAny ERROR ' + String((e && e.message) || e)); }
}
// 把用户的补充包装成给模型的指令：明确告诉它这是中途插入的改向要求
// 2026-09-28 改（主人要求「接着往下做，不要重来」）：
//   中断不是「重置任务」，而是「按新要求改道」。所以措辞要强调**沿用已有上下文和已产出成果**，
//   只调整还没做完/需要改的部分 —— 避免模型把整件事从头再做一遍（浪费、还可能与已有文件冲突）。
function wrapSteer(userText) {
  return '[用户在你执行任务的过程中插话]\n'
    + '用户原话：' + userText + '\n'
    + '先判断这句跟**你手上正在做的任务**是什么关系：\n'
    + '· 是补充/修改/纠正/追问这件任务 → 沿用你已经掌握的上下文和工作目录里已经产出的成果，'
    + '按这条要求调整做法继续做，**不要从头重做已经做完的部分**。\n'
    + '· 是另一件不相干的事 → 先用一两句简短回应它，**然后把原来的任务继续做完**，别把原任务丢掉。\n'
    + '无论哪种，只输出最终结果，不要解释你的判断过程。';
}


function runDsh(task, sid, opts = {}) {
  return new Promise((resolve) => {
    // 启动器参数（--patch）必须在应用参数（--json 等）之前
    const args = ['--profile', 'headless'];
    if (opts.fallback) args.push('--patch', FALLBACK_PATCH);
    args.push('--json');
    if (sid) args.push('--session-id', sid);
    args.push('-');
    const child = spawn(DSH_BIN, args, { cwd: DSH_CWD, env: { ...process.env, DSH_PERMISSION_MODE: 'danger-full-access', OPENCODE_SESSION: opts.ocSession || 'ses_aibox_default' }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let buf = '', errTail = '', sessionId = sid || null, final = null, usage = 0, usagePeak = 0, errEvents = '';
    // 看门狗：总时长超上限，或连续 idleMs 没有任何输出（卡死）才杀
    const t0 = Date.now(), maxMs = opts.timeoutMs || DSH_TIMEOUT_MS, idleMs = opts.idleMs || DSH_IDLE_MS;
    let lastOut = t0, killedBy = null;
    const runId = opts.runId || crypto.randomUUID();
    const generation = opts.generation;
    let settled = false, closed = false, closeCode = null, closeSignal = null, registration = null;
    let resolveClosed; const closedPromise = new Promise((r) => { resolveClosed = r; });

    const control = {
      runId, generation, pid: child.pid, state: 'running',
      async interrupt(expectedRunId = runId) {
        if (expectedRunId !== runId) return false;              // ① runId 校验
        if (!registration?.isCurrent(runId)) return false;
        if (!registration.invalidate(runId)) return false;      // ② 先失效（关键：不能先杀）
        control.state = 'stopping'; killedBy = 'interrupt';     // ③ 再置 stopping
        signalProcessGroup(child.pid, 'SIGINT');                // ④ 分级：SIGINT → 2s
        await Promise.race([closedPromise, delay(2000)]);
        if (closed) return true;
        signalProcessGroup(child.pid, 'SIGTERM');               // ⑤ SIGTERM → 3s
        await Promise.race([closedPromise, delay(3000)]);
        if (closed) return true;
        signalProcessGroup(child.pid, 'SIGKILL');               // ⑥ 最后 SIGKILL，并主动结算防队列卡死
        finish({ code: null, signal: 'SIGKILL', stale: true, forced: true });
        return true;
      },
    };
    // 没有 register 时退化为"不可外部中断"（保持老行为）
    registration = opts.register ? opts.register(control) : {
      isCurrent: (r = runId) => r === runId, ownsRunId: (r = runId) => r === runId,
      invalidate: (r = runId) => r === runId, unregister: () => true,
    };

    function finish({ code = closeCode, signal = closeSignal, stale = false, forced = false } = {}) {
      if (settled) return;                       // 幂等：interrupt 和 close 可能都来
      settled = true;
      if (timer) clearInterval(timer);
      const interrupted = killedBy === 'interrupt';
      control.state = 'closed';
      if (registration?.ownsRunId(runId)) registration.unregister(runId);
      if (killedBy) log('dsh ended by=' + killedBy + ' after=' + Math.round((Date.now() - t0) / 1000) + 's idle=' + Math.round((Date.now() - lastOut) / 1000) + 's');
      // 注意：无论是否被中断都要 resolve —— 否则 dshQueue 会永久卡住
      resolve({
        code, signal, killedBy, interrupted, stale, forced, runId, generation,
        sessionId, final, usage, usagePeak,
        errTail: (errEvents + ' ' + errTail).trim(), fallback: !!opts.fallback,
      });
    }

    const kill = (why) => { killedBy = why; signalProcessGroup(child.pid, 'SIGKILL') || (() => { try { child.kill('SIGKILL'); } catch {} })(); finish(); };
    let timer = setInterval(() => {
      if (settled || !registration.isCurrent(runId)) return;  // 旧 timer 不许误杀新进程
      const now = Date.now();
      if (now - t0 >= maxMs) kill('max');
      else if (now - lastOut >= idleMs) kill('idle');
    }, 5000);
    child.stdout.on('data', (d) => {
      if (settled || !registration.isCurrent(runId)) return;  // 旧轮回调直接丢弃
      lastOut = Date.now();
      buf += d.toString('utf8');
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (settled || !registration.isCurrent(runId)) return; // onEvent 可能同步触发中断
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (opts.onEvent) { try { opts.onEvent(j); } catch {} } // 实时进度（live.mjs）
        if (j.type === 'session' && j.sessionId) sessionId = j.sessionId;
        else if (j.type === 'final') final = j.text;
        else if (j.type === 'status' && j.phase === 'step_end' && j.usage) {
          // 单步输入规模 = 未命中缓存 + 命中缓存（漏掉 cacheRead 会把上下文严重低估）
          const it = (j.usage.inputTokens || 0) + (j.usage.cacheReadTokens || 0) + (j.usage.cacheWriteTokens || 0);
          usage += it;
          if (it > usagePeak) usagePeak = it; // 单步峰值≈当前上下文规模
        }
        else if (j.type === 'error' || (j.type === 'status' && j.phase === 'turn_end' && j.reason && j.reason.kind !== 'completed')) errEvents = (errEvents + ' ' + JSON.stringify(j)).slice(-800);
      }
    });
    child.stderr.on('data', (d) => { if (settled || !registration.isCurrent(runId)) return; lastOut = Date.now(); errTail = (errTail + d.toString('utf8')).slice(-600); });
    child.on('error', (e) => { if (settled) return; errTail = (errTail + ' spawn: ' + e.message).slice(-600); });
    child.on('close', (code, signal) => {
      closed = true; closeCode = code; closeSignal = signal; resolveClosed?.();
      finish({ code, signal });                 // 被中断后 isCurrent 已 false，final 会被 answerDsh 丢弃
    });
    child.stdin.on('error', (e) => { if (settled || !registration.isCurrent(runId)) return; errTail = (errTail + ' stdin: ' + e.message).slice(-600); });
    child.stdin.end(task);
  });
}

// ---------- DSH：图片/文件/语音 ----------
let mediaMods = null;
async function loadMedia() {
  if (!mediaMods) {
    const dl = await import(path.join(PLUGIN, 'media/media-download.js'));
    const sm = await import(path.join(PLUGIN, 'messaging/send-media.js'));
    const mime = await import(path.join(PLUGIN, 'media/mime.js'));
    mediaMods = { downloadMediaFromItem: dl.downloadMediaFromItem, sendWeixinMediaFile: sm.sendWeixinMediaFile, extFromMime: mime.getExtensionFromMime };
  }
  return mediaMods;
}
// 与插件 process-message 相同的优先级：图片 > 视频 > 文件 > 语音(无转写)
function pickMedia(msg) {
  const items = (msg && msg.item_list) || [];
  const has = (m) => m && (m.encrypt_query_param || m.full_url);
  return items.find((i) => i.type === 2 && has(i.image_item && i.image_item.media))
    || items.find((i) => i.type === 5 && has(i.video_item && i.video_item.media))
    || items.find((i) => i.type === 4 && has(i.file_item && i.file_item.media))
    || items.find((i) => i.type === 3 && has(i.voice_item && i.voice_item.media) && !(i.voice_item && i.voice_item.text))
    || null;
}
function voiceText(msg) {
  return ((msg && msg.item_list) || []).filter((i) => i && i.type === 3 && i.voice_item && i.voice_item.text).map((i) => String(i.voice_item.text)).join('');
}
async function dshInbound(msg) {
  const item = pickMedia(msg);
  if (!item) return null;
  const { downloadMediaFromItem, extFromMime } = await loadMedia();
  fs.mkdirSync(DSH_INBOX, { recursive: true });
  const saveMedia = async (buf, mime, _dir, maxBytes, fileName) => {
    if (maxBytes && buf.length > maxBytes) throw new Error('media too large');
    let ext = '';
    try { ext = mime ? (extFromMime(mime) || '') : ''; } catch {}
    if (!ext) {
      if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg';
      else if (buf[0] === 0x89 && buf[1] === 0x50) ext = '.png';
      else if (buf.slice(0, 4).toString() === 'GIF8') ext = '.gif';
      else if (buf.slice(8, 12).toString() === 'WEBP') ext = '.webp';
      else ext = '.bin';
    }
    if (!ext.startsWith('.')) ext = '.' + ext;
    const safe = fileName ? String(fileName).replace(/[\/\\\0]/g, '_').slice(-80) : '';
    const fp = path.join(DSH_INBOX, Date.now() + '-' + (safe || ('media' + ext)));
    fs.writeFileSync(fp, buf);
    return { path: fp };
  };
  const r = await downloadMediaFromItem(item, { cdnBaseUrl: cdnBase(), saveMedia, log: () => {}, errLog: (e) => log('dsh media ' + e), label: 'dsh' });
  if (r.decryptedPicPath) return '[用户发来一张图片：' + r.decryptedPicPath + '（请用 read_image 查看）]';
  if (r.decryptedFilePath) return '[用户发来一个文件：' + r.decryptedFilePath + '（' + (r.fileMediaType || '') + '）]';
  if (r.decryptedVoicePath) return '[用户发来一段语音，没有文字转写：' + r.decryptedVoicePath + '（' + (r.voiceMediaType || '') + '）]';
  if (r.decryptedVideoPath) return '[用户发来一段视频：' + r.decryptedVideoPath + ']';
  return '[用户发来了图片/文件/语音，但下载失败]';
}
// 从 DSH 回复里抽出 [[发送:路径]]，只允许 DSH_CWD 目录下已存在的文件
function extractSends(text) {
  const files = [];
  const out = String(text).replace(/\[\[\s*发送\s*[:：]\s*([^\]]+?)\s*\]\]/g, (_m, p) => {
    const abs = path.resolve(DSH_CWD, p.trim());
    let ok = false;
    try { ok = abs.startsWith(DSH_CWD + path.sep) && fs.realpathSync(abs).startsWith(DSH_CWD + path.sep) && fs.statSync(abs).isFile(); } catch {}
    if (ok) { if (!files.includes(abs)) files.push(abs); } else log('dsh send REJECTED path=' + abs);
    return '';
  }).trim();
  return { text: out, files };
}
async function sendFiles(msg, files) {
  const { sendWeixinMediaFile } = await loadMedia();
  for (const fp of files) {
    try {
      await sendWeixinMediaFile({ filePath: fp, to: msg.from_user_id, text: '', opts: sendOpts(msg), cdnBaseUrl: cdnBase() });
      log('dsh media sent ' + path.basename(fp));
    } catch (e) {
      log('dsh media send ERROR ' + path.basename(fp) + ' ' + String((e && e.message) || e));
      await reply(msg, '⚠️ 文件发送失败：' + path.basename(fp)).catch(() => {});
    }
  }
}

// ---------- 模式回执 / 慢提示 / 会话日切 ----------
const SLOW_NOTICE_MS = cfg.slowNoticeMs || 20000;
const dshMetaFile = path.join(ROOT, 'dsh-session-meta.json'); // chat -> { sid, startedAt, msgCount, pendingHandoff }
function dshMeta() { try { return JSON.parse(fs.readFileSync(dshMetaFile, 'utf8')); } catch { return {}; } }
function setDshMeta(chat, sid) {
  const m = dshMeta();
  const prev = m[chat] || {};
  if (!sid) delete m[chat];
  else if (prev.sid !== sid) {
    const extra = {};
    if (prev.msgCount) extra.msgCount = prev.msgCount;               // 新会话接续计数
    if (prev.pendingHandoff) extra.pendingHandoff = prev.pendingHandoff; // 交接包未消费时保留
    m[chat] = { sid, startedAt: Date.now(), ...extra };
  }
  fs.writeFileSync(dshMetaFile, JSON.stringify(m, null, 2));
}
// 每轮用户消息 +1 并记最后活跃时间，用于"会话够长才值得交接"和"隔 3 小时换话题"两个阈值
function bumpMsgCount(chat) {
  const m = dshMeta();
  m[chat] = { ...(m[chat] || {}), msgCount: ((m[chat] && m[chat].msgCount) || 0) + 1, lastMsgAt: Date.now() };
  fs.writeFileSync(dshMetaFile, JSON.stringify(m, null, 2));
}
function setPendingHandoff(chat, p) {
  const m = dshMeta();
  m[chat] = { ...(m[chat] || {}), pendingHandoff: p };
  fs.writeFileSync(dshMetaFile, JSON.stringify(m, null, 2));
}
// 标记"本轮已给新会话注入过 handoffs/ 文件"，避免 dsh 调用失败（拿不到 sessionId）时每轮重复注入
function markFileInject(chat) {
  const m = dshMeta();
  m[chat] = { ...(m[chat] || {}), fileInjectedAt: Date.now() };
  fs.writeFileSync(dshMetaFile, JSON.stringify(m, null, 2));
}
function clearPendingHandoff(chat) {
  const m = dshMeta();
  const e = m[chat];
  if (e && e.pendingHandoff) {
    delete e.pendingHandoff;
    if (!e.sid && !e.msgCount && Object.keys(e).length === 0) delete m[chat];
    fs.writeFileSync(dshMetaFile, JSON.stringify(m, null, 2));
  }
}
// ===== 无感多话题（threads.mjs）=====
// 线程表 dsh-threads.json；前台线程的 sid/meta 仍在上面两份文件里（本文件其余逻辑照旧读它们）
function putDshMeta(chat, obj) {
  const m = dshMeta();
  if (obj) m[chat] = obj; else delete m[chat];
  fs.writeFileSync(dshMetaFile, JSON.stringify(m, null, 2));
}
// 首次启用时给「老主线」做画像：面板里记着的近期用户原话
function seedAnchorsFromLive(chat) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'dsh-live.json'), 'utf8'));
    const tag = String(chat || '').slice(0, 6);
    return (j.recent || []).filter((r) => r.chatTag === tag && r.kind === 'chat' && r.task && !/^\[用户在你执行任务/.test(r.task))
      .map((r) => String(r.task).replace(/\[用户发来[^\]]*\]/g, '').trim()).filter(Boolean).reverse();
  } catch { return []; }
}
const threads = cfg.threadRouter === false ? null : createRouter({
  stateFile: path.join(ROOT, 'dsh-threads.json'),
  getSid: (chat) => dshSessions()[chat] || null,
  setSid: (chat, sid) => setDshSession(chat, sid),
  getMeta: (chat) => dshMeta()[chat] || null,
  putMeta: putDshMeta,
  // 2026-09-28 Mac 端 Claude：裁判换成经理（快模型 2~3 秒；拿不准或有转场词时 GPT-6 Luna 复核），不再每判一次启动一整个 DSH
  judge: mgr.makeTopicJudge({ log }),
  seedAnchors: seedAnchorsFromLive,
  watchDirs: [DSH_CWD, ROOT, '/home/aibox/bin'],
  shadow: !!cfg.threadRouterShadow,
  th: cfg.threadTh || {},
  log,
});
const MISROUTE_NOFIND_NOTE = '【系统提示 — 主人看不到这段，别在回复里提】主人说话题放错了/串了，但系统没找到更合适的旧会话。' +
  '请结合上下文和交接目录判断他想接的是哪件事，直接按那件事回答；实在对不上再用一句话简单确认。\n\n';
// 每天凌晨 4 点（本机时区）之后的第一条消息开新会话
function lastDayBoundary() { const d = new Date(); d.setHours(4, 0, 0, 0); if (Date.now() < d.getTime()) d.setDate(d.getDate() - 1); return d.getTime(); }
// ===== 会话交接包：旧会话自压缩成要点 → 新会话注入核对 → 首回复确认收到后消费 =====
// 阈值（都可在 config.json 覆盖）：
//  - 上下文估算：每轮 dsh 上报的单步输入 token 峰值（usagePeak，含 cacheRead）= 当前上下文规模
//  - 换会话门槛必须早于 dsh 自身的自动压缩（约 6 万 token），否则 dsh 先压、交接包就没意义了
//  - 预算默认 4.5 万：dsh 约 6 万开始自压缩，留 1.5 万安全边际
//  - 聊天特有触发：隔 3 小时没说话（多半换话题）
//  - 少于 3 条消息的会话不值得花 token 总结（直接冷切）
const HANDOFF_MIN_MSGS = cfg.handoffMinMsgs ?? 3;
const HANDOFF_TIMEOUT_MS = cfg.handoffTimeoutMs ?? 300000;
const HANDOFF_MAX_CHARS = cfg.handoffMaxChars ?? 6000;
const HANDOFF_IDLE_MS = cfg.handoffIdleMs ?? 3 * 3600 * 1000;
const HANDOFF_CTX_BUDGET = cfg.dshContextBudget ?? 45000;
const HANDOFF_WARN_PCT = cfg.handoffWarnPct ?? 0.80;
const HANDOFF_SWITCH_PCT = cfg.handoffSwitchPct ?? 1.0;
// 交接包字段 = agent-session-harness 的 capsule（任务/精确下一步/完成与未完成/决定/卡点/改过的文件/指纹）
// + Zylos 要点（不可撤销的事、未兑现的承诺、关键决定）+ project-handoff 五段式；只给要点和路径，不贴长文
const HANDOFF_PROMPT = `请把当前整个会话压缩成一份"交接包"，只输出 JSON 对象本身，不要任何解释文字，不要 Markdown 代码块围栏。
字段（没有就省略；每项 1-5 条；总共 ≤ 6000 字符）：
- title：这段会话讲了什么，一句话 ≤ 30 字（进交接目录用，必填）
- keywords：3-8 个关键词的数组（项目名、服务名、文件名、人名等以后会拿来搜的词，必填）
- project：用户当前主要在做的事/项目（没有则 null）
- intent：当前目标，一句话
- task：当前任务 + 完成标准
- next_action：下一步具体做什么
- completed：已完成的事
- remaining：还没完成/待办
- decisions：重要决定及原因
- blockers：卡在哪/遇到了什么阻碍
- files_changed：改过/产出的文件路径（只列路径 + 一句话说明，别贴内容）
- commitments：还没兑现的承诺
- irreversible：已做过的不可撤销的事（发过的消息、花过的钱、删过的文件——新会话别重做）
- pitfalls：踩过的坑/已知此路不通
- user_prefs：用户偏好、习惯、身份事实（如回复风格要求）
- notes：必须记住的环境事实/限制（额度、账号、权限等）
只保留对新会话真正有用的事实；丢弃寒暄、重复提问、工具原始输出、讨论过程。`;
function parseHandoff(final) {
  let t = String(final).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { JSON.parse(t.slice(a, b + 1)); return { text: t.slice(a, b + 1).slice(0, HANDOFF_MAX_CHARS), raw: false }; } catch {}
  }
  return { text: t.slice(0, HANDOFF_MAX_CHARS), raw: true };
}
// 交接包同时落盘进存档链（handoffs/NNNN-*.md + INDEX.md）；失败只记日志，不影响换会话
async function archiveHandoff(p, fp, sid, reason) {
  try {
    const hs = await import('/home/aibox/bin/handoff-store.mjs');
    let j = null;
    if (!p.raw) { try { j = JSON.parse(p.text); } catch {} }
    const title = (j && (j.title || j.intent)) || '（未命名交接）';
    const r = hs.saveHandoff({ title, keywords: (j && j.keywords) || [], reason, sid, fp, body: j ? hs.packetToMarkdown(j) : p.text });
    log('handoff archived file=' + r.name + ' prev=' + (r.prev || '-'));
  } catch (e) {
    log('handoff archive ERROR ' + String((e && e.message) || e));
  }
}
async function buildHandoff(chat, sid, meta, reason = 'rotate', run = null) {
  try {
    const n = (meta && meta.msgCount) || 1;
    if (n < HANDOFF_MIN_MSGS) { log('handoff skip chat=' + chat + ' msgs=' + n + '<' + HANDOFF_MIN_MSGS); return null; }
    const r = await runDsh(HANDOFF_PROMPT, sid, { fallback: Date.now() < goCooldownUntil(), ocSession: ocSession(chat, sid), timeoutMs: HANDOFF_TIMEOUT_MS, onEvent: run && run.event, chat, generation: beginDshGeneration(chat), register: registerActiveRun(chat, 'handoff') });
    if (r.interrupted || r.stale) { log('handoff interrupted chat=' + chat); return null; }
    if (noFinal(r)) { log('handoff FAILED chat=' + chat + ' err=' + r.errTail.replace(/\s+/g, ' ').slice(-200)); return null; }
    const p = parseHandoff(r.final);
    const fp = crypto.createHash('sha256').update(p.text).digest('hex').slice(0, 16);
    log('handoff done chat=' + chat + ' chars=' + p.text.length + ' fp=' + fp + (p.raw ? ' raw' : ''));
    await archiveHandoff(p, fp, sid, reason);
    return { ts: Date.now(), from: sid, fp, text: p.text };
  } catch (e) {
    log('handoff ERROR chat=' + chat + ' err=' + String((e && e.message) || e));
    return null;
  }
}
// 手写交接文件：handoffs/ 里最新的 .md（主人手写或 dsh 落盘的交接），取 24 小时内的最新一份
const HANDOFF_DIR = path.join(DSH_CWD, 'handoffs');
function latestHandoffFile() {
  try {
    // 只认存档链里的单份交接（NNNN-*.md），INDEX.md 等不算
    const files = fs.readdirSync(HANDOFF_DIR).filter((f) => /^\d{4}-.*\.md$/.test(f)).map((f) => {
      const p = path.join(HANDOFF_DIR, f);
      return { p, f, m: fs.statSync(p).mtimeMs };
    }).sort((a, b) => b.m - a.m);
    if (!files.length) return null;
    const top = files[0];
    if (Date.now() - top.m > 24 * 3600 * 1000) return null; // 太旧的别灌
    return { name: top.f, text: fs.readFileSync(top.p, 'utf8').slice(0, HANDOFF_MAX_CHARS) };
  } catch { return null; }
}
// 注入文案 = 新会话的"核对/确认收到"入口：先通读交接包、与现实/文件核对，再答用户；
// 不要在回复里复述指纹（用户不需要看到），消费靠"成功回复后才消费"。
// 内存交接包（自动生成）优先；没有时用 handoffs/ 里最新的手写交接文件兜底。
function injectHandoff(text, hf) {
  let body = '';
  if (hf && hf.text) body = hf.text;
  else {
    const f = latestHandoffFile();
    if (f) { body = '（以下来自手写交接文件 handoffs/' + f.name + '）\n' + f.text; log('handoff inject file=' + f.name + ' chars=' + f.text.length); }
  }
  if (!body) return text;
  return '【上一会话交接包 — 请先通读并核对，再回答用户本条消息。此会话是你接手其工作的新会话】\n' +
    '（用户已知晓此事，不要在回复里复述本段或任何校验码）\n' +
    body + '\n\n【用户消息】\n' + text;
}
// ===== 回忆提示：把交接目录（INDEX.md）附在消息前，让 DSH 一定"看得到"以前有什么 =====
// 参考 agent-memory（新会话确定性注入目录）+ mnemon（用户消息钩子触发回忆）：
// 新会话首条必附；用户提到以前的事（关键词）也附。只附目录（几百字），读不读哪份由 DSH 按 recall 技能判断。
const RECALL_INDEX_CHARS = cfg.recallIndexChars ?? 6000;
// 触发面放宽（2026-09-28）：以前只认 20 来个词，很多"想不起来"的句子触发不到。
// 补了时间词、追问词（怎么样/弄好没/结果呢）、指代词（那个/我们说的）、复现词（怎么弄的/再说一遍）。
const RECALL_RE = new RegExp(cfg.recallKeywords || (
  '之前|以前|上次|上回|上上回|昨天|前天|前几天|那天|早先|当初|原来|刚刚|刚才|' +
  '上周|上个月|这周|这几天|前阵子|很久以前|最早|最开始|' +
  '还记得|记得吗|记不记得|你忘|忘了|我说过|你说过|我们说过|我们聊过|提过|' +
  '我们做过|做过的|弄过|搞过|那个|那件事|那个东西|那个项目|我们说的|刚才说的|' +
  '接着|继续|继续那个|接着做|接着弄|接着上次|' +
  '怎么样|怎样了|弄好|搞好|做完了吗|做完了没|搞定了吗|搞定没|结果呢|进展|进度|' +
  '怎么弄的|怎么做的|怎么搞的|再说一遍|再讲一遍|教我|回顾|总结一下|梳理'
), 'i');
function indexDigest() {
  try {
    const t = fs.readFileSync(path.join(HANDOFF_DIR, 'INDEX.md'), 'utf8');
    const rows = t.split('\n').filter((l) => l.startsWith('## ') || (l.startsWith('| ') && !l.startsWith('| # ') && !l.startsWith('| 周 ')));
    if (!rows.some((l) => l.startsWith('| '))) return '';
    let out = '';
    for (const l of rows) { if (out.length + l.length > RECALL_INDEX_CHARS) { out += '…（更多见 handoffs/INDEX.md）\n'; break; } out += l + '\n'; }
    return out;
  } catch { return ''; }
}
// ===== 外援任务提醒（2026-09-28 Mac 端 Claude）=====
// helper 启动的外援脱离 DSH 运行，DSH 这一轮结束后才做完的结果没人看 → 下一轮开头由路由（代码，不靠模型记得）告诉它：
// 做完但没取走的（每个只提醒一次），以及还在跑的。任务目录见 /home/aibox/bin/helper.mjs
const HELPER_JOBS = '/home/aibox/.aibox/helper-jobs';
function helperNote() {
  let ids = [];
  try { ids = fs.readdirSync(HELPER_JOBS).sort().reverse().slice(0, 30); } catch { return ''; }
  const done = [], running = [];
  for (const id of ids) {
    const p = path.join(HELPER_JOBS, id, 'meta.json');
    let m; try { m = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const who = (m.helper === 'gpt' ? 'GPT' : 'Claude') + (m.work ? '（干活）' : '（顾问）');
    if (m.status === 'running') running.push('- ' + id + ' ' + who + ' 还在跑：' + m.title + ' → helper status ' + id);
    else if (!m.delivered && !m.announced && Date.parse(m.endedAt || 0) > Date.now() - 3 * 86400e3) {
      done.push('- ' + id + ' ' + who + (m.status === 'done' ? ' ✓ 做完了' : ' ✕ ' + m.status) + '：' + m.title + ' → helper result ' + id);
      try { fs.writeFileSync(p, JSON.stringify({ ...m, announced: true }, null, 2)); } catch {}
    }
  }
  if (!done.length && !running.length) return '';
  return '【外援任务 — 系统自动附上】\n' + (done.length ? '上一轮之后做完、结果还没看的（先看结果再回答主人）：\n' + done.join('\n') + '\n' : '') +
    (running.length ? '还在后台跑的：\n' + running.join('\n') + '\n' : '') + '（别在回复里复述这段）\n\n';
}
// 用户原话 vs 交接标题/关键词求交集，挑出最像的几份 → 省得 DSH 一份份翻
// 中文没空格，所以：ASCII 词按标点切；中文切成 2 字滑窗（bigram），命中多者排前。
function recallTokens(s) {
  const txt = String(s || '').toLowerCase();
  const out = new Set();
  for (const w of txt.split(/[\s，。、！？；：（）()\[\]「」『』,.;:!?~…—-]+/)) {
    if (w.length >= 2 && /[a-z0-9]/.test(w)) out.add(w);
  }
  const cjk = txt.replace(/[^\u4e00-\u9fa5]+/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}
const RECALL_STOP = new Set(['那个','这个','怎么','什么','现在','已经','可以','帮我','一下','我们','你们','他们','的时','时候','不是','就是','还有','没有','知道','告诉','看看','咱们']);
function rankHandoffs(userText, topN) {
  try {
    const t = fs.readFileSync(path.join(HANDOFF_DIR, 'INDEX.md'), 'utf8');
    const rows = t.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| # ') && !l.startsWith('| 周 ') && !/^\|\s*-+/.test(l));
    const toks = recallTokens(userText);
    if (!toks.size) return [];
    const scored = [];
    for (const l of rows) {
      const cells = l.split('|').map((s) => s.trim()).filter(Boolean);
      if (cells.length < 4) continue;
      const hay = cells.slice(1).join(' ').toLowerCase();
      let hit = 0; const which = [];
      for (const w of toks) {
        if (RECALL_STOP.has(w)) continue;
        if (hay.includes(w)) { hit++; if (which.length < 5) which.push(w); }
      }
      if (hit > 0) scored.push({ hit, line: l.trim(), which: which.join('、'), link: (l.match(/\(([^)]+\.md)\)/) || [])[1] || '' });
    }
    scored.sort((a, b) => b.hit - a.hit);
    return scored.slice(0, topN || 3);
  } catch { return []; }
}
function attachIndex(text, why) {
  const d = indexDigest();
  if (!d) return text;
  let lead = '';
  const rk = rankHandoffs(text, 3);
  if (rk.length) {
    lead = '\n【系统预筛 — 跟这句最像的几份（按关键词重叠，仅供参考，别硬套）】\n' +
      rk.map((r) => '- ' + r.link + '（命中：' + r.which + '）').join('\n') + '\n';
  }
  return '【交接目录 — 系统自动附上（' + why + '）。当前会话里没有的往事，按 recall 技能去查：cat /home/aibox/dsh-work/handoffs/<文件>；与本条无关就忽略，别在回复里提这段】\n' +
    lead + d + '\n' + text;
}
function dshRouteLabel() {
  const until = goCooldownUntil();
  if (Date.now() < until) return 'DeepSeek 按量（Go 额度冷却到 ' + new Date(until).toTimeString().slice(0, 5) + '）';
  return 'Go 订阅（额度满自动切 DeepSeek）';
}
function modeLabel(mode) {
  if (mode === 'dsh') return 'DSH · ' + dshRouteLabel();
  if (mode === 'local') return '本地模型 ' + cfg.localModel + '（台式机）';
  return 'OpenClaw（DeepSeek 按量）';
}
function modeReport(chat) {
  const mode = modes()[chat] || 'ai';
  let t = '当前：' + modeLabel(mode);
  if (mode === 'dsh') {
    const meta = dshMeta()[chat];
    t += meta ? '\n会话：' + new Date(meta.startedAt).toLocaleString('zh-CN', { hour12: false }) + ' 开始' : '\n会话：下一条消息新开';
    const s = threads && threads.summary(chat);
    if (s) t += '\n话题：「' + s.fg.title + '」（共 ' + s.count + ' 个，自动切换；/话题 查看）';
  }
  return t + '\n切换：/dsh /ai /local　新会话：/new';
}
// 超过 SLOW_NOTICE_MS 还没回完才提示一次
function slowNotice(msg, what) {
  const t = setTimeout(() => { reply(msg, '⏳ ' + what + '还在处理，稍等…').catch(() => {}); }, SLOW_NOTICE_MS);
  return () => clearTimeout(t);
}

// ---------- DSH：微信进度播报 ----------
// 45 秒后首报"在干嘛"；之后有新动静才报，最多 4 分钟一次；【进展】/GPT 外援立即报（与上一条隔 ≥45 秒，不够就攒到下次）
const PROGRESS_FIRST_MS = cfg.progressFirstMs ?? 45000;
const PROGRESS_EVERY_MS = cfg.progressEveryMs ?? 240000;
const PROGRESS_GAP_MS = cfg.progressGapMs ?? 45000;
const PROGRESS_MAX = cfg.progressMax ?? 10;
function progressReporter(msg, run) {
  let sent = 0, lastAt = 0, lastSig = '';
  const pending = [];
  const send = (t) => {
    if (sent >= PROGRESS_MAX) return;
    sent++; lastAt = Date.now(); lastSig = run.step + '/' + run.tools;
    if (sent === PROGRESS_MAX) t += '\n（进度播报到上限了，之后发 /进度 查看）';
    reply(msg, t).catch(() => {});
    log('progress sent chat=' + run.chatTag + ' n=' + sent + ' ' + t.replace(/\s+/g, ' ').slice(0, 80));
  };
  run.on((ev) => {
    if (ev.kind === 'milestone') pending.push('📍 ' + ev.text);
    else if (ev.kind === 'codex') pending.push('🤝 ' + live.cut(ev.text, 100));
  });
  let warned = false;
  const iv = setInterval(() => {
    const now = Date.now();
    if (!warned && now - run.startedAt >= DSH_WARN_MS) {
      warned = true;
      reply(msg, '⚠️ 这个任务已经跑了 ' + Math.round(DSH_WARN_MS / 60000) + ' 分钟，到 ' + Math.round(DSH_TIMEOUT_MS / 60000) + ' 分钟会强制停下（进度保留，停了可以发「继续」）。\n' + live.describe(run, '现在')).catch(() => {});
      log('progress warn chat=' + run.chatTag);
    }
    if (pending.length && now - lastAt >= PROGRESS_GAP_MS) {
      send(pending.splice(0).join('\n') + '\n（已 ' + live.dur(now - run.startedAt) + '，还在继续）');
      return;
    }
    if (now - run.startedAt < PROGRESS_FIRST_MS) return;
    if (!lastAt) return send(live.describe(run, '⏳ 还在做'));
    if (now - lastAt >= PROGRESS_EVERY_MS && run.step + '/' + run.tools !== lastSig) send(live.describe(run, '⏳ 还在做'));
  }, 3000);
  return { stop: () => clearInterval(iv), get sent() { return sent; } };
}
function progressReport(chat) {
  const rs = live.runningFor(chat);
  if (rs.length) return rs.map((r) => live.describe(r, r.kind === 'handoff' ? '🗂 正在生成交接包' : '⏳ DSH 正在做')).join('\n\n') + '\n\n面板：http://127.0.0.1/';
  const last = live.lastFor(chat);
  let t = '✅ DSH 现在空闲';
  if (last) t += '\n上一个任务：' + live.cut(last.task, 40) + '\n结果：' + ({ done: '完成', failed: '失败', interrupted: '被中断' }[last.status] || last.status) + ' · 用时 ' + live.dur(last.took || 0) + ' · ' + last.step + ' 步';
  return t;
}

// ---------- DSH：一轮对话 ----------
// opts（2026-09-28 多话题）：route=先判定话题归属（只给普通新消息用；改向重跑/交接期间的补充不判定）；
//   raw=文本已备好，别再从 msg 里抽语音/媒体（撤回重答时 msg 是「切错了」那条）；
//   reask={prefix,note}=撤回后重答；hint={prev,interruptedPrev}=「切错了」但没切过，拿上一句找归属
async function answerDsh(msg, text, opts = {}) {
  const chat = chatKey(msg);
  const t0 = Date.now();
  let run = null, rep = null;
  try {
    let spoken = text || '';
    let media = null;
    if (!opts.raw) {
      const vt = voiceText(msg);
      if (vt) text = (text ? text + '\n' : '') + vt;
      spoken = text || '';   // 用户说的话（打字 + 语音转写），不含媒体标注 —— 判定话题只看这个
      media = await dshInbound(msg).catch((e) => { log('dsh media ERROR ' + String((e && e.message) || e)); return '[用户发来的媒体处理失败]'; });
      if (media) text = (text ? text + '\n' : '') + media;
    }
    if (!text) return;
    run = live.startRun({ chat, kind: 'chat', task: text, limitMs: DSH_TIMEOUT_MS, idleMs: DSH_IDLE_MS });
    rep = progressReporter(msg, run);
    // ---- 多话题：先定这句归哪个话题（可能把 sid/meta 整体换掉），再往下走原流程 ----
    let routePrefix = '', forceRecall = false;
    if (opts.reask) {
      routePrefix = opts.reask.prefix || '';
      if (opts.reask.note) run.note(opts.reask.note);
    } else if (opts.route && threads) {
      try {
        const rt = await threads.route(chat, opts.hint ? text : spoken, { fullText: text, hint: opts.hint });
        log('thread route chat=' + chat + ' ' + rt.action + (rt.to ? ' ' + rt.from + '→' + rt.to : '') + ' 「' + rt.title + '」 ' + rt.why);
        if (rt.action !== 'stay') run.note('🧵 ' + (rt.action === 'new' ? '开了新话题「' : '回到话题「') + rt.title + '」');
        routePrefix = rt.prefix || '';
        if (opts.hint) {
          if (rt.action !== 'stay') {
            text = opts.hint.prev;
            routePrefix += '【系统提示 — 主人看不到这段】主人下面这句话刚才被放在别的会话里答了，他说放错了。请在这里重新回答它。\n\n';
          } else {
            if (opts.hint.interruptedPrev) text = opts.hint.prev + '\n（主人又说：' + text + '）';
            routePrefix += MISROUTE_NOFIND_NOTE;
            forceRecall = true;
          }
        }
      } catch (e) {
        log('thread route ERROR chat=' + chat + ' ' + String((e && e.stack) || e)); // 路由出任何错都当"留在原地"
      }
    }
    let sid = dshSessions()[chat];
    let meta = dshMeta()[chat];
    let injected = false;
    let freshSession = false; // 本轮是不是"新会话的第一条消息"（决定是否读一次 handoffs/ 兜底）
    // 换会话的三个触发（前两个参考 agent-session-harness 的 governor：65% 预警 / 70% 切换）：
    // daily=凌晨 4 点日切；idle=隔 3 小时没说话（多半换话题了）；context=上下文估算到 70%
    let rotateReason = null;
    if (sid && meta && meta.sid === sid) {
      // 多话题：切回的老话题用 resumedAt 算日切，否则切回昨天的话题会立刻被"日切"压缩掉
      if (Math.max(meta.startedAt || 0, meta.resumedAt || 0) < lastDayBoundary()) rotateReason = 'daily';
      else if (meta.lastMsgAt && Date.now() - meta.lastMsgAt > HANDOFF_IDLE_MS) rotateReason = 'idle';
      else if ((meta.ctxIn || 0) >= HANDOFF_CTX_BUDGET * HANDOFF_SWITCH_PCT) rotateReason = 'context';
    } else if (!sid) {
      freshSession = true; // 无会话（首次用 / 被清空 / 主动 /new）：也算新会话首条
    }
    if (rotateReason) {
      log('dsh rotate chat=' + chat + ' reason=' + rotateReason + ' old=' + sid);
      if (run) { run.note('先把旧会话压缩成交接包（' + rotateReason + '）'); run.setCtx({ rotate: rotateReason }); }
      const packet = await buildHandoff(chat, sid, meta, rotateReason, run); // 旧会话自压缩成要点（失败则冷切，绝不让用户干等）
      setDshSession(chat, null); setDshMeta(chat, null); sid = undefined;
      if (packet) { setPendingHandoff(chat, packet); log('handoff staged chat=' + chat + ' from=' + packet.from + ' fp=' + packet.fp); }
      meta = dshMeta()[chat];
      freshSession = true; // 换会话后的这条就是新会话首条
      const why = rotateReason === 'daily' ? '新的一天' : rotateReason === 'idle' ? '隔了很久没说话' : '会话上下文快满了';
      await reply(msg, packet ? '🆕 DSH 换了新会话（' + why + '）\n✅ 要点已自动交接给新会话。' : '🆕 DSH 换了新会话（' + why + '，旧对话不带入）。').catch(() => {});
    } else if (sid && (!meta || meta.sid !== sid)) {
      // 会话丢失/元数据失配：冷切，不生成交接（旧会话已不可用，别浪费 token 总结）
      log('dsh meta mismatch, fresh chat=' + chat + ' old=' + sid);
      setDshSession(chat, null); setDshMeta(chat, null); sid = undefined;
      meta = dshMeta()[chat];
      freshSession = true; // 这也是新会话首条
    }
    bumpMsgCount(chat); // 记本轮的计数和最后活跃时间（放在旋转判定之后，避免 idle 被自己刷新）
    const userText = text; // 关键词判断只看用户原话，不看注入的交接包
    const recallWhy = freshSession ? '新会话' : RECALL_RE.test(userText) ? '你提到了以前的事' : forceRecall ? '主人说话题放错了' : null;
    // 有未消费的交接包就注入：新会话每条消息都带，直到首次成功回复后才消费
    if (meta && meta.pendingHandoff) {
      text = injectHandoff(text, meta.pendingHandoff);
      injected = true;
      log('handoff inject chat=' + chat + ' chars=' + meta.pendingHandoff.text.length + ' fp=' + meta.pendingHandoff.fp);
    } else if (freshSession && !(meta && meta.fileInjectedAt)) {
      // 新会话首条、没有自动交接包、且本轮尚未注入过：读一次 handoffs/ 最新手写交接（24 小时内的）
      const before = text;
      text = injectHandoff(text, null);
      if (text !== before) { injected = true; markFileInject(chat); log('handoff inject from file chat=' + chat); }
      else markFileInject(chat); // 没有可用文件也记一笔，避免每轮重复扫盘
    }
    if (recallWhy) {
      const before = text;
      text = attachIndex(text, recallWhy);
      if (text !== before) log('recall index attached chat=' + chat + ' why=' + recallWhy);
    }
    if (routePrefix) text = routePrefix + text;
    { const hn = helperNote(); if (hn) { text = hn + text; log('helper note attached chat=' + chat + ' chars=' + hn.length); } }
    const oc = ocSession(chat, sid);
    const coolingDown = Date.now() < goCooldownUntil();
    run.setRoute(coolingDown ? 'deepseek' : 'go');
    const myGen = beginDshGeneration(chat), myReg = registerActiveRun(chat);
    let r = await runDsh(text, sid, { fallback: coolingDown, ocSession: oc, onEvent: run.event, chat, generation: myGen, register: myReg });
    // 2026-09-28 修：被中断时也要保存 sessionId。原实现直接 return，不落盘 r.sessionId，
    // 于是"新会话第一轮被改向"（/new 后、日切、idle 换会话）时 sid 仍为空 → 重跑会开全新会话，
    // 模型不知道原任务是什么，而回执里还骗用户说"上下文还在"（Claude 审出）。
    if (r.interrupted || r.stale) { rep.stop(); saveDshSessionIfAny(chat, r); log('dsh interrupted chat=' + chat); return; } // 被叫停：不发旧回复、不走 fallback
    const sessionLost = noFinal(r) && sid && /does not exist; omit --session-id/.test(r.errTail);
    if (noFinal(r) && !coolingDown && !sessionLost && !r.signal) {
      const quota = isQuotaErr(r.errTail);
      log('go FAILED chat=' + chat + ' quota=' + quota + ' err=' + r.errTail.replace(/\s+/g, ' ').slice(-300));
      if (quota) {
        setGoCooldown(GO_COOLDOWN_MS);
        await reply(msg, '⚠️ Go 额度用完，接下来 ' + Math.round(GO_COOLDOWN_MS / 60000) + ' 分钟改走 DeepSeek 按量付费。').catch(() => {});
      }
      run.note('Go 线路失败，改走 DeepSeek 按量重试'); run.setRoute('deepseek');
      r = await runDsh(text, sid, { fallback: true, ocSession: oc, onEvent: run.event, chat, generation: myGen, register: myReg });
      if (r.interrupted || r.stale) { rep.stop(); saveDshSessionIfAny(chat, r); log('dsh interrupted chat=' + chat); return; }
    }
    if (noFinal(r) && sid && /does not exist; omit --session-id/.test(r.errTail)) {
      log('dsh session lost, starting fresh chat=' + chat);
      setDshSession(chat, null);
      run.note('旧会话丢了，开新会话重试');
      r = await runDsh(text, null, { fallback: coolingDown, ocSession: ocSession(chat, null), onEvent: run.event, chat, generation: myGen, register: myReg });
      if (r.interrupted || r.stale) { rep.stop(); saveDshSessionIfAny(chat, r); log('dsh interrupted chat=' + chat); return; }
    }
    rep.stop();
    refreshQuota();
    if (injected && !noFinal(r)) { clearPendingHandoff(chat); log('handoff consumed chat=' + chat); }
    if (r.sessionId) { setDshSession(chat, r.sessionId); setDshMeta(chat, r.sessionId); }
    // 上下文占用估算（本轮单步输入峰值≈当前上下文规模）+ 80% 预警（每个会话只提醒一次）；
    // 到 100%（=4.5 万 token）由下一条消息的 rotateReason='context' 自动交接，早于 dsh 约 6 万的自压缩
    if (r.sessionId && r.usagePeak > 0) {
      const m = dshMeta(); const e = m[chat] || (m[chat] = {});
      e.ctxIn = r.usagePeak;
      const pct = e.ctxIn / HANDOFF_CTX_BUDGET;
      // 2026-09-28：把水位喂给面板画圆环（一眼看出还剩多少、什么时候会被压缩）
      run.setCtx({ ctx: r.usagePeak, budget: HANDOFF_CTX_BUDGET, warnPct: HANDOFF_WARN_PCT });
      if (!e.handoffWarned && pct >= HANDOFF_WARN_PCT) {
        e.handoffWarned = true;
        fs.writeFileSync(dshMetaFile, JSON.stringify(m, null, 2));
        await reply(msg, '⚠️ 这个会话上下文用到 ' + Math.round(pct * 100) + '% 了。到 ' + Math.round(HANDOFF_SWITCH_PCT * 100) + '% 我会自动开新会话，要点自动交接，不丢进度。').catch(() => {});
      } else {
        fs.writeFileSync(dshMetaFile, JSON.stringify(m, null, 2));
      }
    }
    const took = ((Date.now() - t0) / 1000).toFixed(1) + 's';
    if (noFinal(r) || !String(r.final).trim()) {
      const why = r.killedBy === 'idle' ? Math.round(DSH_IDLE_MS / 60000) + ' 分钟没有任何动静，判定卡死' : r.killedBy === 'max' ? '跑满 ' + Math.round(DSH_TIMEOUT_MS / 60000) + ' 分钟总上限' : r.signal ? '被终止（' + r.signal + '）' : ('exit=' + r.code);
      if (r.killedBy) await reply(msg, '⛔ DSH 被停下了：' + why + '。\n' + live.describe(run, '做到这里') + '\n\n会话还在，发「继续」它会接着做；/new 重新开始。').catch(() => {});
      else await reply(msg, '⚠️ DSH 没返回内容（' + why + '）。再发一次，/new 开新会话，或 /ai 切回。').catch(() => {});
      log('dsh EMPTY chat=' + chat + ' ' + why + ' took=' + took + ' err=' + r.errTail.replace(/\s+/g, ' ').slice(-300));
      run.end('failed', '没返回内容（' + why + '）');
      return;
    }
    const { text: outText, files } = extractSends(r.final);
    if (outText) await reply(msg, outText);
    if (files.length) await sendFiles(msg, files);
    if (threads) { try { threads.noteReply(chat, outText); } catch (e) { log('thread noteReply ERROR ' + String((e && e.message) || e)); } }
    run.end('done', '已回复（' + outText.length + ' 字' + (files.length ? '，' + files.length + ' 个文件' : '') + '）');
    try { mgr.noteWorkerReply(chat, outText); } catch {}  // 经理要知道工人刚交付了什么
    log('dsh reply sent chat=' + chat + ' len=' + outText.length + ' files=' + files.length + ' route=' + (r.fallback ? 'deepseek' : 'go') + ' uncachedIn=' + r.usage + ' ctxPeak=' + r.usagePeak + ' took=' + took + ' sid=' + (r.sessionId || '-'));
  } catch (e) {
    log('dsh ERROR chat=' + chat + ' err=' + String((e && e.message) || e));
    if (run) run.end('failed', '出错：' + String((e && e.message) || e));
    await reply(msg, '⚠️ DSH 调用出错：' + String((e && e.message) || e) + '\n发 /ai 可以切回。').catch(() => {});
  } finally {
    if (rep) rep.stop();
    if (run && run.status === 'running') run.end('failed', '异常结束');
  }
}
// ---------- 往回拆话题（topic-split.mjs）----------
// 主人说「/拆话题」或经理判断主人要拆：把当前混了好几件事的话题拆成几个（后台跑，1~3 分钟）
let splitRunning = false, pendingSplit = null;
function runTopicSplit(msg, chat) {
  if (splitRunning) { reply(msg, '🧑‍💼 正在拆，稍等。').catch(() => {}); return; }
  if (activeRuns.get(chat)) { pendingSplit = { msg, chat }; reply(msg, '🧑‍💼 好，它这一轮做完我就拆（拆的时候要改话题表，不能跟它抢）。').catch(() => {}); return; }
  splitRunning = true;
  reply(msg, '🧑‍💼 开始把前面混在一起的话题拆开，1~3 分钟，好了告诉你。').catch(() => {});
  const ch = spawn(process.execPath, [path.join(ROOT, 'topic-split.mjs'), '--apply', '--chat', chat], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
  ch.on('close', (code) => {
    splitRunning = false;
    const lines = out.split('\n').filter((l) => /^(▶|  「|✓|这个话题只有)/.test(l)).map((l) => l.replace(/：.*$/, '')).slice(0, 14);
    log('topic split chat=' + chat + ' exit=' + code);
    reply(msg, code === 0 ? '🧑‍💼 拆好了：\n' + lines.join('\n') + '\n\n以后聊到哪件事，会自动接上那件事自己的记忆。/话题 看全部。' : '⚠️ 拆话题失败了：' + out.slice(-200)).catch(() => {});
  });
}
// ---------- 经理（manager.mjs）----------
const lastDshMsg = new Map();   // chat -> 最后一条消息（补交信箱时用它回复）
// 工人在不在干活：优先看可中断注册表；再看 live（两边都查，哪边知道都算）
function workerBusy(chat) {
  const a = activeRuns.get(chat);
  if (a) return true;
  return live.runningFor(chat).length > 0;
}
function helperBrief() {
  try {
    const dir = '/home/aibox/.aibox/helper-jobs';
    const run = fs.readdirSync(dir).map((id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8')); } catch { return null; } })
      .filter((m) => m && m.status === 'running');
    return run.length ? '工人请的外援在跑：' + run.map((m) => ({ gpt: 'GPT', claude: 'Claude', go: 'Go 顾问' }[m.helper] || m.helper) + '「' + m.title + '」').join('、') : '';
  } catch { return ''; }
}
function managerReport(chat) {
  const on = mgr.isOn(chat, cfg.managerMode);
  const q = mgr.pendingQuestion();
  return (on ? '🧑‍💼 经理在岗' : '经理下班中') + '\n' +
    (workerBusy(chat) ? '工人正在干活，现在跟你说话的是经理。' : '工人空闲，你的话直接给工人。') + '\n' +
    '信箱未读 ' + mgr.mailboxUnread().length + ' 条' + (q ? '；工人在等你回答：「' + q.q.slice(0, 60) + '」' : '') + '\n' +
    '开关：/经理开 /经理关';
}
async function handleManager(msg, chat, text) {
  const run = live.runningFor(chat)[0] || null;
  const d = await mgr.decide({ chat, text, run, helpers: helperBrief() });
  if (d.action === 'fallback') {                 // 经理的模型都挂了 → 退回原来的排队，不能丢话
    await reply(msg, '📥 收到。（经理暂时联系不上，这句先排队，它做完手上的就处理。）').catch(() => {});
    enqueueDsh(msg, text);
    log('manager fallback chat=' + chat + ' err=' + (d.error || '').slice(0, 160));
    return;
  }
  await reply(msg, '🧑‍💼 ' + d.reply).catch(() => {});
  const tw = d.toWorker || text;
  const a = activeRuns.get(chat);
  if (d.action === 'note') mgr.mailboxAdd(tw);
  else if (d.action === 'answer' && d.question) mgr.answerQuestion(d.question, tw);
  else if (d.action === 'queue') enqueueDshRouted(msg, tw);        // 排队的新事出队时先分到它该去的话题
  else if (d.action === 'split') runTopicSplit(msg, chat);
  else if (d.action === 'stop') {
    if (a && a.kind === 'chat') interruptCurrentRun(chat, a.runId).then((ok) => log('manager stop ' + (ok ? 'done' : 'noop') + ' chat=' + chat));
  } else if (d.action === 'redo') {
    if (a && a.kind === 'chat') {
      clearPendingSteer(chat);
      enqueueChatSafe(chat, () => answerDsh(msg, wrapSteer(tw)), { priority: true });
      interruptCurrentRun(chat, a.runId).then((ok) => log('manager redo interrupt ' + (ok ? 'done' : 'noop') + ' chat=' + chat));
    } else mgr.mailboxAdd(tw);                     // 打断不了（在写交接等）→ 退成留言
  }
  log('manager chat=' + chat + ' action=' + d.action + ' ms=' + d.ms + ' route=' + d.route);
}
// 兜底：工人这一轮结束了、信箱里还有没看的留言 → 作为下一条消息交给它（保证不丢）
setInterval(() => {
  // 经理答应过的「做完这一轮就拆话题」
  if (pendingSplit && !workerBusy(pendingSplit.chat)) { const p = pendingSplit; pendingSplit = null; runTopicSplit(p.msg, p.chat); }
  try {
    const unread = mgr.mailboxUnread();
    if (!unread.length) return;
    for (const [chat, msg] of lastDshMsg) {
      const q = dshQueue.get(chat);
      if (workerBusy(chat) || (q && (q.running || q.items.length))) continue;
      mgr.mailboxMarkRead(unread.map((x) => x.id));
      const body = unread.map((x) => '- ' + x.text).join('\n');
      log('mailbox deliver chat=' + chat + ' n=' + unread.length);
      enqueueDsh(msg, '【你刚才干活时主人说的话（经理转达，你还没看到）】\n' + body + '\n请现在处理：需要调整刚交付的就调整，需要回答就回答。');
      break;
    }
  } catch (e) { log('mailbox deliver ERROR ' + String((e && e.message) || e)); }
}, 15000).unref();

// ---------- 显式队列（2026-09-28 改向 v2 步骤 1） ----------
// 原来是 Map<chat, Promise> 的 Promise 链，毛病是只能尾插：
// 队列里若已排了 2 条普通消息，中途插话的「改向重跑」会排到第 3 位，
// 等前面两条跑完才生效 —— 那就不叫立刻改向了。
// 现在改成显式队列：普通任务尾插，改向重跑用 priority 插到队首。
// 正在跑的那个任务不受影响（不能并发写同一会话），它一结束就轮到队首。
// 关键：running 必须在 finally 里清掉，否则这个聊天永久卡死。
const dshQueue = new Map(); // chat -> { running, items: [{fn, resolve, reject}] }

function enqueueChat(chat, fn, opts) {
  let q = dshQueue.get(chat);
  if (!q) { q = { running: false, items: [] }; dshQueue.set(chat, q); }
  return new Promise((resolve, reject) => {
    const item = { fn, resolve, reject };
    if (opts && opts.priority) q.items.unshift(item);   // 改向重跑插队首
    else q.items.push(item);
    pumpChat(chat);
  });
}

// 2026-09-28 注意：调用方（enqueueDsh / enqueueDshReset / 入口分支）都不接返回的 Promise。
// 老实现用 `.catch(() => {})` 把 answerDsh 的异常吞掉了，换成显式队列后这层保护会丢，
// 异常会变成 unhandledRejection 直接把整个进程带走（ask-codex 就是这么死的）。
// 所以这里由队列自己兜底：任务失败只记日志，绝不让它冒泡成未捕获异常。
function enqueueChatSafe(chat, fn, opts) {
  return enqueueChat(chat, fn, opts).catch((e) => {
    log('enqueueChat 任务异常 ' + chat + '：' + String((e && e.stack) || e));
  });
}

function pumpChat(chat) {
  const q = dshQueue.get(chat);
  if (!q || q.running) return;
  const item = q.items.shift();
  if (!item) return;                      // 空了，但条目留着（复用）
  q.running = true;
  // 注意：fn 抛错也要走到 finally 把 running 清掉，并把队列继续推下去
  Promise.resolve()
    .then(() => item.fn())
    .then((v) => item.resolve(v), (e) => item.reject(e))
    .finally(() => {
      q.running = false;
      if (!q.items.length && !q.running) dshQueue.delete(chat);   // 没活了就回收，防内存泄漏
      else pumpChat(chat);
    });
}

function enqueueDsh(msg, text, opts) { enqueueChatSafe(chatKey(msg), () => answerDsh(msg, text), opts); }
// 普通新消息：出队时先判定话题归属（判定必须在出队时做，不能在入队时 —— 前面排着的消息可能已经换了前台话题）
function enqueueDshRouted(msg, text) { enqueueChatSafe(chatKey(msg), () => answerDsh(msg, text, { route: true })); }
// 「切错了」：能撤回就撤回、回原话题重答；没切过就拿上一句重新找归属
async function handleMisroute(msg, said, claim, ctx) {
  const chat = chatKey(msg);
  const rv = threads.revert(chat);
  if (rv) {
    let txt = rv.texts.join('\n');
    if (claim.extra) txt += '\n（主人补充：' + claim.extra + '）';
    log('misroute revert chat=' + chat + ' ' + rv.from + '→' + rv.to);
    return answerDsh(msg, txt, { raw: true, reask: { prefix: rv.prefix, note: '🧵 撤回：回到话题「' + rv.title + '」重答' } });
  }
  const prev = threads.lastUserText(chat);
  if (prev) return answerDsh(msg, said, { raw: true, route: true, hint: { prev, interruptedPrev: !!ctx.interrupted } });
  return answerDsh(msg, said, { raw: true, reask: { prefix: MISROUTE_NOFIND_NOTE } });
}
function enqueueDshReset(msg) {
  enqueueChatSafe(chatKey(msg), async () => {
    // 多话题：/new = 开一个新话题；旧话题原样保留（它的会话还在），以后聊回去会自动切回
    if (threads) { try { threads.forceNew(chatKey(msg)); } catch (e) { log('thread forceNew ERROR ' + String((e && e.message) || e)); } }
    setDshSession(chatKey(msg), null); setDshMeta(chatKey(msg), null);
    await reply(msg, '✅ DSH 新会话已开。').catch(() => {});
  });
}
function topicsReport(chat) {
  const s = threads && threads.summary(chat);
  if (!s) return '还没有话题记录（多话题' + (threads ? '已开，发条消息就有了' : '已关闭') + '）。';
  return '当前话题：「' + s.fg.title + '」\n全部话题（新的在前）：\n' +
    s.threads.slice(0, 12).map((t) => (t.id === s.fg.id ? '▶ ' : '· ') + t.title + '（' + live.dur(Date.now() - t.lastActiveAt) + '前）').join('\n') +
    '\n\n系统会按你说的内容自动切，不用管。切错了说「切错了」。';
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const u = new URL(req.url, 'http://127.0.0.1');
  const ep = u.pathname.replace(/^\/+/, '');
  const target = realBase() + '/' + ep + (u.search || '');
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'content-length' || lk === 'connection') continue;
    headers[k] = v;
  }
  try {
    const r = await fetch(target, { method: req.method, headers, body: raw.length ? raw : undefined });
    const text = await r.text();
    if (ep.endsWith('bot/getupdates') && r.status === 200) {
      let j = null;
      try { j = JSON.parse(text); } catch {}
      if (j && Array.isArray(j.msgs)) {
        const m = modes();
        const keep = [];
        let consumed = 0;
        for (const msg of j.msgs) {
          const chat = chatKey(msg);
          const t = textOf(msg).trim();
          if (t === '/进度' || t === '进度' || t === '/状态' || t === '/progress') { consumed++; reply(msg, progressReport(chat)).catch(() => {}); continue; }
          if (t === '/经理' || t === '经理') { consumed++; reply(msg, managerReport(chat)).catch(() => {}); continue; }
          if (t === '/经理开' || t === '/经理关') { consumed++; mgr.setOn(chat, t === '/经理开'); reply(msg, t === '/经理开' ? '🧑‍💼 经理上班了：它干活时你随时说话，我秒回、帮你转达。' : '经理下班了，恢复原来的方式（干活时的话排队，「停」照样有效）。').catch(() => {}); continue; }
          if (t === '/拆话题' || t === '拆话题') { consumed++; runTopicSplit(msg, chat); continue; }
          if (t === '/话题' || t === '/topics') { consumed++; reply(msg, topicsReport(chat)).catch(() => {}); continue; }
          if (t === '/mode' || t === '模式') { consumed++; reply(msg, modeReport(chat)).catch(() => {}); continue; }
          if (t === '/local' || t === '本地') { setMode(chat, 'local'); m[chat] = 'local'; consumed++; reply(msg, '✅ 已切换 → ' + modeLabel('local')).catch(() => {}); continue; }
          if (t === '/ai' || t === '回来') { setMode(chat, 'ai'); m[chat] = 'ai'; consumed++; reply(msg, '✅ 已切换 → ' + modeLabel('ai')).catch(() => {}); continue; }
          if (t === '/dsh') { setMode(chat, 'dsh'); m[chat] = 'dsh'; consumed++; reply(msg, '✅ 已切换 → ' + modeLabel('dsh') + '\n/new 开新会话，/mode 看状态').catch(() => {}); continue; }
          // /new 时清掉还没落地的改向缓冲：那是给**旧**任务的补充，
          // 新会话带着它跑会莫名其妙（GPT 方案七指出的坑）。
          if (m[chat] === 'dsh' && (t === '/new' || t === '/reset')) { consumed++; clearPendingSteer(chat); enqueueDshReset(msg); continue; }
          if ((m[chat] === 'local' || m[chat] === 'dsh') && seenBefore(msg)) { consumed++; log('dup msg dropped chat=' + chat); continue; }
          // 多话题：「切错了」—— 放在叫停/改向前面判（语音消息 textOf 为空，所以也看语音转写）。
          // 先入队（插队首）再中断当前轮：正在答的多半就是放错地方的那句，答案作废、回原话题重答。
          const said = t || voiceText(msg).trim();
          if (m[chat] === 'dsh') lastDshMsg.set(chat, msg);
          const claim = (m[chat] === 'dsh' && threads) ? misrouteClaim(said) : null;
          if (claim) {
            consumed++;
            const a = activeRuns.get(chat);
            const ctx = { interrupted: !!(a && a.kind === 'chat') };
            log('misroute claim chat=' + chat + ' text=' + JSON.stringify(said.slice(0, 40)) + (ctx.interrupted ? ' interrupt=' + a.runId.slice(0, 8) : ''));
            clearPendingSteer(chat);
            enqueueChatSafe(chat, () => handleMisroute(msg, said, claim, ctx), { priority: true });
            if (ctx.interrupted) interruptCurrentRun(chat, a.runId).then((ok) => log('misroute interrupt ' + (ok ? 'done' : 'noop') + ' chat=' + chat)).catch((e) => log('misroute ERROR ' + String((e && e.message) || e)));
            continue;
          }
          // 中途叫停（第一阶段：只认确定性硬规则，不走模型）—— 必须绕开 enqueueDsh 的串行链，
          // 否则这条消息会排在旧任务后面，等旧任务跑完才被处理，等于永远打断不了。
          // 2026-09-28 修：原来只看文字 t，主人用语音说「停」时 t 为空 → 从来停不下来。改看 said（文字或语音转写）
          if (m[chat] === 'dsh' && isHardStop(said) && activeRuns.has(chat)) {
            consumed++;
            const a = activeRuns.get(chat);
            // 2026-09-28 修：此处原有 `const sidBak = getDshSession(chat);`，
            // 但 getDshSession 全文件从未定义 → 命中叫停即抛 ReferenceError，被外层 catch 接住后
            // 整批 getupdates 返回 502、同批消息全部丢失（叫停功能实际上一直是坏的，Claude 审出）。
            // sidBak 后来也没被用到，直接删除。若将来需要读会话：dshSessions()[chat]。
            log('interrupt requested chat=' + chat + ' text=' + JSON.stringify(said.slice(0, 30)) + ' run=' + a.runId.slice(0, 8));
            // 2026-09-28 修 ④：交接进行中不叫停（正在把上下文写进交接文档，打断会留半截文档）
            if (a.kind === 'handoff') {
              log('interrupt refused (handoff running) chat=' + chat);
              await reply(msg, '⏳ 这会正在收尾写交接，停不了。\n（就快好了，等它写完再发「停」我就停。）').catch(() => {});
              continue;
            }
            (async () => {
              const ok = await interruptCurrentRun(chat, a.runId);
              log('interrupt ' + (ok ? 'done' : 'noop') + ' chat=' + chat + ' run=' + a.runId.slice(0, 8));
              // 回执按真实结果说话：没停成就别说"停了"
              await reply(msg, ok
                ? '⛔ 停了。\n（当前这轮已中断，做到哪没保留；发「继续」我接着做，/new 重新开始。）'
                : 'ℹ️ 这轮刚好已经结束了，没需要停的。').catch(() => {});
            })().catch((e) => log('interrupt ERROR ' + String((e && e.message) || e)));
            continue;
          }
          // 经理（2026-09-28）：工人干活时，主人的话（文字或语音转写）先给经理，经理秒回并决定怎么转达。
          // 开着经理就不再走下面「改方向」的规则判定。图片/文件（没有文字）照旧排队。
          if (m[chat] === 'dsh' && said && !said.startsWith('/') && mgr.isOn(chat, cfg.managerMode) && workerBusy(chat)) {
            consumed++;
            lastDshMsg.set(chat, msg);
            handleManager(msg, chat, said).catch((e) => log('manager ERROR chat=' + chat + ' ' + String((e && e.stack) || e)));
            continue;
          }
          // 方案甲：改方向/补充。同样必须绕开 enqueueDsh 串行链，否则排在旧任务后面等于没打断。
          // 与叫停的区别：中断后自动带新指令重跑，且沿用同一 sid（上下文不丢）。
          // 2026-09-28 修 ④：只中断 kind==='chat' 的用户任务。收尾交接（handoff）正把整段上下文
          // 写进交接文档，打断它会丢上下文、留下半截文档 —— 那种情况老老实实排队等它做完。
          // 2026-09-28 修 ⑤：必须**先入队再中断**。反过来的话，中断让旧轮立刻 resolve、
          // 队列空出来，若有别的排队任务就会先跑掉，改向反而排到了别人后面。
          // 而且入队是同步的、纯内存操作，不会失败，放前面没有任何风险。
          // 2026-09-28 修 ⑥（Claude 审出的 Bug 3）：入口不再只认 isSteer。
          // 原来要求 isSteer(t) 命中才进这条分支，而 isSteer 只认 40 字以内、以「补充/改成/另外」等开头的句子。
          // 「这个坑要记到知识库里」这种真实补充根本匹配不上，会落到普通排队，排在长任务后面 ——
          // 正是主人抱怨的「变成排队」。现在改成：有 chat 任务在跑 + 这句不是停止/不是「切错了」/不太短，
          // 就送 peekTopic 判一次。isSteer 命中只当「快速通道」（省一次裁判）。
          const steerLike = isSteer(t);
          const steerCandidate = m[chat] === 'dsh' && activeRuns.has(chat)
            && (steerLike || (!isHardStop(t) && t.length >= 4 && !t.startsWith('/')));
          if (steerCandidate) {
            const a = activeRuns.get(chat);
            if (a.kind === 'handoff') {
              // 交接进行中：不改向、不中断，退回普通排队（按原顺序接着做）
              consumed++;
              log('steer deferred (handoff running) chat=' + chat + ' text=' + JSON.stringify(t.slice(0, 40)));
              enqueueDsh(msg, t);
              continue;
            }
            // 已经在合并窗口里 → 这句攒进去，不再重复中断（连补几句只打断一次）
            if (pendingSteer.has(chat)) {
              consumed++;
              log('steer merged chat=' + chat + ' text=' + JSON.stringify(t.slice(0, 40)));
              if (!absorbSteer(chat, t, msg)) {
                // 批数用完了：这句没被吸收，得自己排队，不能丢
                log('steer max reached, fallback queue chat=' + chat + ' text=' + JSON.stringify(t.slice(0, 40)));
                enqueueDsh(msg, t);
              }
              continue;
            }
            consumed++;
            log('steer requested chat=' + chat + ' text=' + JSON.stringify(t.slice(0, 40)) + ' run=' + a.runId.slice(0, 8));
            // 2026-09-28 新增（主人要求）：插话前先问「这还是同一个话题吗」。
            //   同一话题 → 打断当前轮，在原会话里接着往下做（增量续跑，不从头重来）
            //   不同话题 → 不打断，交给 threads.route 去开/切话题（在 answerDsh 里做）
            // 判定失败一律当「同一话题」（插话本就是要求调整当前任务，留住更安全）。
            const sameTopic = threads ? await (async () => {
              try {
                const pk = await threads.peekTopic(chat, t);
                log('steer topic chat=' + chat + ' same=' + pk.same + ' sure=' + (pk.sure || 0).toFixed(2) + ' ' + pk.why);
                return pk.same !== false;      // true 或 'unknown' 都当同一话题
              } catch (e) {
                log('steer topic ERROR chat=' + chat + ' ' + String((e && e.message) || e));
                return true;
              }
            })() : true;
            if (!sameTopic) {
              // 跑题了：不打断当前轮，按普通消息排队 —— answerDsh 里的 route 会把这句放到它该去的话题
              log('steer diverted (other topic) chat=' + chat + ' text=' + JSON.stringify(t.slice(0, 40)));
              enqueueDshRouted(msg, t);
              continue;
            }
            // 先入队（插队首），再中断 —— 顺序不能反，理由见上
            enqueueDsh(msg, wrapSteer(t), { priority: true });
            // 开合并窗口接住紧随其后的补充。**不要**把 t 再放进去 —— t 已经在上行执行了，
            // 放进去会在 12 秒后被合并再跑一遍，等于同一条指令跑两次（Claude 2026-09-28 审出的 Bug 2）。
            absorbSteer(chat, null, msg);
            (async () => {
              const ok = await interruptCurrentRun(chat, a.runId);
              log('steer interrupt ' + (ok ? 'done' : 'noop') + ' chat=' + chat + ' run=' + a.runId.slice(0, 8));
              // 回执措辞尽量「无感」：不提"话题"这种内部概念
              await reply(msg, ok
                ? '🔁 收到，接着改。'
                : '📥 收到，紧接着执行。').catch(() => {});
            })().catch((e) => log('steer ERROR ' + String((e && e.message) || e)));
            continue;
          }
          if (m[chat] === 'local') { consumed++; answerLocal(msg, t).catch(() => {}); continue; }
          if (m[chat] === 'dsh') { consumed++; enqueueDshRouted(msg, t); continue; }
          keep.push(msg);
        }
        if (consumed) { j.msgs = keep; log('filtered ' + consumed + ' msg(s), forwarded ' + keep.length); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(j));
        return;
      }
    }
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
    res.end(text);
  } catch (e) {
    log('proxy ERROR ' + ep + ' ' + String((e && e.message) || e));
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ret: -1, errmsg: 'wx-router proxy error' }));
  }
});
live.init();
server.listen(cfg.listenPort, cfg.listenHost, () => log('wx-router listening on ' + cfg.listenHost + ':' + cfg.listenPort + ' -> ' + realBase()));
