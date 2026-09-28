/**
 * 可中断运行的登记表（v1「中途插话」的机制原样搬过来）。
 * 每轮 runDsh 领一个不可复用的 runId + generation 租约；stdout/stderr/close/timer 回调全部先校验 isCurrent，
 * 旧轮回调拿不到权限。中断顺序必须是「失效 → 置 stopping → 再发信号」，反过来旧回调会抢先发旧回复。
 */
export const activeRuns = new Map();      // chat -> control { runId, generation, pid, state, kind, interrupt() }
const generations = new Map();            // chat -> 当前有效 generation

export function registerActiveRun(chat, kind) {
  return (control) => {
    control.kind = kind || 'chat';   // 'chat' = 用户任务（可中断）；'handoff' = 收尾交接（不可中断）
    activeRuns.set(chat, control);
    return {
      isCurrent(expectedRunId = control.runId) {
        const a = activeRuns.get(chat);
        return !!a && a === control && a.runId === expectedRunId
          && a.generation === control.generation
          && generations.get(chat) === control.generation;
      },
      ownsRunId(expectedRunId = control.runId) {
        const a = activeRuns.get(chat);
        return !!a && a === control && a.runId === expectedRunId;
      },
      invalidate(expectedRunId = control.runId) {
        if (!this.ownsRunId(expectedRunId)) return false;
        if (generations.get(chat) === control.generation) generations.set(chat, control.generation + 1);
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
export function beginGeneration(chat) { const g = (generations.get(chat) || 0) + 1; generations.set(chat, g); return g; }
export function delay(ms) { return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }); }
export function signalProcessGroup(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(-pid, sig); return true; } catch { return false; }   // 只打本次 spawn 的进程组
}
export async function interruptCurrentRun(chat, expectedRunId) {
  const a = activeRuns.get(chat);
  if (!a) return false;
  if (expectedRunId && a.runId !== expectedRunId) return false;
  return a.interrupt(a.runId);
}
