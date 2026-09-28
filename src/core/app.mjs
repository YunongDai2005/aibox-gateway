/**
 * app：插件注册中心。网关的每块功能都是一个插件，插件只通过这几个挂点接入：
 *
 *   command({ names, help, modes, handle })   微信命令（整句精确匹配，如 /进度）
 *   ingress(order, name, fn)                  入站消息管道：fn(ctx) 返回 'consume' / 'keep' / 其它=交给下一个
 *   stage(name, order, fn)                    一轮对话（turn）的流水线阶段，见 STAGES
 *   status(fn)                                /mode 回执和面板 API 里的状态行
 *   every(ms, fn)                             定时任务
 *   api(path, fn)                             面板 API（GET /api/v2/<path>）
 *   listen(name, fn) / notify(name, data)     插件之间的进程内通知（如 'new' = 主人发了 /new）
 *
 * 流水线阶段（按顺序）：
 *   input → turnStart → route → session → context → run → afterRun → deliver → afterReply
 *   任一阶段把 turn.stop 置 true，后面的阶段都不再跑（例如被叫停）。
 */
import { log, errText, emit } from './log.mjs';

export const STAGES = ['input', 'turnStart', 'route', 'session', 'context', 'run', 'afterRun', 'deliver', 'afterReply', 'reset'];

export function createApp(cfg) {
  const stages = Object.fromEntries(STAGES.map((s) => [s, []]));
  const app = {
    cfg,
    plugins: [],
    commands: [],
    ingressList: [],
    statusFns: [],
    apis: new Map(),
    timers: [],

    use(plugin) {
      const on = cfg.features?.[plugin.name] !== false;
      if (!on && !plugin.core) { log('plugin off ' + plugin.name); return app; }
      app.plugins.push({ name: plugin.name, desc: plugin.desc || '', core: !!plugin.core });
      app._cur = plugin.name;
      plugin.setup(app);
      app._cur = null;
      return app;
    },
    has(name) { return app.plugins.some((p) => p.name === name); },

    command(c) { app.commands.push({ ...c, plugin: app._cur }); },
    ingress(order, name, fn) { app.ingressList.push({ order, name, fn, plugin: app._cur }); app.ingressList.sort((a, b) => a.order - b.order); },
    stage(name, order, fn) {
      if (!stages[name]) throw new Error('未知阶段 ' + name);
      stages[name].push({ order, fn, plugin: app._cur });
      stages[name].sort((a, b) => a.order - b.order);
    },
    async runStage(name, turn) {
      for (const s of stages[name]) {
        if (turn.stop) return;
        await s.fn(turn);
      }
    },
    status(fn) { app.statusFns.push(fn); },
    statusLines(chat, mode) {
      const out = [];
      for (const fn of app.statusFns) { try { const l = fn(chat, mode); if (l) out.push(l); } catch (e) { log('status ERROR ' + errText(e)); } }
      return out;
    },
    every(ms, fn) {
      const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => log('timer ERROR ' + errText(e))); }, ms);
      t.unref?.();
      app.timers.push(t);
    },
    api(p, fn) { app.apis.set(p, fn); },
    // 进程内通知（带完整数据，不落盘；落盘的用 emit）
    listen(name, fn) { (app._hooks[name] ||= []).push(fn); },
    notify(name, data) { for (const fn of app._hooks[name] || []) { try { fn(data); } catch (e) { log('hook ERROR ' + name + ' ' + errText(e)); } } },
    _hooks: {},
    describe() {
      return {
        plugins: app.plugins,
        commands: app.commands.filter((c) => c.help).map((c) => ({ names: c.names, help: c.help, plugin: c.plugin })),
        stages: Object.fromEntries(STAGES.map((s) => [s, stages[s].map((x) => x.plugin + '@' + x.order)])),
        ingress: app.ingressList.map((x) => x.plugin + ':' + x.name + '@' + x.order),
      };
    },
    emit,
  };
  return app;
}
