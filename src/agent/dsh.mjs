/**
 * DSH 执行器：起一个 `dsh --profile headless --json` 进程跑一轮，读它的事件流。
 *   看门狗「卡死才杀」：连续 dshIdleMs 没有任何输出 = 卡死；dshTimeoutMs 是总上限兜底。
 *   线路：OpenCode Go 主力；额度满/故障时叠加 fallback 补丁走 DeepSeek 官方（goCooldownMs 冷却）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { cfg, paths } from '../core/config.mjs';
import { log } from '../core/log.mjs';
import { readJson, writeJson } from '../core/store.mjs';
import { signalProcessGroup, delay } from './runs.mjs';

// ---------- 线路状态 ----------
export function goCooldownUntil() { return readJson(paths.goState, {}).cooldownUntil || 0; }
export function setGoCooldown(ms) { writeJson(paths.goState, { cooldownUntil: Date.now() + ms, at: new Date().toISOString() }); }
export function coolingDown() { return Date.now() < goCooldownUntil(); }
export function routeLabel() {
  const until = goCooldownUntil();
  if (Date.now() < until) return 'DeepSeek 按量（Go 额度冷却到 ' + new Date(until).toTimeString().slice(0, 5) + '）';
  return 'Go 订阅（额度满自动切 DeepSeek）';
}
export function noFinal(r) { return !(r.final && String(r.final).trim()); }
export function isQuotaErr(t) { return /QUOTA|RATE_LIMIT|\b429\b|limit|exceed|insufficient|额度/i.test(t || ''); }
export function isSessionLost(r) { return /does not exist; omit --session-id/.test(r.errTail || ''); }
export function ocSession(chat, sid) { return 'ses_' + crypto.createHash('sha1').update(chat + '|' + (sid || '')).digest('hex').slice(0, 24); }

// 用完一次模型就顺手刷新额度（60 秒内最多一次）
let lastQuotaRefresh = 0;
export function refreshQuota() {
  if (Date.now() - lastQuotaRefresh < 60000) return;
  lastQuotaRefresh = Date.now();
  const script = path.join(paths.bin, 'aibox-quota.mjs');
  if (!fs.existsSync(script)) return;
  try { spawn(process.execPath, [script], { detached: true, stdio: 'ignore' }).unref(); } catch {}
}

/**
 * 跑一轮。opts: { fallback, ocSession, timeoutMs, idleMs, onEvent, generation, register }
 * 返回 { code, signal, killedBy, interrupted, stale, forced, runId, generation, sessionId, final, usage, usagePeak, errTail, fallback }
 * 无论怎样结束都会 resolve（否则聊天队列会永久卡住）。
 */
