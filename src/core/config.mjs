/**
 * config：唯一的配置入口。
 *   - 所有路径都从 AIBOX_HOME（默认 /home/aibox）推出来，测试时指到临时目录就能整套跑在别的机器上
 *   - config.json 只写要覆盖的项；缺的用 DEFAULTS；tunables.json（自进化 L1 自动调的参数）叠在最上面
 *   - validate() 启动时检查类型和范围，配置写错直接拒绝启动（guard 会自动回滚）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const HOME = process.env.AIBOX_HOME || os.homedir();
export const ROOT = process.env.AIBOX_ROOT || APP_DIR;          // 运行状态（modes.json 等）放这里，与 v1 兼容
const AIBOX = path.join(HOME, '.aibox');

export const paths = {
  home: HOME,
  root: ROOT,
  aibox: AIBOX,
  bin: path.join(HOME, 'bin'),
  logs: path.join(AIBOX, 'logs'),
  events: path.join(AIBOX, 'logs', 'events.jsonl'),
  routerLog: path.join(ROOT, 'router.log'),
  modes: path.join(ROOT, 'modes.json'),
  sessions: path.join(ROOT, 'dsh-sessions.json'),
  meta: path.join(ROOT, 'dsh-session-meta.json'),
  threads: path.join(ROOT, 'dsh-threads.json'),
  live: path.join(ROOT, 'dsh-live.json'),
  goState: path.join(ROOT, 'go-state.json'),
  tunables: path.join(ROOT, 'tunables.json'),
  credentials: path.join(HOME, '.dsh', '.credentials.yaml'),
  dshSessions: path.join(HOME, '.dsh', 'sessions'),
  helperJobs: path.join(AIBOX, 'helper-jobs'),
  quota: path.join(AIBOX, 'quota.json'),
  mgr: path.join(AIBOX, 'mgr'),
  topics: path.join(AIBOX, 'topics'),
  evolve: path.join(AIBOX, 'evolve'),
  owner: path.join(AIBOX, 'owner'),
};

export const DEFAULTS = {
  engine: 'v2',
  listenHost: '127.0.0.1',
  listenPort: 8787,
  apiHost: '127.0.0.1',
  apiPort: 8788,
  accountFile: path.join(HOME, '.openclaw/openclaw-weixin/accounts/account.json'),
  pluginDir: path.join(HOME, '.openclaw/npm/projects/weixin-plugin/node_modules/@tencent-weixin/openclaw-weixin/dist/src'),
  realBase: '',
  cdnBase: 'https://novac2c.cdn.weixin.qq.com/c2c',
  ollamaUrl: 'http://127.0.0.1:11434',
  localModel: 'huihui-q3:latest',
  localTimeoutMs: 180000,
  dshBin: '/usr/local/bin/dsh',
  dshCwd: path.join(HOME, 'dsh-work'),
  fallbackPatch: path.join(HOME, '.dsh/profiles/headless/fallback-deepseek.yml'),
  dshTimeoutMs: 3600000,
  dshIdleMs: 720000,
  dshWarnMs: 2700000,
  goCooldownMs: 3600000,
  slowNoticeMs: 20000,
  dshContextBudget: 45000,
  handoffMinMsgs: 3,
  handoffTimeoutMs: 300000,
  handoffMaxChars: 6000,
  handoffIdleMs: 3 * 3600 * 1000,
  handoffWarnPct: 0.8,
  handoffSwitchPct: 1.0,
  dayBoundaryHour: 4,
  recallIndexChars: 6000,
  recallKeywords: '',
  progressFirstMs: 45000,
  progressEveryMs: 240000,
  progressGapMs: 45000,
  progressMax: 10,
  steerMergeMs: 12000,
  steerMax: 3,
  mailboxPollMs: 15000,
  managerMode: true,
  threadRouter: true,
  threadRouterShadow: false,
  threadTh: {},
  dashboardUrl: 'http://127.0.0.1/',
  llm: {
    goBase: 'https://opencode.ai/zen/go/v1',
    deepseekBase: 'https://api.deepseek.com',
    managerModel: 'deepseek-v4.1-flash',
    deepseekModel: 'deepseek-flash',
    judgeModel: 'gpt-6-luna',
  },
  // 功能开关：每个插件一个，false = 不加载（等于把这块功能拔掉）
  features: {
    progress: true, manager: true, topics: true, stop: true, steer: true,
    handoff: true, recall: true, helpers: true, local: true, observe: true, evolve: true,
  },
  evolve: {
    retroHour: 3,            // 每天几点做复盘（在 4 点日切之前）
    autoTune: true,          // L1：数据参数在护栏内自动调
    proposals: true,         // L2：生成改进提案（要主人批准才动代码）
    proposalMinSignals: 3,   // 当天不满意信号少于这个就不花钱请模型写提案
  },
};

// 类型/范围校验：[路径, 类型, 最小, 最大]
const RULES = [
  ['listenPort', 'number', 1, 65535], ['apiPort', 'number', 0, 65535],
  ['dshTimeoutMs', 'number', 1000, 6 * 3600e3], ['dshIdleMs', 'number', 500, 3600e3], ['dshWarnMs', 'number', 500, 6 * 3600e3],
  ['dshContextBudget', 'number', 1000, 2000000], ['handoffWarnPct', 'number', 0.1, 1], ['handoffSwitchPct', 'number', 0.2, 2],
  ['handoffIdleMs', 'number', 60000, 7 * 86400e3], ['progressFirstMs', 'number', 100, 3600e3], ['progressEveryMs', 'number', 100, 3600e3],
  ['progressGapMs', 'number', 0, 3600e3], ['progressMax', 'number', 0, 100], ['steerMergeMs', 'number', 100, 600000],
  ['mailboxPollMs', 'number', 200, 600000], ['dshBin', 'string'], ['dshCwd', 'string'], ['accountFile', 'string'],
];

function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}
function getPath(o, p) { return p.split('.').reduce((x, k) => (x == null ? x : x[k]), o); }

export function validate(c) {
  const errs = [];
  for (const [p, type, min, max] of RULES) {
    const v = getPath(c, p);
    if (v === undefined) continue;
    if (typeof v !== type) { errs.push(p + ' 应该是 ' + type + '，现在是 ' + JSON.stringify(v)); continue; }
    if (type === 'number' && ((min != null && v < min) || (max != null && v > max))) errs.push(p + '=' + v + ' 超出范围 [' + min + ', ' + max + ']');
  }
  if (c.dshWarnMs >= c.dshTimeoutMs) errs.push('dshWarnMs 应该小于 dshTimeoutMs');
  if (!isObj(c.features)) errs.push('features 应该是对象');
  return errs;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(p + ' 解析失败：' + e.message); } }

export function loadConfig(file = process.env.AIBOX_CONFIG || path.join(ROOT, 'config.json')) {
  const base = readJson(file);
  let tun = {};
  try { tun = readJson(paths.tunables).values || {}; } catch {}   // 自进化调坏了也不能拖垮启动：读不了就当没有
  const c = merge(merge(DEFAULTS, base), tun);
  c.dshCwd = path.resolve(c.dshCwd);
  c._file = file;
  c._tunables = tun;
  return c;
}

export const cfg = loadConfig();
