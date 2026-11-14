/**
 * Bash tool handler.
 *
 * Executes shell commands using `child_process.spawn`. Output is governed by
 * TWO decoupled thresholds (see `_output-cap.ts`): the accumulator is bounded
 * at HARD_CAP_BYTES (8MB) with a mid-stream SIGKILL only when combined
 * stdout+stderr cross it — a genuine-runaway circuit-breaker that keeps a
 * single JS string under V8's ~512MB limit — while the model-facing view is
 * reduced to head+tail at MODEL_CAP_BYTES (100KB). Legitimate verbose commands
 * (test runs, builds, large diffs) therefore run to completion, so the real
 * exit code and the output tail (where summaries live) survive. Respects
 * timeout and signal-based cancellation. Strips ANSI escape sequences.
 *
 * @module agent/tools/handlers/bash
 */

import os from 'os';
import { beginBashCheckpoint } from '../../file-checkpoint/bash-checkpoint.js';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { appendRoutingDecision } from '../../routing-telemetry.js';
import { wouldBeRestricted } from './_cwd-utils.js';
import { scanCandidatePaths } from './bash-scan-exempt.js';
import { killBashProcess } from './bash-kill.js';
import { RollingTailBuffer } from './_rolling-tail.js';
import { interruptedBashResult } from './bash-interrupted.js';
import { applyBashDetach, execOnDetach } from '../detach-bash.js';
import type { OnDetachParams } from '../detach-bash.js';
import { startBackgroundBash } from './bash.background.js';
import { MAX_PROCESS_MAX_RUNTIME_MS } from '../../shell-jobs/process-jobs.js';
import { spawnBashProcess } from './bash.spawn.js';
import { attachStreamHandlers } from './bash.overflow.js';
import type { OverflowState } from './bash.overflow.js';
import { handleClose } from './bash.close.js';
import { attachErrorHandler } from './bash.error.js';
import { capForModel } from './_output-cap.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';

/**
 * Input shape for the bash tool (validated at runtime).
 */
interface BashInput {
  command?: unknown;
  timeout_ms?: unknown;
  run_in_background?: unknown;
}

/**
 * Validate and parse bash tool input.
 * @throws if `command` is not a string
 */
function parseBashInput(input: unknown): {
  command: string;
  timeout_ms: number;
  background: boolean;
  explicitTimeout: boolean;
  clampedTimeoutWarning: string | undefined;
} {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Input must be an object');
  }

  const bashInput = input as BashInput;

  if (typeof bashInput.command !== 'string') {
    throw new Error('Input must have a "command" field of type string');
  }

  if (bashInput.run_in_background !== undefined && typeof bashInput.run_in_background !== 'boolean') {
    throw new Error('run_in_background must be a boolean');
  }
  const background = bashInput.run_in_background === true;
  // Background runs use timeout_ms as their max runtime, so the ceiling is
  // the process-job maximum (24 h) instead of the foreground 10 minutes.
  const maxTimeout = background ? MAX_PROCESS_MAX_RUNTIME_MS : 600000;

  let timeout_ms = 120000; // default 2 minutes
  let clampedTimeoutWarning: string | undefined;
  if (bashInput.timeout_ms !== undefined) {
    if (
      typeof bashInput.timeout_ms !== 'number' ||
      Number.isNaN(bashInput.timeout_ms)
    ) {
      throw new Error('timeout_ms must be a number');
    }
    if (bashInput.timeout_ms < 0) {
      throw new Error(`timeout_ms must be >= 0 (values above ${maxTimeout} are clamped)`);
    }
    if (bashInput.timeout_ms > maxTimeout) {
      // Clamp over-max values to the ceiling rather than rejecting — the model
      // asked for a long timeout; honouring the maximum intent is more useful
      // than hard-failing the call with a validation error.
      clampedTimeoutWarning = `timeout_ms ${bashInput.timeout_ms} exceeds the maximum (${maxTimeout}); clamped to ${maxTimeout}.`;
      timeout_ms = maxTimeout;
    } else {
      timeout_ms = bashInput.timeout_ms;
    }
  }
  // NOTE: this guard is logically unreachable after a background clamp.
  // When background===true, maxTimeout===MAX_PROCESS_MAX_RUNTIME_MS (86400000 ms).
  // Any timeout_ms > maxTimeout is clamped TO maxTimeout (≥1000), and any
  // timeout_ms ≤ maxTimeout that is also < 1000 would have to be a small
  // positive value (1–999). That path is still guarded here defensively, but
  // the clamp branch above (line 87) can never produce a sub-1000 value.
  if (background && bashInput.timeout_ms !== undefined && timeout_ms < 1000) {
    throw new Error('timeout_ms must be at least 1000 with run_in_background');
  }
  // Emit telemetry AFTER the min-1000 guard so the event is only recorded
  // when the input is fully validated and the clamped value is final.
  // Previously emitted before the guard, creating an implicit ordering
  // dependency (advisory finding from PR #4022 review).
  if (clampedTimeoutWarning) {
    void appendRoutingDecision({
      event: 'tool.bash_timeout_clamped',
      tool: 'bash',
      mode: background ? 'background' : 'foreground',
    });
  }

  return {
    command: bashInput.command,
    timeout_ms,
    background,
    explicitTimeout: bashInput.timeout_ms !== undefined,
    clampedTimeoutWarning,
  };
}