export function runDsh(task, sid, opts = {}) {
  return new Promise((resolve) => {
    const args = ['--profile', 'headless'];                  // 启动器参数（--patch）必须在应用参数之前
    if (opts.fallback) args.push('--patch', cfg.fallbackPatch);
    args.push('--json');
    if (sid) args.push('--session-id', sid);
    args.push('-');
    const child = spawn(cfg.dshBin, args, {
      cwd: cfg.dshCwd,
      env: { ...process.env, DSH_PERMISSION_MODE: 'danger-full-access', OPENCODE_SESSION: opts.ocSession || 'ses_aibox_default' },
      stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    let buf = '', errTail = '', sessionId = sid || null, final = null, usage = 0, usagePeak = 0, errEvents = '';
    const t0 = Date.now(), maxMs = opts.timeoutMs || cfg.dshTimeoutMs, idleMs = opts.idleMs || cfg.dshIdleMs;
    let lastOut = t0, killedBy = null;
    const runId = opts.runId || crypto.randomUUID();
    const generation = opts.generation;
    let settled = false, closed = false, closeCode = null, closeSignal = null, registration = null, timer = null;
    let resolveClosed; const closedPromise = new Promise((r) => { resolveClosed = r; });

    const control = {
      runId, generation, pid: child.pid, state: 'running', startedAt: t0,
      async interrupt(expectedRunId = runId) {
        if (expectedRunId !== runId) return false;
        if (!registration?.isCurrent(runId)) return false;
        if (!registration.invalidate(runId)) return false;      // 先失效（不能先杀）
        control.state = 'stopping'; killedBy = 'interrupt';
        signalProcessGroup(child.pid, 'SIGINT');
        await Promise.race([closedPromise, delay(2000)]);
        if (closed) return true;
        signalProcessGroup(child.pid, 'SIGTERM');
        await Promise.race([closedPromise, delay(3000)]);
        if (closed) return true;
        signalProcessGroup(child.pid, 'SIGKILL');
        finish({ code: null, signal: 'SIGKILL', stale: true, forced: true });
        return true;
      },
    };
    registration = opts.register ? opts.register(control) : {
      isCurrent: (r = runId) => r === runId, ownsRunId: (r = runId) => r === runId,
      invalidate: (r = runId) => r === runId, unregister: () => true,
    };

    function finish({ code = closeCode, signal = closeSignal, stale = false, forced = false } = {}) {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      const interrupted = killedBy === 'interrupt';
      control.state = 'closed';
      if (registration?.ownsRunId(runId)) registration.unregister(runId);
      if (killedBy) log('dsh ended by=' + killedBy + ' after=' + Math.round((Date.now() - t0) / 1000) + 's idle=' + Math.round((Date.now() - lastOut) / 1000) + 's');
      resolve({
        code, signal, killedBy, interrupted, stale, forced, runId, generation,
        sessionId, final, usage, usagePeak, took: Date.now() - t0,
        errTail: (errEvents + ' ' + errTail).trim(), fallback: !!opts.fallback,
      });
    }

    const kill = (why) => { killedBy = why; signalProcessGroup(child.pid, 'SIGKILL') || (() => { try { child.kill('SIGKILL'); } catch {} })(); finish(); };
    timer = setInterval(() => {
      if (settled || !registration.isCurrent(runId)) return;   // 旧 timer 不许误杀新进程
      const now = Date.now();
      if (now - t0 >= maxMs) kill('max');
      else if (now - lastOut >= idleMs) kill('idle');
    }, opts.tickMs || Math.min(5000, Math.max(200, Math.floor(idleMs / 4))));
    child.stdout.on('data', (d) => {
      if (settled || !registration.isCurrent(runId)) return;
      lastOut = Date.now();
      buf += d.toString('utf8');
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (settled || !registration.isCurrent(runId)) return;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (opts.onEvent) { try { opts.onEvent(j); } catch {} }
        if (j.type === 'session' && j.sessionId) sessionId = j.sessionId;
        else if (j.type === 'final') final = j.text;
        else if (j.type === 'status' && j.phase === 'step_end' && j.usage) {
          // 单步输入规模 = 未命中缓存 + 命中缓存（漏掉 cacheRead 会把上下文严重低估）
          const it = (j.usage.inputTokens || 0) + (j.usage.cacheReadTokens || 0) + (j.usage.cacheWriteTokens || 0);
          usage += it;
          if (it > usagePeak) usagePeak = it;
        }
        else if (j.type === 'error' || (j.type === 'status' && j.phase === 'turn_end' && j.reason && j.reason.kind !== 'completed')) errEvents = (errEvents + ' ' + JSON.stringify(j)).slice(-800);
      }
    });
    child.stderr.on('data', (d) => { if (settled || !registration.isCurrent(runId)) return; lastOut = Date.now(); errTail = (errTail + d.toString('utf8')).slice(-600); });
    child.on('error', (e) => { if (settled) return; errTail = (errTail + ' spawn: ' + e.message).slice(-600); });
    child.on('close', (code, signal) => {
      closed = true; closeCode = code; closeSignal = signal; resolveClosed?.();
      finish({ code, signal });
    });
    child.stdin.on('error', (e) => { if (settled || !registration.isCurrent(runId)) return; errTail = (errTail + ' stdin: ' + e.message).slice(-600); });
    child.stdin.end(task);
  });
}
