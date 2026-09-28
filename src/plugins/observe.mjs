/**
 * 可观测：指标累计 + 面板 API（只听 127.0.0.1，面板后端 aibox-dashboard.py 反代到 /api/v2/*）。
 *   GET /api/v2/status    引擎、运行时长、插件、线路、在跑的任务、队列
 *   GET /api/v2/metrics   最近 N 天的指标（?days=7）
 *   GET /api/v2/events    最近的结构化事件（?since=毫秒时间戳）
 *   GET /api/v2/describe  插件/命令/流水线挂点一览（给人和 AI 看网关的结构）
 *   其它插件用 app.api() 注册的：topics、helpers、manager、evolve …
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { cfg, APP_DIR } from '../core/config.mjs';
import { log, emit, recentEvents, errText, tag } from '../core/log.mjs';
import * as metrics from '../observe/metrics.mjs';
import * as live from '../observe/live.mjs';
import { allQueues } from '../agent/queue.mjs';
import { routeLabel, goCooldownUntil } from '../agent/dsh.mjs';

const startedAt = Date.now();
let version = 'dev';
try { version = execFileSync('git', ['-C', APP_DIR, 'describe', '--always', '--dirty'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}

export default {
  name: 'observe', desc: '指标和面板 API',
  setup(app) {
    metrics.start();
    // 入站消息计数（只记模式、长短、有没有语音/媒体）
    app.ingress(34, 'count', (ctx) => {
      emit('msg.in', { chat: tag(ctx.chat), mode: ctx.mode || 'ai', len: ctx.said.length, voice: !ctx.t && !!ctx.said });
    });

    app.api('status', () => ({
      engine: 'v2', version, pid: process.pid, startedAt, uptimeMs: Date.now() - startedAt, node: process.version,
      route: routeLabel(), goCooldownUntil: goCooldownUntil(),
      plugins: app.plugins, live: live.snapshot(), queues: allQueues().map((q) => ({ ...q, chat: tag(q.chat) })),
      config: { dshContextBudget: cfg.dshContextBudget, dshIdleMs: cfg.dshIdleMs, dshTimeoutMs: cfg.dshTimeoutMs, handoffWarnPct: cfg.handoffWarnPct, managerMode: cfg.managerMode, tunables: cfg._tunables },
    }));
    app.api('metrics', (q) => ({ today: metrics.today(), days: metrics.lastDays(Math.min(60, Number(q.get('days')) || 7)) }));
    app.api('events', (q) => recentEvents(Number(q.get('since')) || 0, Math.min(500, Number(q.get('limit')) || 200)));
    app.api('describe', () => app.describe());

    if (!cfg.apiPort) return;
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const name = u.pathname.replace(/^\/api\/v2\/?/, '').replace(/\/+$/, '');
      const fn = app.apis.get(name);
      if (req.method !== 'GET' || !fn) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); return; }
      try {
        const body = await fn(u.searchParams);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: errText(e) }));
      }
    });
    srv.on('error', (e) => log('api server ERROR ' + errText(e)));
    srv.listen(cfg.apiPort, cfg.apiHost, () => log('api listening on ' + cfg.apiHost + ':' + cfg.apiPort));
    app.apiServer = srv;
  },
};
