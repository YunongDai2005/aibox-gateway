/**
 * 每晚复盘（自进化的心脏）。四级自主权：
 *   L0 观察   指标 + 不满意信号，写复盘报告（全自动）
 *   L1 调参   数据参数在护栏内自动微调，效果变差自动回滚（全自动，见 tunables.mjs）
 *   L2 改码   请模型读报告写改进提案 → 主人 /批准 → 外援在 WorkTree 里实现并跑测试 → 主人 /上线 才合并重启
 *   L3 永不   改安全规则、删数据、花钱、动凭证 —— 不在自进化范围内
 * 报告 ~/.aibox/evolve/reports/YYYY-MM-DD.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { cfg, paths } from '../core/config.mjs';
import { log, emit, errText } from '../core/log.mjs';
import { readJson, writeJson } from '../core/store.mjs';
import * as metrics from '../observe/metrics.mjs';
import * as signals from './signals.mjs';
import * as tunables from './tunables.mjs';
import * as proposals from './proposals.mjs';
import { responses } from '../core/llm.mjs';

const pctTxt = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
const secTxt = (ms) => (ms == null ? '—' : Math.round(ms / 1000) + ' 秒');

// 连续多少天某个指标为 0（今天之前）
function quietDays(field, days) {
  let n = 0;
  for (const d of days.slice().reverse()) { if ((d[field] || 0) === 0) n++; else break; }
  return n;
}

export function gather(day) {
  const s = metrics.day(day) || metrics.summarize({ day, counters: {}, dist: {} });
  const sig = signals.readDay(day);
  const count = (k) => sig.filter((x) => x.kind === k).length;
  const hist = [];
  for (let i = 1; i <= 14; i++) { const d = metrics.dayKey(Date.parse(day + 'T12:00:00') - (i - 1) * 86400e3); const x = metrics.day(d); if (x) hist.unshift({ ...x, resumeAfterKill: signals.readDay(d).filter((y) => y.kind === 'resume_after_kill').length }); }
  const prev = hist.slice(0, -1).slice(-3);
  const avg = (f) => (prev.length ? prev.reduce((a, x) => a + (x[f] || 0), 0) / prev.length : null);
  return {
    day, s, sig,
    input: {
      misroutes: s.misroutes, noisy: count('noisy'), progressQueries: s.progressQueries, resumeAfterKill: count('resume_after_kill'),
      quietDays: { misroutes: quietDays('misroutes', hist), resumeAfterKill: quietDays('resumeAfterKill', hist) },
    },
    baseline: { successRate: avg('successRate'), complaints: avg('complaints'), p90: avg('p90') },
    counts: Object.fromEntries(['complaint', 'noisy', 'retry', 'resume_after_kill', 'misroute', 'stop', 'kill', 'error'].map((k) => [k, count(k)])),
  };
}

// L1 回滚判定：昨天成功率比前 3 天均值掉了 15 个点以上，或抱怨翻倍（且 ≥3 条）
function worse(g) {
  const b = g.baseline, s = g.s;
  if (b.successRate != null && s.successRate != null && s.turns >= 5 && s.successRate < b.successRate - 0.15) return '成功率 ' + pctTxt(b.successRate) + ' → ' + pctTxt(s.successRate);
  if (b.complaints != null && s.complaints >= 3 && s.complaints >= 2 * Math.max(1, b.complaints)) return '抱怨 ' + b.complaints.toFixed(1) + ' → ' + s.complaints;
  return null;
}

function reportMd(g, changes, rolled, props) {
  const s = g.s, c = g.counts;
  const L = ['# 复盘 ' + g.day, '',
    '## 数字', '',
    '| 项 | 昨天 | 前 3 天均值 |', '|---|---|---|',
    '| 消息 | ' + s.msgs + ' | |',
    '| 任务 | ' + s.turns + '（成功 ' + s.ok + '，失败 ' + s.failed + '，被打断 ' + s.interrupted + '） | |',
    '| 成功率 | ' + pctTxt(s.successRate) + ' | ' + pctTxt(g.baseline.successRate) + ' |',
    '| 用时 p50 / p90 | ' + secTxt(s.p50) + ' / ' + secTxt(s.p90) + ' | p90 ' + secTxt(g.baseline.p90) + ' |',
    '| 看门狗停下 | ' + s.kills + ' | |', '| 换线路（Go→DeepSeek） | ' + s.fallbacks + ' | |',
    '| 换会话 | ' + s.rotations + ' | |', '| 话题切换 / 切错了 | ' + s.topicSwitches + ' / ' + s.misroutes + ' | |',
    '| 经理出面 / 联系不上 | ' + s.managerCalls + ' / ' + s.managerFallbacks + ' | |',
    '', '## 不满意信号', '',
    '抱怨 ' + c.complaint + ' · 嫌吵 ' + c.noisy + ' · 重发 ' + c.retry + ' · 停后又让继续 ' + c.resume_after_kill + ' · 切错了 ' + c.misroute + ' · 叫停 ' + c.stop + ' · 被停下 ' + c.kill + ' · 出错 ' + c.error, ''];
  const samples = g.sig.filter((x) => x.text).slice(-12);
  if (samples.length) { L.push('样本（已打码）：'); for (const x of samples) L.push('- [' + x.kind + '] ' + x.text); L.push(''); }
  L.push('## L1 自动调参', '');
  if (rolled) L.push('- ↩️ 回滚 `' + rolled.key + '` ' + rolled.to + ' → ' + rolled.from + '（' + rolled.why + '）');
  for (const ch of changes) L.push('- `' + ch.key + '` ' + ch.from + ' → ' + ch.to + '：' + ch.reason);
  if (!rolled && !changes.length) L.push('- 没动');
  L.push('', '## L2 改进提案（要你批准）', '');
  if (props.length) for (const p of props) L.push('- #' + p.id + ' ' + p.title + '（' + p.kind + '，风险 ' + p.risk + '）');
  else L.push('- 没有');
  return L.join('\n') + '\n';
}

const PROPOSAL_PROMPT = (g, arch) => `你是一个 AI 网关的"自进化复盘员"。网关把主人的微信消息交给一个能操作电脑的 AI 工人（DSH），还有经理、话题路由、会话交接、进度播报等插件。
下面是昨天的运行数据和主人的不满意信号（样本已打码）。请找出最值得改进的 1~3 个问题，给出具体、可验证、低风险的改法。

硬性约束：
- 不许提：改安全规则、删数据、花钱、动凭证、关掉叫停功能、扩大工人权限。
- 数据参数（阈值/间隔）已有自动调参，除非需要超出护栏，否则不要重复提。
- 每条提案必须能用网关的回放测试（test/）验证。
- 没有明确问题就返回空数组，不要硬凑。

网关结构（插件与挂点）：
${JSON.stringify(arch).slice(0, 3000)}

昨天的数据：
${JSON.stringify(g.s)}
前 3 天均值：${JSON.stringify(g.baseline)}
信号计数：${JSON.stringify(g.counts)}
信号样本：
${g.sig.filter((x) => x.text).slice(-25).map((x) => '- [' + x.kind + '] ' + x.text).join('\n') || '（无）'}

只输出 JSON：{"proposals":[{"title":"≤30字","problem":"看到了什么问题（引用数据/样本）","change":"具体改哪个插件/文件、怎么改","kind":"code|prompt|config","risk":"低|中|高","verify":"怎么验证有效","expected":"预期效果"}]}`;

export async function runRetro(app, { day = metrics.dayKey(Date.now() - 86400e3), llm = true } = {}) {
  metrics.flush();
  const g = gather(day);
  // L1：先看上次调参后是不是变差了，变差就回滚；否则按规则调
  let rolled = null, changes = [];
  if (cfg.evolve.autoTune) {
    const why = worse(g);
    const st = tunables.state();
    const lastL1 = [...st.history].reverse().find((h) => h.level === 'L1' && !h.rolledBack);
    if (why && lastL1 && Date.now() - lastL1.at < 3 * 86400e3) {
      const r = tunables.rollbackLast(why);
      if (r) rolled = { ...r, why };
    } else {
      changes = tunables.tune(g.input);
    }
    // 能热生效的参数立刻生效（话题门槛要下次重启才生效）
    for (const ch of [...changes, ...(rolled ? [{ key: rolled.key, to: rolled.from }] : [])]) {
      const ks = ch.key.split('.'); let x = cfg; for (const k of ks.slice(0, -1)) x = x[k] ||= {}; x[ks.at(-1)] = ch.to;
    }
  }
  // L2：信号够多才花钱请模型写提案
  let props = [];
  const totalSignals = Object.values(g.counts).reduce((a, b) => a + b, 0);
  if (llm && cfg.evolve.proposals && totalSignals >= cfg.evolve.proposalMinSignals) {
    try {
      const txt = await responses(cfg.llm.judgeModel || 'gpt-6-luna', PROPOSAL_PROMPT(g, app ? app.describe() : {}), { session: 'ses_aibox_evolve', maxTokens: 4000, effort: 'medium', timeoutMs: 180000, purpose: 'evolve' });
      const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
      const j = JSON.parse(txt.slice(a, b + 1));
      for (const p of (j.proposals || []).slice(0, 3)) props.push(proposals.add({ ...p, day, evidence: g.counts }));
    } catch (e) { log('evolve proposal ERROR ' + errText(e)); }
  }
  const md = reportMd(g, changes, rolled, props);
  const f = path.join(paths.evolve, 'reports', day + '.md');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, md);
  const summary = { day, at: Date.now(), stats: g.s, counts: g.counts, changes, rolled, proposals: props.map((p) => p.id), file: f };
  writeJson(path.join(paths.evolve, 'last-retro.json'), summary);
  emit('evolve.retro', { day, changes: changes.length, rolled: !!rolled, proposals: props.length, signals: totalSignals });
  log('evolve retro day=' + day + ' changes=' + changes.length + ' rolled=' + !!rolled + ' proposals=' + props.length);
  return { g, changes, rolled, props, md, summary };
}

export function lastRetro() { return readJson(path.join(paths.evolve, 'last-retro.json'), null); }
