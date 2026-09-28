/**
 * 自进化插件：收信号 → 每晚复盘（L0 报告 + L1 调参 + L2 提案）→ 主人在微信里批准/上线。
 *   /进化          昨天的复盘摘要 + 待处理的提案
 *   /批准 N        让外援在 WorkTree 里实现提案 N（跑测试，不上线）
 *   /上线 N        测试通过的提案合并并安全重启
 *   /否决 N        丢掉提案 N
 *   /复盘          现在就复盘一次昨天（不花钱写提案）
 *   /回滚调参       L1 自动调过的参数全部退回你 config.json 里的原值
 */
import { cfg } from '../core/config.mjs';
import { log, emit, errText, tag } from '../core/log.mjs';
import * as wx from '../channel/wechat.mjs';
import * as metrics from '../observe/metrics.mjs';
import * as signals from '../evolve/signals.mjs';
import * as tunables from '../evolve/tunables.mjs';
import * as proposals from '../evolve/proposals.mjs';
import { runRetro, lastRetro } from '../evolve/retro.mjs';

const STATUS = { proposed: '待批准', building: '外援实现中', ready: '测试通过·待上线', shipped: '已上线', rejected: '已否决', failed: '没做成', test_failed: '测试没过', merge_failed: '合并失败' };

function brief() {
  const r = lastRetro();
  const L = [];
  if (r) {
    const s = r.stats || {};
    L.push('🧬 最近复盘（' + r.day + '）：任务 ' + (s.turns || 0) + ' 个，成功率 ' + (s.successRate == null ? '—' : Math.round(s.successRate * 100) + '%') + '，p90 ' + (s.p90 == null ? '—' : Math.round(s.p90 / 1000) + ' 秒'));
    const c = r.counts || {};
    L.push('不满意信号：抱怨 ' + (c.complaint || 0) + ' · 切错了 ' + (c.misroute || 0) + ' · 叫停 ' + (c.stop || 0) + ' · 被停下 ' + (c.kill || 0));
    if (r.rolled) L.push('↩️ 回滚了 ' + r.rolled.key + '（' + r.rolled.why + '）');
    for (const ch of r.changes || []) L.push('🔧 ' + ch.key + ' ' + ch.from + ' → ' + ch.to + '（' + ch.reason + '）');
  } else L.push('🧬 还没复盘过（每天 ' + cfg.evolve.retroHour + ' 点自动复盘前一天）。');
  const open = proposals.list().filter((p) => ['proposed', 'building', 'ready', 'test_failed'].includes(p.status));
  if (open.length) {
    L.push('', '提案：');
    for (const p of open) L.push('#' + Number(p.id) + ' ' + p.title + ' · ' + (STATUS[p.status] || p.status) + '（' + p.kind + '，风险 ' + p.risk + '）\n   ' + p.problem.slice(0, 80));
    L.push('', '/批准 N 让外援去做 · /上线 N 合并重启 · /否决 N 丢掉');
  } else L.push('没有待处理的提案。');
  return L.join('\n');
}

export default {
  name: 'evolve', desc: '每晚复盘，自动微调参数，写改进提案（你批准才改代码）',
  setup(app) {
    signals.start();
    // 主人的每句话都过一遍信号检测（只看不拦）
    app.ingress(33, 'signals', (ctx) => { if (ctx.mode === 'dsh') signals.onUserText(tag(ctx.chat), ctx.said); });

    const notify = (t) => wx.notifyOwner(t).catch((e) => log('evolve notify ERROR ' + errText(e)));

    app.command({ names: ['/进化', '进化'], help: '自进化：昨天的复盘、自动调参、改进提案', handle: (ctx) => wx.replySoft(ctx.msg, brief()) });
    app.command({
      names: ['/复盘'], help: '现在就复盘昨天（不写提案）',
      handle: async (ctx) => {
        try { const r = await runRetro(app, { llm: false }); wx.replySoft(ctx.msg, r.md.slice(0, 1700)); }
        catch (e) { wx.replySoft(ctx.msg, '⚠️ 复盘出错：' + errText(e)); }
      },
    });
    app.command({
      names: ['/回滚调参'], help: '自动调过的参数全部退回原值',
      handle: (ctx) => {
        const n = tunables.resetAll();
        wx.replySoft(ctx.msg, n ? '↩️ 已把自动调过的参数全部退回你的原始配置（下次重启完全生效）。' : '现在没有自动调过的参数。');
      },
    });
    app.command({
      pattern: /^\/?(批准|否决|上线)\s*#?(\d+)$/, help: '处理自进化提案（N 是编号）', names: ['/批准 N', '/否决 N', '/上线 N'],
      handle: (ctx, m) => {
        const [, verb, id] = m;
        let r;
        if (verb === '批准') r = proposals.approve(id);
        else if (verb === '否决') r = proposals.reject(id);
        else r = proposals.ship(id, { idle: () => !app.agent.anyBusy() });
        log('evolve ' + verb + ' #' + id + ' ok=' + r.ok);
        wx.replySoft(ctx.msg, (r.ok ? '' : '⚠️ ') + (verb === '批准' && r.ok ? '🧬 好，外援开工了（在独立副本里做，不影响现在的服务）：\n' : '') + r.msg);
      },
    });

    // 定时：每 10 分钟看一次 —— 到点就复盘昨天；推进在做的提案
    let retroRunning = false;
    app.every(10 * 60000, async () => {
      proposals.poll(notify);
      const now = new Date();
      const yesterday = metrics.dayKey(Date.now() - 86400e3);
      const last = lastRetro();
      if (retroRunning || now.getHours() < cfg.evolve.retroHour || (last && last.day >= yesterday)) return;
      retroRunning = true;
      try {
        const r = await runRetro(app, {});
        if (r.changes.length || r.rolled || r.props.length) notify(brief());
      } catch (e) { log('evolve retro ERROR ' + errText(e)); }
      finally { retroRunning = false; }
    });

    app.api('evolve', () => ({
      last: lastRetro(), tunables: tunables.describe(), history: tunables.state().history.slice(-30),
      proposals: proposals.list().slice(-30).map((p) => ({ id: p.id, title: p.title, status: p.status, statusText: STATUS[p.status] || p.status, kind: p.kind, risk: p.risk, problem: p.problem, change: p.change, createdAt: p.createdAt, diffstat: p.diffstat || '' })),
      signals: signals.readDay(metrics.dayKey()).slice(-30).map((s) => ({ ts: s.ts, kind: s.kind })),
    }));
    app.status(() => { const n = proposals.list().filter((p) => p.status === 'proposed' || p.status === 'ready').length; return n ? '进化：' + n + ' 个提案等你处理（/进化）' : ''; });
  },
};
