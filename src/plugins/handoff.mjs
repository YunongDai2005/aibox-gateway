/**
 * 会话交接：旧会话自压缩成交接包 → 新会话注入核对 → 首次成功回复后才消费。
 *   换会话的三个触发：daily = 凌晨 4 点日切；idle = 隔 handoffIdleMs 没说话；context = 上下文估算到预算
 *   交接包同时落盘进存档链 handoffs/NNNN-*.md + INDEX.md（handoff-store.mjs），recall 查得到
 *   没有自动交接包时，新会话首条读一次 handoffs/ 里 24 小时内最新的一份兜底
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg, paths } from '../core/config.mjs';
import { log, emit, errText, tag } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';
import * as S from '../agent/session.mjs';
import { runDsh, noFinal, coolingDown, ocSession } from '../agent/dsh.mjs';
import { registerActiveRun, beginGeneration } from '../agent/runs.mjs';

// 交接包字段 = agent-session-harness 的 capsule + Zylos 要点 + project-handoff 五段式；只给要点和路径，不贴长文
export const HANDOFF_PROMPT = `请把当前整个会话压缩成一份"交接包"，只输出 JSON 对象本身，不要任何解释文字，不要 Markdown 代码块围栏。
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

const handoffDir = () => path.join(cfg.dshCwd, 'handoffs');

export function lastDayBoundary(now = Date.now()) {
  const d = new Date(now); d.setHours(cfg.dayBoundaryHour, 0, 0, 0);
  if (now < d.getTime()) d.setDate(d.getDate() - 1);
  return d.getTime();
}

function parseHandoff(final) {
  const t = String(final).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { JSON.parse(t.slice(a, b + 1)); return { text: t.slice(a, b + 1).slice(0, cfg.handoffMaxChars), raw: false }; } catch {}
  }
  return { text: t.slice(0, cfg.handoffMaxChars), raw: true };
}

async function archiveHandoff(p, fp, sid, reason) {
  try {
    process.env.HANDOFF_DIR = handoffDir();
    const hs = await import(path.join(paths.bin, 'handoff-store.mjs'));
    let j = null;
    if (!p.raw) { try { j = JSON.parse(p.text); } catch {} }
    const title = (j && (j.title || j.intent)) || '（未命名交接）';
    const r = hs.saveHandoff({ title, keywords: (j && j.keywords) || [], reason, sid, fp, body: j ? hs.packetToMarkdown(j) : p.text });
    log('handoff archived file=' + r.name + ' prev=' + (r.prev || '-'));
  } catch (e) {
    log('handoff archive ERROR ' + errText(e));
  }
}

export async function buildHandoff(chat, sid, meta, reason = 'rotate', run = null) {
  try {
    const n = (meta && meta.msgCount) || 1;
    if (n < cfg.handoffMinMsgs) { log('handoff skip chat=' + chat + ' msgs=' + n + '<' + cfg.handoffMinMsgs); return null; }
    const t0 = Date.now();
    const r = await runDsh(HANDOFF_PROMPT, sid, { fallback: coolingDown(), ocSession: ocSession(chat, sid), timeoutMs: cfg.handoffTimeoutMs, onEvent: run && run.event, chat, generation: beginGeneration(chat), register: registerActiveRun(chat, 'handoff') });
    if (r.interrupted || r.stale) { log('handoff interrupted chat=' + chat); return null; }
    if (noFinal(r)) { log('handoff FAILED chat=' + chat + ' err=' + r.errTail.replace(/\s+/g, ' ').slice(-200)); emit('handoff.failed', { chat: tag(chat), reason }); return null; }
    const p = parseHandoff(r.final);
    const fp = crypto.createHash('sha256').update(p.text).digest('hex').slice(0, 16);
    log('handoff done chat=' + chat + ' chars=' + p.text.length + ' fp=' + fp + (p.raw ? ' raw' : ''));
    emit('handoff.built', { chat: tag(chat), reason, chars: p.text.length, raw: p.raw, ms: Date.now() - t0 });
    await archiveHandoff(p, fp, sid, reason);
    return { ts: Date.now(), from: sid, fp, text: p.text };
  } catch (e) {
    log('handoff ERROR chat=' + chat + ' err=' + errText(e));
    return null;
  }
}

// 只认存档链里的单份交接（NNNN-*.md），24 小时内最新的一份
function latestHandoffFile() {
  try {
    const dir = handoffDir();
    const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.md$/.test(f)).map((f) => {
      const p = path.join(dir, f);
      return { p, f, m: fs.statSync(p).mtimeMs };
    }).sort((a, b) => b.m - a.m);
    if (!files.length) return null;
    const top = files[0];
    if (Date.now() - top.m > 24 * 3600 * 1000) return null;
    return { name: top.f, text: fs.readFileSync(top.p, 'utf8').slice(0, cfg.handoffMaxChars) };
  } catch { return null; }
}

export function injectHandoff(text, hf) {
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

export default {
  name: 'handoff', desc: '会话快满/隔天/久不说话时自动交接给新会话，不丢进度',
  setup(app) {
    // session@20：该换会话了吗（只看"会话和元数据一致"的情况；失配的已被核心冷切）
    app.stage('session', 20, async (T) => {
      const { chat, sid, meta, run, msg } = T;
      if (!(sid && meta && meta.sid === sid)) return;
      let reason = null;
      // 多话题：切回的老话题用 resumedAt 算日切，否则切回昨天的话题会立刻被"日切"压缩掉
      if (Math.max(meta.startedAt || 0, meta.resumedAt || 0) < lastDayBoundary()) reason = 'daily';
      else if (meta.lastMsgAt && Date.now() - meta.lastMsgAt > cfg.handoffIdleMs) reason = 'idle';
      else if ((meta.ctxIn || 0) >= cfg.dshContextBudget * cfg.handoffSwitchPct) reason = 'context';
      if (!reason) return;
      log('dsh rotate chat=' + chat + ' reason=' + reason + ' old=' + sid);
      emit('session.rotate', { chat: tag(chat), reason, ctx: meta.ctxIn || 0, msgs: meta.msgCount || 0 });
      run.note('先把旧会话压缩成交接包（' + reason + '）'); run.setCtx({ rotate: reason });
      const packet = await buildHandoff(chat, sid, meta, reason, run);   // 失败则冷切，绝不让用户干等
      S.resetSession(chat); T.sid = undefined;
      if (packet) { S.setPendingHandoff(chat, packet); log('handoff staged chat=' + chat + ' from=' + packet.from + ' fp=' + packet.fp); }
      T.meta = S.getMeta(chat);
      T.fresh = true;
      const why = reason === 'daily' ? '新的一天' : reason === 'idle' ? '隔了很久没说话' : '会话上下文快满了';
      await wx.replySoft(msg, packet ? '🆕 DSH 换了新会话（' + why + '）\n✅ 要点已自动交接给新会话。' : '🆕 DSH 换了新会话（' + why + '，旧对话不带入）。');
    });

    // context@10：有未消费的交接包就注入（新会话每条都带，直到首次成功回复）；否则新会话首条读一次文件兜底
    app.stage('context', 10, (T) => {
      const { chat, meta } = T;
      if (meta && meta.pendingHandoff) {
        T.text = injectHandoff(T.text, meta.pendingHandoff);
        T.injected = true;
        log('handoff inject chat=' + chat + ' chars=' + meta.pendingHandoff.text.length + ' fp=' + meta.pendingHandoff.fp);
      } else if (T.fresh && !(meta && meta.fileInjectedAt)) {
        const before = T.text;
        T.text = injectHandoff(T.text, null);
        if (T.text !== before) { T.injected = true; log('handoff inject from file chat=' + chat); }
        S.markFileInject(chat);   // 没有可用文件也记一笔，避免每轮重复扫盘
      }
    });

    // afterRun@10：成功回复了 → 交接包消费掉（必须在核心保存新 sid 之前，否则会被带进新会话的元数据）
    app.stage('afterRun', 10, (T) => {
      if (T.injected && !noFinal(T.r)) { S.clearPendingHandoff(T.chat); log('handoff consumed chat=' + T.chat); emit('handoff.consumed', { chat: tag(T.chat) }); }
    });

    // afterRun@30：上下文水位（本轮单步输入峰值 ≈ 当前上下文规模）；到 warnPct 提醒一次
    app.stage('afterRun', 30, async (T) => {
      const { r, chat } = T;
      if (!(r.sessionId && r.usagePeak > 0)) return;
      const e = S.patchMeta(chat, { ctxIn: r.usagePeak });
      const pct = e.ctxIn / cfg.dshContextBudget;
      T.run.setCtx({ ctx: r.usagePeak, budget: cfg.dshContextBudget, warnPct: cfg.handoffWarnPct });
      if (!e.handoffWarned && pct >= cfg.handoffWarnPct) {
        S.patchMeta(chat, { handoffWarned: true });
        await wx.replySoft(T.msg, '⚠️ 这个会话上下文用到 ' + Math.round(pct * 100) + '% 了。到 ' + Math.round(cfg.handoffSwitchPct * 100) + '% 我会自动开新会话，要点自动交接，不丢进度。');
      }
    });

    app.status((chat) => {
      const m = S.getMeta(chat);
      if (!m || !m.ctxIn) return '';
      return '上下文：' + Math.round((m.ctxIn / cfg.dshContextBudget) * 100) + '%（到 ' + Math.round(cfg.handoffSwitchPct * 100) + '% 自动交接）';
    });
  },
};
