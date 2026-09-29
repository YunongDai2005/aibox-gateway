/**
 * 回放测试台：在临时目录里搭一整套假环境，把网关当黑盒跑。
 *
 *   假 iLink（网关的上游）   消息从这里"推"给网关，网关过滤后把剩下的还给"OpenClaw 插件"（也就是测试本身）
 *   假微信插件               网关发出去的文字/文件记到 sent.jsonl
 *   假 DSH                  test/fakes/dsh.mjs，行为由消息里的 #指令 控制，每次调用记到 dsh.jsonl
 *   假模型服务               经理、话题裁判、复盘提案都打到这里，规则可在场景里改
 *
 * 同一个场景可以分别跑 v2（src/main.mjs）和 v1（老 proxy.mjs，路径改写后原样运行），对比行为。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep the test runner and gateway children on the same calendar day.
process.env.TZ ||= 'UTC';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, '..');
const V1_SRC = process.env.V1_SRC || APP_DIR;   // 老代码（proxy.mjs 等）就在仓库根目录，原样保留用于回滚
const PLUGIN_REL = '.openclaw/npm/projects/weixin-plugin/node_modules/@tencent-weixin/openclaw-weixin/dist/src';
export const OWNER = 'wxid_owner';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJsonl = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const cp = (a, b) => { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.copyFileSync(a, b); };
function cpDir(a, b) { fs.mkdirSync(b, { recursive: true }); for (const f of fs.readdirSync(a)) { const s = path.join(a, f), t = path.join(b, f); fs.statSync(s).isDirectory() ? cpDir(s, t) : fs.copyFileSync(s, t); } }
let portSeq = 0;
function freePort() {
  return new Promise((res) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

// ---------- 假模型服务 ----------
export function defaultLlmRules() {
  return {
    manager(text) {
      if (/不对|方向错|重新/.test(text)) return { reply: '好，我让它按新要求改。', action: 'redo', to_worker: text };
      if (/^停|别做了/.test(text)) return { reply: '好，停下。', action: 'stop', to_worker: '' };
      if (/另外|还有件事/.test(text)) return { reply: '记下了，它做完这个再做。', action: 'queue', to_worker: text };
      if (/怎么样|到哪了|进度/.test(text)) return { reply: '它还在做，第几步了。', action: 'none', to_worker: '' };
      return { reply: '好，我转告它。', action: 'note', to_worker: text };
    },
    judge(prompt) { return prompt.includes('"same"') ? { same: true, sure: 0.9, why: 'test' } : { why: 'test', pivot: false, pick: 'C', sure: 0.9 }; },
    proposals() { return { proposals: [{ title: '测试提案：减少误判', problem: '昨天切错了 3 次', change: '在 topics 插件里调整', kind: 'code', risk: '低', verify: '跑回放测试', expected: '切错变少' }] }; },
  };
}
function startLlm(rules, calls) {
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    let j = {}; try { j = JSON.parse(body); } catch {}
    const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/chat/completions')) {
      const msgs = j.messages || [];
      const sys = (msgs[0] && msgs[0].content) || '';
      const last = String((msgs.at(-1) || {}).content || '');
      let out;
      if (sys.includes('你是主人的「经理」')) { const said = (last.match(/【主人说】([\s\S]*)$/) || [])[1] || last; out = await rules.manager(said.trim(), { sys, last }); calls.push({ kind: 'manager', said: said.trim(), out }); }
      else { out = rules.judge(last); calls.push({ kind: 'judge-fast', out }); }
      if (out === 'ERROR') { res.writeHead(500); res.end('{}'); return; }
      return send({ choices: [{ message: { content: JSON.stringify(out) } }] });
    }
    if (req.url.endsWith('/responses')) {
      const input = String(j.input || '');
      const out = input.includes('自进化复盘员') ? rules.proposals(input) : rules.judge(input);
      calls.push({ kind: input.includes('自进化复盘员') ? 'proposals' : 'judge-2nd', out });
      return send({ output_text: JSON.stringify(out) });
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// ---------- 假 iLink ----------
function startIlink(queue, seen) {
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    seen.push({ url: req.url, method: req.method });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('getupdates')) res.end(JSON.stringify({ ret: 0, msgs: queue.splice(0), get_updates_buf: 'x' }));
    else res.end(JSON.stringify({ ret: 0 }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/**
 * 起一套环境。opts:
 *   engine    'v2' | 'v1'
 *   config    覆盖 config.json 的项
 *   setup(env)  网关启动前改文件（预置会话、交接目录、外援任务…）
 */