/**
 * Live rolling tail buffer for the TUI, or undefined when the context has no
 * `onBashOutputTail` callback. The callback must not throw; it is guarded
 * defensively anyway so a renderer bug can never fail the command.
 */
function makeTailBuffer(context: ToolHandlerContext | undefined): RollingTailBuffer | undefined {
  const report = context?.onBashOutputTail;
  if (report === undefined) return undefined;
  return new RollingTailBuffer((tail) => {
    try {
      report(tail);
    } catch {
      // Contract: callback must not throw, but we swallow defensively.
    }
  });
}

/**
 * Format a clamped-timeout warning into a tool result.
 *
 * For **background** results (JSON-parseable payload from `startBackgroundBash`),
 * embeds the warning as a `warning` field inside the JSON so `JSON.parse` on the
 * content after the `\n\n` separator still produces a valid object.
 *
 * For **foreground** results, checks whether the content is a detach placeholder
 * (JSON with `status === 'detached'`). If so, embeds the warning inside that JSON.
 * Otherwise, prepends the warning as a string prefix (the existing behavior).
 *
 * Contract: returns a `{ content: string; isError?: boolean }` object. The
 * `content` field is always a valid JSON string when the input was JSON, and
 * always contains `[Warning]` when `clampedTimeoutWarning` is non-empty.
 */
function formatClampedWarningResult(
  result: { content: string; isError?: boolean },
  clampedTimeoutWarning: string,
  /** When true, treats JSON with status==='detached' specially (foreground path). */
  isForegroundPath: boolean,
): { content: string; isError?: boolean } {
  // Try to parse the result as JSON — if it parses, embed the warning inside.
  try {
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    // For the foreground path, only embed if it's a detach placeholder.
    if (isForegroundPath && parsed['status'] !== 'detached') {
      // Not a detach placeholder — fall through to string-prefix below.
    } else {
      parsed['warning'] = clampedTimeoutWarning;
      return { ...result, content: `[Warning] ${clampedTimeoutWarning}\n\n${JSON.stringify(parsed, null, 2)}` };
    }
  } catch {
    /* Not JSON — fall through to string-prefix below. */
  }
  // String-prefix fallback (existing behavior).
  return { ...result, content: `[Warning] ${clampedTimeoutWarning}\n\n${result.content}` };
}

