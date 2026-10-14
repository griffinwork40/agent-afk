/**
 * Bash-specific detach helpers for the Ctrl+B contract (#2542).
 *
 * Extracted from `handlers/bash.ts` to keep that file under the 350-line
 * ceiling. The bash handler calls {@link applyBashDetach} when the
 * `detachRegistry` is present in the handler context, enabling Ctrl+B to free
 * the model's turn while keeping the shell process running.
 *
 * Flow:
 *   1. After spawning the process but before waiting on its output, the handler
 *      calls `applyBashDetach(...)`. That function:
 *       a. Registers the call with the detach registry (returns a token).
 *       b. Installs a once-listener on `token.detachSignal`.
 *   2. If Ctrl+B fires: the listener calls the provided `onDetach` callback,
 *      which the bash handler defines as a closure over its local state.
 *   3. When the process eventually closes, `onDetach` must wire a separate
 *      `proc.once('close', ...)` for late delivery via `token.deliver()`.
 *   4. The registry emits 'settled'. NOTE: no production subscriber consumes
 *      it yet (#2932), so a detached bash result does not reach the model.
 *      Model-initiated background work uses `bash run_in_background` instead
 *      (see docs/background-processes.md), which does deliver completion.
 *
 * OpenAI-compatible parity (Invariant:D2): both provider loops call
 * `dispatcher.execute()` → `callHandlerContext()` → the same bash handler.
 * The detach contract lives entirely inside the handler and the shared
 * `ToolHandlerContext` — no provider-specific code path is needed.
 *
 * @module agent/tools/detach-bash
 */

import type { DetachableToolRegistry, DetachToken, DetachedToolResult } from './detach-registry.js';
import { debugLog } from '../../utils/debug.js';

/**
 * Milliseconds to wait for `proc.once('close')` after a kill before
 * destroying stdio streams and force-delivering (Fix #2742).
 *
 * On Windows, `taskkill /F /T` may not reach MSYS2 (Git Bash) grandchildren
 * that inherited the stdout/stderr pipes. Those orphans keep the pipe open so
 * Node never sees `close`. Destroying the streams releases the libuv file
 * descriptor, which unblocks the close event (or we deliver immediately and
 * let the orphan die on its own). 5 s is conservative; on POSIX `process.kill
 * (-pid, SIGKILL)` is atomic and close arrives in < 50 ms in practice.
 *
 * NOTE (unverified): on real Windows + Git Bash this path has not been
 * exercised end-to-end. If orphans outlive pipe destroy(), a Windows Job
 * Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE would be the correct fix.
 * Tracked as a follow-up in issue #2742.
 */
export const SETTLE_AFTER_KILL_MS = 5_000;

/**
 * Maximum characters of the command to include in the detach label shown to
 * the user. Keep short — it appears inline in the notification line.
 */
const MAX_LABEL_CHARS = 60;

/**
 * Build the human-readable label for a detached bash call.
 * Collapses whitespace and truncates with an ellipsis.
 */