export async function startEnv({ engine = 'v2', config = {}, setup, llmRules } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibox-gw-'));
  const home = path.join(tmp, 'home');
  const root = path.join(home, 'wx-router');
  const files = { sent: path.join(tmp, 'sent.jsonl'), dsh: path.join(tmp, 'dsh.jsonl'), lost: path.join(tmp, 'lost.txt') };
  for (const d of [root, path.join(home, 'bin'), path.join(home, '.aibox/logs'), path.join(home, 'dsh-work/handoffs'), path.join(home, '.dsh')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(files.sent, ''); fs.writeFileSync(files.dsh, ''); fs.writeFileSync(files.lost, '');
  fs.writeFileSync(path.join(home, '.dsh/.credentials.yaml'), 'OPENCODE_GO_API_KEY: test-go\nDEEPSEEK_API_KEY: test-ds\n');
  cpDir(path.join(HERE, 'fakes/plugin'), path.join(home, PLUGIN_REL));
  fs.writeFileSync(path.join(home, 'bin/handoff-store.mjs'), fs.readFileSync(path.join(HERE, 'fixtures/handoff-store.mjs'), 'utf8').split('/home/aibox').join(home));   // 绝不碰真实的交接目录

  const rules = { ...defaultLlmRules(), ...(llmRules || {}) };
  const llmCalls = [], queue = [], ilinkSeen = [];
  const llm = await startLlm(rules, llmCalls);
  const ilink = await startIlink(queue, ilinkSeen);
  const llmBase = 'http://127.0.0.1:' + llm.address().port;
  const port = await freePort(), apiPort = await freePort();
  const acctFile = path.join(home, '.openclaw/openclaw-weixin/accounts/test.json');
  fs.mkdirSync(path.dirname(acctFile), { recursive: true });
  fs.writeFileSync(acctFile, JSON.stringify({ baseUrl: 'http://127.0.0.1:' + ilink.address().port, token: 'test-token' }));
  const dshBin = path.join(HERE, 'fakes/dsh.mjs');
  fs.chmodSync(dshBin, 0o755);
  const cfg = {
    engine, listenHost: '127.0.0.1', listenPort: port, apiHost: '127.0.0.1', apiPort,
    accountFile: acctFile, realBase: 'http://127.0.0.1:' + ilink.address().port,
    pluginDir: path.join(home, PLUGIN_REL), dshBin, dshCwd: path.join(home, 'dsh-work'), fallbackPatch: '/fake/fallback-deepseek.yml',
    dshTimeoutMs: 120000, dshIdleMs: 60000, dshWarnMs: 90000, dshContextBudget: 160000, handoffWarnPct: 0.85, handoffIdleMs: 8 * 3600e3,
    progressFirstMs: 600000, progressEveryMs: 600000, progressGapMs: 1000, slowNoticeMs: 600000,
    managerMode: true, mailboxPollMs: 500, steerMergeMs: 800, dashboardUrl: 'http://aibox.test/',
    llm: { goBase: llmBase, deepseekBase: llmBase }, evolve: { retroHour: 99 },
    threadTh: { switchSure: 0.75, switchSureNoLex: 0.8, newSure: 0.75, newMaxCurLex: 1.01, newMinLen: 4, judgeIfCurBelow: 1.01, judgeIfOtherAbove: 0.1, cooldownBonus: 0.05 },
    ...config,
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2));

  let entry;
  if (engine === 'v1') {
    // 老代码：把写死的 /home/aibox 和模型地址改写到临时环境，其余一字不动
    const rw = (s) => s.split('/home/aibox').join(home).split('https://opencode.ai/zen/go/v1').join(llmBase).split('https://api.deepseek.com').join(llmBase);
    for (const f of ['proxy.mjs', 'live.mjs', 'threads.mjs', 'manager.mjs', 'topic-tools.mjs', 'topic-split.mjs']) fs.writeFileSync(path.join(root, f), rw(fs.readFileSync(path.join(V1_SRC, f), 'utf8')));
    for (const f of ['stop-rules.mjs', 'steer-rules.mjs']) fs.writeFileSync(path.join(home, 'bin', f), rw(fs.readFileSync(path.join(APP_DIR, 'src/vendor', f), 'utf8')));
    entry = path.join(root, 'proxy.mjs');
  } else entry = path.join(APP_DIR, 'boot.mjs');

  const env = {
    tmp, home, root, files, port, apiPort, cfg, engine, llmCalls, ilinkSeen, rules,
    proc: null, stderr: '', msgSeq: 0,
    file: (rel) => path.join(home, rel),
    readJson(rel, d = null) { try { return JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8')); } catch { return d; } },
    writeJson(rel, o) { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2)); },
    sent: () => readJsonl(files.sent),
    texts: () => readJsonl(files.sent).filter((x) => x.kind === 'text').map((x) => x.text),
    dshCalls: () => readJsonl(files.dsh),
    log: () => { try { return fs.readFileSync(path.join(root, 'router.log'), 'utf8'); } catch { return ''; } },
    events: () => readJsonl(path.join(home, '.aibox/logs/events.jsonl')),
    msg(text, extra = {}) {
      const id = 'm' + (++env.msgSeq) + '-' + Date.now();
      const items = [];
      if (text != null) items.push({ type: 1, text_item: { text } });
      if (extra.voice) items.push({ type: 3, voice_item: { text: extra.voice } });
      if (extra.image) items.push({ type: 2, image_item: { media: { encrypt_query_param: 'q' } } });
      return { message_id: extra.id || id, from_user_id: extra.from || OWNER, context_token: 'ctx-' + id, item_list: items, ...(extra.raw || {}) };
    },
    // 推一批消息给网关，并像 OpenClaw 插件一样拉一次 getupdates，返回被放行给 OpenClaw 的消息
    async push(...msgs) {
      queue.push(...msgs);
      const r = await fetch('http://127.0.0.1:' + port + '/ilink/bot/getupdates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const j = await r.json();
      return j.msgs || [];
    },
    async say(text, extra) { return env.push(env.msg(text, extra)); },
    async waitFor(fn, { timeout = 8000, what = '条件' } = {}) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await sleep(40); }
      throw new Error('等不到：' + what + '（' + timeout + 'ms）');
    },
    waitText(re, o = {}) { return env.waitFor(() => env.texts().find((t) => (re instanceof RegExp ? re.test(t) : t.includes(re))), { what: '回复 ' + re, ...o }); },
    waitCalls(n, o = {}) { return env.waitFor(() => env.dshCalls().length >= n && env.dshCalls(), { what: 'DSH 被调用 ' + n + ' 次', ...o }); },
    async idle(o = {}) {   // 等所有 DSH 进程结束、网关把回复发完
      await env.waitFor(async () => {
        const live = env.readJson('wx-router/dsh-live.json', { running: [] });
        return !(live.running || []).length;
      }, { what: '工人空闲', ...o });
      await sleep(150);
    },
    api: async (name) => (await fetch('http://127.0.0.1:' + apiPort + '/api/v2/' + name)).json(),
    async stop() {
      if (env.proc && env.proc.exitCode == null) { env.proc.kill('SIGTERM'); await sleep(100); }
      llm.close(); ilink.close();
      try { process.kill(-env.proc.pid, 'SIGKILL'); } catch {}
    },
    cleanup() { if (!process.env.KEEP_TMP) fs.rmSync(tmp, { recursive: true, force: true }); },
  };
  if (setup) await setup(env);
  env.proc = spawn(process.execPath, [entry], {
    cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AIBOX_HOME: home, AIBOX_ROOT: root, AIBOX_CONFIG: path.join(root, 'config.json'), FAKE_SENT: files.sent, FAKE_DSH_LOG: files.dsh, FAKE_LOST: files.lost, HELPER_NO_NOTIFY: '1', HANDOFF_DIR: path.join(home, 'dsh-work/handoffs'), TZ: process.env.TZ },
  });
  env.proc.stderr.on('data', (d) => { env.stderr += d; });
  env.proc.stdout.on('data', (d) => { env.stderr += d; });
  // 等端口起来
  await env.waitFor(async () => { if (env.proc.exitCode != null) throw new Error('网关启动失败，退出码 ' + env.proc.exitCode); try { await fetch('http://127.0.0.1:' + port + '/healthz'); return true; } catch { return false; } }, { timeout: 8000, what: '网关启动' }).catch((e) => { throw new Error(e.message + '\n' + env.stderr + '\n' + env.log()); });
  return env;
}