/**
 * Create a bash handler closed over the session's `_permissionMode` and
 * optional working directory. The mode parameter is unused by the handler
 * body (bypass/default differ only via hooks and `context.allowAll`); it is
 * kept in the signature so callers stay positionally stable and mode-specific
 * behaviour can be reintroduced without touching every call site.
 *
 * Using a factory (rather than reading `process.env`) eliminates the
 * process-global race when multiple concurrent sessions run in the same
 * process with different permission modes — each session captures its own
 * mode at handler-registration time.
 *
 * The `cwd` parameter scopes every spawned shell to the session's working
 * directory (typically a `.afk-worktrees/<slug>/` worktree created by
 * `afk interactive -w`). Without this, `spawn` inherits `process.cwd()`
 * of the Node host, which is shared across concurrent sessions — causing
 * sibling sessions to mutate (`git stash`, `git checkout`, etc.) each
 * other's working trees. The Node process's `process.cwd()` is never
 * mutated; only the spawned child's cwd is set.
 *
 * Security note: commands are passed to the OS shell via `shell: true`.
 * This means shell metacharacters (pipes, redirects, subshell expansions)
 * are interpreted. When the session runs in `bypassPermissions` mode (the
 * CLI default, see `DEFAULT_CLI_PERMISSION_MODE`) the agent can execute
 * arbitrary shell commands without confirmation. That is the documented
 * contract of bypass mode, so no per-session warning is emitted. Switching
 * to `execFile` would NOT narrow this: agent commands need pipes/redirects,
 * so any execFile form still ends up as `sh -c <command>`. Real containment
 * would need an OS sandbox; see `docs/scoping/bash-execfile-migration.md`.
 *
 * Path containment (advisory-only): unlike the typed filesystem handlers,
 * which route every path through `resolveAndContain` and hard-reject writes
 * outside `writeRoots`, bash cannot reliably know which paths a `shell: true`
 * command will touch — the command string is opaque. So instead of blocking,
 * the handler runs a BEST-EFFORT scan before spawning: it extracts absolute
 * and home-relative path tokens (`extractCandidatePaths`) and checks each
 * against the session's write roots (`wouldBeRestricted`, `mode: 'write'`).
 * If any references a path outside the roots it emits a ONE-TIME advisory
 * `console.warn` plus a `tool.bash_path_escape` telemetry row, then spawns
 * normally — it never refuses execution. Refusing would break the primary
 * human-driven `afk -w` worktree flow (a top-level bypass session legitimately
 * carries a non-empty `writeRoots`), and `wouldBeRestricted` already returns
 * not-restricted under `allowAll`, so bypass sessions produce no noise. Device
 * sinks (`/dev/null`, `/dev/stderr`, …) and shared scratch dirs (`/tmp`,
 * `os.tmpdir()`) are skipped (`bash-scan-exempt.ts`). The
 * scan is deliberately not a shell parser: it does not catch `$()`, env-var
 * indirection, backticks, or globs. Rationale and the accepted threat model
 * are documented in `docs/decisions/0001-bash-tool-path-containment.md`.
 */