export function bashDetachLabel(command: string): string {
  const collapsed = command.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_LABEL_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

/**
 * Sentinel value passed as `closeSignal` when the fallback timer fires and
 * we force-deliver without a real Node `close` event. This is NOT a POSIX
 * signal name — it is a diagnostic marker meaning "settled by timeout after
 * pipe-destroy, not by an actual observed kill". Callers that inspect
 * `closeSignal` for routing (e.g. {@link buildBashDelivery}) treat any
 * non-null value as "process did not exit cleanly", which is correct here.
 */
export const BASH_SETTLE_TIMEOUT_SENTINEL = 'SETTLE_TIMEOUT';

/**
 * Build the {@link DetachedToolResult} delivered to the registry's 'settled'
 * notifier once the detached process actually finishes.
 *
 * Fix #3: accepts raw Node close-event args so signal-killed processes are
 * correctly classified as 'failed'. When closeSignal is non-null (e.g.
 * 'SIGKILL' for a real kill, or {@link BASH_SETTLE_TIMEOUT_SENTINEL} for
 * the fallback-timer path), the process did not exit cleanly — status must be
 * 'failed' regardless of closeCode. closeCode=null && closeSignal=null means
 * 'exited normally with no code', which we treat as 'completed'; that
 * combination never occurs for killed processes.
 */
export function buildBashDelivery(
  toolUseId: string,
  label: string,
  output: string,
  closeCode: number | null,
  closeSignal: string | null,
  startedAt: number,
): DetachedToolResult {
  // Contract: signal-killed (closeSignal !== null) → failed; non-zero exit → failed; else completed.
  const status =
    closeSignal !== null || (closeCode !== null && closeCode !== 0) ? 'failed' : 'completed';
  // exitCode field is informational — preserve existing behavior (null → undefined).
  const exitCode = closeCode ?? undefined;
  return { toolUseId, label, status, output, exitCode, durationMs: Date.now() - startedAt };
}

/**
 * Wire the detach contract into an in-flight bash execution.
 *
 * Registers the call with the registry and installs a one-time 'abort'
 * listener on the returned token's `detachSignal`. When the signal fires,
 * `token.notifyDetached()` is called and then `onDetach(token, label)` is
 * invoked so the bash handler (which owns the local process/resolve state)
 * can complete the detach without this helper closing over those variables.
 *
 * The guard `token.shouldDetach()` ensures the callback never fires after
 * the process has already settled normally (idempotent).
 *
 * @returns The registered token (for testing / introspection).
 */
export function applyBashDetach(
  registry: DetachableToolRegistry,
  toolUseId: string,
  command: string,
  onDetach: (token: DetachToken, label: string) => void,
): DetachToken {
  const label = bashDetachLabel(command);
  const token = registry.register(toolUseId);
  token.detachSignal.addEventListener('abort', () => {
    if (!token.shouldDetach()) return; // normal close already settled
    token.notifyDetached();
    onDetach(token, label);
  }, { once: true });
  return token;
}

/**
 * Parameters for {@link execOnDetach} — all mutable state the bash handler
 * exposes to the onDetach callback via explicit refs rather than bare closure
 * variables.
 */
export interface OnDetachParams {
  /** Resolved ref: set to false — onDetach verifies and sets to true. */
  resolvedRef: { value: boolean };
  /** The active timeout handle to clear on detach. */
  timeoutHandle: ReturnType<typeof setTimeout>;
  /** The session's AbortSignal — re-registered post-detach for process kill. */
  signal: AbortSignal;
  /**
   * The abort handler to remove (freeing the turn) and then re-register
   * (keeping the kill path alive until proc exits). Fix #1.
   */
  abortHandler: () => void;
  /**
   * Mutable ref: set to undefined inside onDetach so the normal-close path's
   * deregisterOnClose?.() is a no-op. Fix #2.
   */
  deregisterOnCloseRef: { value: (() => void) | undefined };
  /** Rolling tail buffer to clear on detach (may be undefined). */
  clearTail: (() => void) | undefined;
  /** Getters for stdout+stderr — called lazily on proc close. */
  getOutput: () => string;
  /** The process to register a once('close') listener on. */
  proc: import('child_process').ChildProcess;
  /** Milliseconds epoch when the bash command started (for durationMs). */
  startedAt: number;
  /** The handler's Promise resolve function. */
  resolve: (result: { content: string }) => void;
}

/**
 * Execute the onDetach callback body for a bash handler.
 *
 * Extracted from `createBashHandler` to keep it within the function-size
 * baseline (fix #1 + #2 + #3 together added ~40 lines to that function).
 * Takes all mutable state as explicit ref parameters instead of bare closure
 * variables — preserves testability while reducing `createBashHandler`'s line
 * span.
 */
export function execOnDetach(
  token: DetachToken,
  label: string,
  toolUseId: string,
  p: OnDetachParams,
): void {
  if (p.resolvedRef.value) return; // normal close already settled — skip
  p.resolvedRef.value = true;
  clearTimeout(p.timeoutHandle);
  // Fix #1: remove primary abort listener (frees the turn), then immediately
  // re-register so session abort still kills the process (Invariant:D3).
  p.signal.removeEventListener('abort', p.abortHandler);
  p.signal.addEventListener('abort', p.abortHandler);
  // Fix #2: detach path owns cleanup — null out so normal proc.on('close')
  // deregisterOnClose?.() is a no-op. token.deliver() handles map removal.
  p.deregisterOnCloseRef.value = undefined;
  p.clearTail?.();

  // Fix #2742: idempotent deliver — at most one of close-event or fallback timer wins.
  let deliverSettled = false;
  let fallbackHandle: ReturnType<typeof setTimeout> | undefined;

  function deliverOnce(closeCode: number | null, closeSignal: string | null): void {
    if (deliverSettled) return;
    deliverSettled = true;
    clearTimeout(fallbackHandle);
    // Remove startSettleFallback abort listener — if close fired first, the
    // fallback was never armed and this is a no-op; if the fallback fired first,
    // deliverSettled=true guards re-entry. Either way, stale listener removed.
    p.signal.removeEventListener('abort', startSettleFallback);
    // Fix #1: process exited — clean up the re-registered abort listener.
    p.signal.removeEventListener('abort', p.abortHandler);
    const output = p.getOutput();
    // Fix #3: pass closeSignal so signal-killed → 'failed'.
    token.deliver(buildBashDelivery(toolUseId, label, output, closeCode, closeSignal, p.startedAt));
  }

  p.proc.once('close', deliverOnce);

  // Fix #2742: after a kill (session-abort), settle on a bounded timer if
  // `close` has not arrived. On Windows, `taskkill /F /T` may leave MSYS2
  // grandchildren alive; they hold the inherited stdio pipe so Node never sees
  // `close`. Destroying the streams releases the libuv fd and unblocks it, or
  // we deliver immediately and let the orphan die on its own.
  function startSettleFallback(): void {
    if (deliverSettled) return; // proc already closed before abort fired
    // .unref() so the timer does not hold the event loop open after exit on
    // the Windows orphan path (fix for issue #2932 / bash detach item #2).
    fallbackHandle = setTimeout(() => {
      // Destroy stdio to release the pipe held by surviving grandchildren.
      try { p.proc.stdout?.destroy(); } catch { /* best-effort */ }
      try { p.proc.stderr?.destroy(); } catch { /* best-effort */ }
      // Use sentinel rather than 'SIGKILL' — we have not confirmed a kill;
      // the process may have died of its own accord or the pipe was released
      // by some other means (fix for issue #2932 / bash detach item #3).
      debugLog('[detach-bash] settle fallback fired — close did not arrive within', SETTLE_AFTER_KILL_MS, 'ms');
      deliverOnce(null, BASH_SETTLE_TIMEOUT_SENTINEL);
    }, SETTLE_AFTER_KILL_MS).unref();
  }

  // Start the fallback when the session abort signal fires (which triggers the
  // re-registered abortHandler → killProcessGroup). If the signal is already
  // aborted (edge case: abort raced ahead of execOnDetach), start immediately.
  if (p.signal.aborted) {
    startSettleFallback();
  } else {
    p.signal.addEventListener('abort', startSettleFallback, { once: true });
  }

  p.resolve(token.detachResult(label));
}

/**
 * Set of tool names that opt in to the detach contract.
 * Literal names (not imported constants) keep this a dependency-free leaf;
 * tests pin them against real tool-name constants.
 *
 * Invariant: tools listed here MUST call `applyBashDetach` / `applyComposeDetach`
 * (or equivalent) and implement the full token lifecycle. A tool that registers
 * but never delivers leaks the registry slot until session end / cancelAll().
 *
 * Both 'bash' and 'compose' are detachable. The dispatcher injects
 * `detachRegistry` into bash via `callHandlerContext`; compose receives it
 * directly through `CoreExecDeps.detachRegistry` → `executeCompose()`.
 *
 * Note: `isDetachableTool` (and thus this set's membership check) is only
 * evaluated inside `callHandlerContext`, which is only reached by handler-backed
 * tools. Compose bypasses `callHandlerContext` entirely, so including 'compose'
 * here does not cause it to be injected via that path — compose's detach wiring
 * lives in `coreExecDeps()` unconditionally when `detachRegistry` is set.
 * The set documents the full detachable surface; `isDetachableTool` governs the
 * handler-backed injection path only.
 */
export const DETACHABLE_TOOLS: ReadonlySet<string> = new Set(['bash', 'compose']);

export function isDetachableTool(name: string): boolean {
  return DETACHABLE_TOOLS.has(name);
}

/** Re-export registry type for use in the dispatcher without importing the full module. */
export type { DetachableToolRegistry };