export function createBashHandler(
  _permissionMode: string,
  cwd?: string,
): ToolHandler {
  let _pathEscapeWarned = false;

  /**
   * Best-effort, ADVISORY-ONLY containment scan (never blocks execution).
   *
   * Extracts absolute / home-relative path tokens from the raw command and
   * checks each against the session's WRITE roots — the stricter, most
   * relevant boundary for the "escape the worktree" threat, and in practice
   * `readRoots ⊇ writeRoots` for confined forks. Home-relative tokens are
   * expanded to `os.homedir()` first so `wouldBeRestricted` (which anchors
   * non-absolute inputs to `resolveBase`) sees a true absolute path.
   *
   * On the first out-of-root reference (per handler instance) it emits one
   * `console.warn` naming the escaping resolved paths and one
   * `tool.bash_path_escape` telemetry row (counts + mode only — never the raw
   * command string; audit §G.4). Then it returns and the caller spawns as
   * normal. `wouldBeRestricted` short-circuits to not-restricted under
   * `allowAll` (bypass) and when no `resolveBase` is set (unconfined session),
   * so those sessions naturally produce zero warnings — intended, not
   * special-cased here. Candidates come from `scanCandidatePaths`, which
   * expands `~` and drops benign sinks/scratch dirs so they cannot consume
   * the one-time latch.
   */
  function scanPathsBestEffort(command: string, context: ToolHandlerContext): void {
    if (_pathEscapeWarned) return; // one-time per handler instance
    const fallbackBase = context.resolveBase ?? cwd;
    const escaping: string[] = [];
    for (const expanded of scanCandidatePaths(command, os.homedir())) {
      // Shared actor-root policy only: keep this advisory floor-free and never-blocking.
      const verdict = wouldBeRestricted(expanded, context, 'write', fallbackBase);
      if (verdict.restricted) escaping.push(verdict.resolved);
    }
    if (escaping.length === 0) return;
    _pathEscapeWarned = true;
    // Telemetry: counts + mode only. The raw command string and the escaping
    // paths list are tool input and stay out of the JSONL (audit §G.4) — same
    // privacy rule as the overflow-kill path above.
    void appendRoutingDecision({
      event: 'tool.bash_path_escape',
      tool: 'bash',
      restricted_count: escaping.length,
      mode: 'write',
    });
  }

  return async (input: unknown, signal: AbortSignal, context?: ToolHandlerContext) => {
    let { command, timeout_ms, background, explicitTimeout, clampedTimeoutWarning } = parseBashInput(input);

    const checkpoint = context?.fileCheckpoint ? await beginBashCheckpoint(context.fileCheckpoint, cwd ?? context.resolveBase ?? process.cwd(),
      signal.aborted ? 'aborted before spawn' : background ? 'run_in_background' : undefined, signal) : undefined;
    if (signal.aborted) {
      await checkpoint?.finish('aborted before spawn');
      return { content: 'Command aborted', isError: true };
    }

    // Advisory-only containment scan (warn + telemetry, never blocks). Only
    // runs when a context is present — inline/back-compat calls without one
    // have no roots to check against. Wrapped in try/catch so a scan-internal
    // throw (e.g. os.homedir() failing) can never invert the "never blocks"
    // guarantee: an advisory failure must not stop the command from spawning.
    if (context !== undefined) {
      try {
        scanPathsBestEffort(command, context);
      } catch {
        /* advisory-only — swallow and spawn regardless */
      }
    }

    // Background launch: supervised by the session's ProcessJobRegistry and
    // returned immediately. timeout_ms is the max runtime (default 2 h).
    if (background) {
      const bgResult = await startBackgroundBash(command, explicitTimeout ? timeout_ms : undefined, context, cwd);
      if (clampedTimeoutWarning) {
        return formatClampedWarningResult(bgResult, clampedTimeoutWarning, false);
      }
      return bgResult;
    }

    const startedAt = Date.now();
    let detachedCapture: Promise<void> | undefined;
    const rawResult = await new Promise<{ content: string; isError?: boolean; truncated?: boolean; capturePath?: string; durationMs?: number; exitCode?: number }>((resolve) => {
      let resolved = false;

      // Live rolling tail buffer — ephemeral TUI chrome only, never model-facing.
      const tailBuffer = makeTailBuffer(context);

      function settle(result: { content: string; isError?: boolean; truncated?: boolean; capturePath?: string; durationMs?: number; exitCode?: number; testResult?: import('./test-runner-detector.js').TestResult }) {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutHandle);
        signal.removeEventListener('abort', abortHandler);
        tailBuffer?.clear();
        resolve(result);
      }

      const proc = spawnBashProcess(command, context, cwd);

      // #1430: Register the spawned PID in the session's PID registry.
      if (context?.spawnedPidRegistry !== undefined && proc.pid !== undefined) {
        context.spawnedPidRegistry.register(proc.pid);
      }

      // Set up timeout — resolve immediately, don't wait for streams.
      // S10: SIGKILL the entire process group to kill shell + descendants.
      const timeoutHandle = setTimeout(() => {
        killBashProcess(proc);
        deregisterOnClose?.();
        settle(interruptedBashResult({ kind: 'timeout', stdout: state.stdout, stderr: state.stderr, startedAt, timeoutMs: timeout_ms, context }));
      }, timeout_ms);

      // Shared mutable accumulator for stdout/stderr and overflow state.
      const state: OverflowState = { stdout: '', stderr: '', totalBytes: 0, overflowKilled: false };

      // Fix #2: declared before abortHandler so the closure captures by reference.
      // Assigned inside the applyBashDetach block when a detachRegistry is present.
      //
      // Invariant: assigned synchronously before any event-loop ticks after
      // proc.once / signal.addEventListener fire, so the closure always sees the
      // assigned value when abortHandler or the close handler runs.
      let deregisterOnClose: (() => void) | undefined;

      // Handle abort signal — resolve immediately, don't wait for streams.
      // S10: same process-group SIGKILL rationale as timeout path above.
      const abortHandler = () => {
        killBashProcess(proc);
        deregisterOnClose?.();
        settle(interruptedBashResult({ kind: 'aborted', stdout: state.stdout, stderr: state.stderr, startedAt, timeoutMs: timeout_ms, context }));
      };
      signal.addEventListener('abort', abortHandler);
      // Close the TOCTOU window: an abort that fired between the pre-flight check
      // and addEventListener is replayed here. settle() is idempotent.
      if (signal.aborted) {
        abortHandler();
      }

      // Attach stdout/stderr data handlers (overflow circuit-breaker + tail buffer).
      attachStreamHandlers({
        proc,
        state,
        tailBuffer,
        resolved: () => resolved,
        deregisterOnClose: () => deregisterOnClose,
        settle,
        startedAt,
        command,
      });

      // Detach contract (#2542): when a detachRegistry is present, register
      // this call so Ctrl+B can free the model's turn while the process keeps
      // running. applyBashDetach installs a one-time listener on the token's
      // detachSignal. When it fires, execOnDetach() handles fixes #1/#2/#3.
      if (context?.detachRegistry !== undefined && context.toolUseId !== undefined && !resolved) {
        const toolUseId = context.toolUseId;
        deregisterOnClose = () => context.detachRegistry!.deregister(toolUseId);
        const resolvedRef = { value: resolved };
        const deregisterOnCloseRef = { value: deregisterOnClose };
        const detachParams: OnDetachParams = {
          resolvedRef,
          timeoutHandle,
          signal,
          abortHandler,
          deregisterOnCloseRef,
          clearTail: tailBuffer !== undefined ? () => tailBuffer.clear() : undefined,
          getOutput: () => {
            const combined = stripEscapeSequences((state.stdout + state.stderr).trimEnd());
            return capForModel(combined).content;
          },
          proc,
          startedAt,
          resolve,
        };
        applyBashDetach(context.detachRegistry, toolUseId, command, (token, label) => {
          // Invariant: start the final snapshot at detach, not eventual close.
          detachedCapture = checkpoint?.finish('detached; later changes are not captured');
          execOnDetach(token, label, toolUseId, detachParams);
          resolved = resolvedRef.value;
          deregisterOnClose = deregisterOnCloseRef.value;
        });
      }

      // Normal completion — `close` fires after all stdio streams drain.
      proc.on('close', (code) => {
        handleClose({ code, state, signal, context, startedAt, timeout_ms, deregisterOnClose, settle });
      });

      attachErrorHandler({ proc, context, cwd, startedAt, settle });
    }).finally(async () => { await (detachedCapture ?? checkpoint?.finish()); });
    if (clampedTimeoutWarning) {
      return formatClampedWarningResult(rawResult, clampedTimeoutWarning, true);
    }
    return rawResult;
  };
}

/**
 * Default bash handler using the `'default'` permission mode.
 * Retained for backward compatibility with code that imports `bashHandler`
 * directly (e.g. unit tests, external plugins). Production sessions should
 * use {@link createBashHandler} with the session's actual permission mode.
 */
export const bashHandler: ToolHandler = createBashHandler('default');
