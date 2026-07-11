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

import { spawn } from 'child_process';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { appendRoutingDecision } from '../../routing-telemetry.js';
import { detectTestResult } from './test-runner-detector.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { describeSpawnCwdError, isSpawnEnoent } from '../../../utils/spawn-cwd-error.js';
import { HARD_CAP_BYTES, MODEL_CAP_BYTES, headAndTail, capForModel, HARD_CAP_KILL_NOTE } from './_output-cap.js';

/**
 * Input shape for the bash tool (validated at runtime).
 */
interface BashInput {
  command?: unknown;
  timeout_ms?: unknown;
}

/**
 * Validate and parse bash tool input.
 * @throws if `command` is not a string
 */
function parseBashInput(input: unknown): { command: string; timeout_ms: number } {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Input must be an object');
  }

  const bashInput = input as BashInput;

  if (typeof bashInput.command !== 'string') {
    throw new Error('Input must have a "command" field of type string');
  }

  let timeout_ms = 120000; // default 2 minutes
  if (bashInput.timeout_ms !== undefined) {
    if (typeof bashInput.timeout_ms !== 'number') {
      throw new Error('timeout_ms must be a number');
    }
    if (bashInput.timeout_ms < 0 || bashInput.timeout_ms > 600000) {
      throw new Error('timeout_ms must be between 0 and 600000');
    }
    timeout_ms = bashInput.timeout_ms;
  }

  return {
    command: bashInput.command,
    timeout_ms,
  };
}

/**
 * Create a bash handler closed over the session's `permissionMode` and
 * optional working directory.
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
 * are interpreted. When the session runs in `bypassPermissions` mode the
 * agent can execute arbitrary shell commands without confirmation — a
 * full `execFile`-based refactor that disables the shell is tracked as a
 * separate work item. For now we emit a one-time warning at startup so the
 * risk surface is explicit in logs.
 */
export function createBashHandler(
  permissionMode: string,
  cwd?: string,
): ToolHandler {
  let _shellModeWarned = false;

  function warnIfBypassPermissions(): void {
    if (_shellModeWarned) return;
    if (permissionMode === 'bypassPermissions') {
      _shellModeWarned = true;
      console.warn(
        '[security] bash handler: shell=true with bypassPermissions — ' +
          'all shell metacharacters are interpreted without confirmation. ' +
          'Migrate to execFile to eliminate this risk (tracked: C4).',
      );
    }
  }

  return async (input: unknown, signal: AbortSignal, context?: ToolHandlerContext) => {
    let { command, timeout_ms } = parseBashInput(input);

    if (signal.aborted) {
      return { content: 'Command aborted', isError: true };
    }

    warnIfBypassPermissions();

  return new Promise((resolve) => {
    let resolved = false;

    function settle(result: { content: string; isError?: boolean; truncated?: boolean; testResult?: import('./test-runner-detector.js').TestResult }) {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', abortHandler);
      resolve(result);
    }

    // Spawn the process. `cwd` is the session's working directory (e.g.
    // an `afk interactive -w` worktree). Falls back to `process.cwd()`
    // implicitly when undefined — spawn treats `cwd: undefined` as inherit.
    //
    // `env`: spawn inherits `process.env` only when `env` is undefined.
    // When `context.env` is set, we explicitly construct the child env as
    // `{ ...process.env, ...context.env }` so the caller's overrides win
    // on collision. This is the path `executePluginSkill` uses to inject
    // `PLUGIN_ROOT=<plugin.path>` for plugin-skill subagents — see
    // `ToolHandlerContext.env` for the per-context (race-safe) rationale.
    const proc = spawn(command, {
      shell: true,
      // detached: true places the shell in its own process group (PGID = proc.pid).
      // Combined with process.kill(-proc.pid, 'SIGKILL') below, this lets us kill
      // the entire group atomically — including backgrounded grandchildren — so no
      // orphan processes leak after a timeout or abort (process-group orphan fix).
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Effective cwd priority:
      // 1. context?.resolveBase — permission-system anchor (from dispatcher)
      // 2. context?.cwd — per-call override (back-compat)
      // 3. factory-level cwd — session worktree isolation (from createBashHandler)
      // Falls back to process.cwd() implicitly when all three are undefined.
      ...((context?.resolveBase ?? context?.cwd ?? cwd) !== undefined
        ? { cwd: context?.resolveBase ?? context?.cwd ?? cwd }
        : {}),
      ...(context?.env !== undefined
        ? { env: { ...process.env, ...context.env } }
        : {}),
    });
    // unref() so Node's event loop doesn't hold open the process handle after
    // detach — belt-and-suspenders alongside detached: true.
    proc.unref();

    // Set up timeout — resolve immediately, don't wait for streams.
    // External constraint: SIGTERM can be caught/ignored by user processes;
    // SIGKILL cannot. Use process.kill(-proc.pid, 'SIGKILL') to send SIGKILL
    // to the entire process group — killing the shell and all its descendants,
    // including backgrounded grandchildren, atomically (S10).
    const timeoutHandle = setTimeout(() => {
      if (proc.pid !== undefined) {
        process.kill(-proc.pid, 'SIGKILL');
      }
      settle({ content: `Command timed out after ${timeout_ms}ms`, isError: true });
    }, timeout_ms);

    let stdout = '';
    let stderr = '';

    // Mid-stream hard cap. Without an accumulator bound, `stdout += ...`
    // / `stderr += ...` grow unboundedly: a command emitting >~512MB before
    // exiting (`yes | head -c 600MB`, accidental `cat` of a binary, recursive
    // log dump) overflows V8's max string length and throws `RangeError:
    // Invalid string length` synchronously inside this data callback —
    // escaping every try/catch because the throw originates inside Node's
    // Socket.emit → Readable.push chain, and neither the 120s timeout (crash
    // is byte-driven) nor the post-close cap (`close` never fires once the
    // throw aborts the read pipeline) can save us. So we bound the string at
    // HARD_CAP_BYTES and SIGKILL only when it is crossed — a genuine-runaway
    // circuit-breaker, NOT a routine truncation. Everyday verbose output stays
    // far below 8MB and runs to completion; only true floods are killed.
    let totalBytes = 0;
    let overflowKilled = false;

    function maybeOverflow(stream: 'stdout' | 'stderr'): void {
      // M3: one-shot latch — concurrent stdout+stderr data events can both
      // push totalBytes past the threshold before the kill takes effect.
      // Check overflowKilled first so only the first caller settles.
      if (overflowKilled) return;
      if (resolved) return;
      if (totalBytes < HARD_CAP_BYTES) return;
      overflowKilled = true;
      // P1: structured log so operators can observe runaway kills in
      // production without grepping for RangeError crash traces.
      console.warn(
        `[bash] overflow kill: stream=${stream} totalBytes=${totalBytes} command="${command}"`,
      );
      // P2: structured JSONL counterpart so the same event is queryable from
      // routing-decisions.jsonl. Fire-and-forget — appendRoutingDecision
      // swallows its own errors so telemetry never blocks the tool result.
      // Privacy: command is a tool input and stays out of telemetry
      // (audit §G.4) — only the operational metrics (tool, total_bytes,
      // stream) are emitted.
      void appendRoutingDecision({
        event: 'tool.overflow_kill',
        tool: 'bash',
        total_bytes: totalBytes,
        stream,
      });
      proc.kill('SIGKILL');
      const combined = stripEscapeSequences((stdout + stderr).trimEnd());
      // Test-runner detection runs on the (up to 8MB) buffer we captured
      // before the kill — the true tail past 8MB is unrecoverable.
      const testResult = detectTestResult(combined) ?? undefined;
      // The child was SIGKILL'd for exceeding the hard cap. Give the model a
      // head+tail view of what we captured plus the kill sentinel; the
      // structured `truncated: true` flag is the parallel signal for non-model
      // consumers (subagent traces, hooks) — they should not substring-scan.
      const content = headAndTail(combined, MODEL_CAP_BYTES) + HARD_CAP_KILL_NOTE;
      settle({ content, truncated: true, ...(testResult !== undefined ? { testResult } : {}) });
    }

    proc.stdout!.on('data', (chunk: Buffer) => {
      // H1 + M1: slice at the Buffer layer BEFORE .toString() so a single
      // oversized chunk (>= HARD_CAP_BYTES) never allocates a full V8
      // string. Remaining budget is computed in bytes (not UTF-16 code
      // units) so truncation always lands on a valid byte boundary.
      const remaining = HARD_CAP_BYTES - totalBytes;
      const safe = chunk.length <= remaining ? chunk : chunk.subarray(0, Math.max(0, remaining));
      totalBytes += safe.length;
      stdout += safe.toString('utf8');
      maybeOverflow('stdout');
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      // H1 + M1: same Buffer-layer guard as stdout handler above.
      const remaining = HARD_CAP_BYTES - totalBytes;
      const safe = chunk.length <= remaining ? chunk : chunk.subarray(0, Math.max(0, remaining));
      totalBytes += safe.length;
      stderr += safe.toString('utf8');
      maybeOverflow('stderr');
    });

    // Handle abort signal — resolve immediately, don't wait for streams.
    // S10: same process-group SIGKILL rationale as timeout path above.
    const abortHandler = () => {
      if (proc.pid !== undefined) {
        process.kill(-proc.pid, 'SIGKILL');
      }
      settle({ content: 'Command aborted', isError: true });
    };
    signal.addEventListener('abort', abortHandler);
    // Close the TOCTOU window between the pre-flight `signal.aborted` check (top
    // of the handler) and this listener registration: an abort that fired in
    // that gap never invokes `abortHandler` (addEventListener does not replay an
    // already-dispatched 'abort' event), so the just-spawned child would run to
    // completion and leak a late result instead of being killed promptly.
    // settle() is idempotent (guards on `resolved`), so re-firing here is safe.
    if (signal.aborted) {
      abortHandler();
    }

    // Normal completion — `close` fires after all stdio streams drain.
    proc.on('close', (code) => {
      // If the process was killed by our abort handler, `settle` already
      // ran (resolved=true) so this call is a no-op. Check anyway so the
      // branch is explicit: abort beats close.
      if (signal.aborted) {
        settle({ content: 'Command aborted', isError: true });
        return;
      }

      if (code !== null && code !== 0) {
        // Non-zero exit: name the failure mode and include collected output.
        // The detail may be up to HARD_CAP_BYTES (8MB) now that the
        // accumulator bound was raised, so cap it to the model budget.
        const capped = capForModel(stderr.trimEnd() || stdout.trimEnd());
        settle({
          content: `Command exited with code ${code}${capped.content ? '\n' + capped.content : ''}`,
          isError: true,
          ...(capped.truncated ? { truncated: true } : {}),
        });
        return;
      }

      // Overflow path already settled before the SIGKILL → close
      // round-trip; nothing more to do.
      if (overflowKilled) return;

      const combined = stripEscapeSequences((stdout + stderr).trimEnd());

      // Detect test-runner results BEFORE truncation so patterns near the
      // end of long output are not missed. External constraint: detection
      // runs on the full ANSI-stripped output (up to 8MB); the model-budget
      // head+tail applied below is for context cost only — it must not
      // silently hide test summaries from the structured result.
      const testResult = detectTestResult(combined) ?? undefined;

      const capped = capForModel(combined);
      settle({
        content: capped.content,
        ...(capped.truncated ? { truncated: true } : {}),
        ...(testResult !== undefined ? { testResult } : {}),
      });
    });

    proc.on('error', (err) => {
      // Spawn ENOENT masquerade: a dead working directory (deleted worktree)
      // surfaces as `spawn /bin/sh ENOENT` — naming the shell, not the dir.
      // Translate post-failure via statSync (error path only — no TOCTOU).
      // When no explicit cwd was passed, spawn inherited the process cwd;
      // process.cwd() itself throws when that directory has been deleted,
      // which is the same masquerade — report it as such.
      const effectiveCwd = context?.resolveBase ?? context?.cwd ?? cwd;
      let message: string;
      if (effectiveCwd === undefined && isSpawnEnoent(err)) {
        try {
          const inherited = process.cwd();
          message = describeSpawnCwdError(err, inherited);
        } catch {
          message = `working directory does not exist (process cwd deleted — deleted worktree?) — underlying: ${err.message}`;
        }
      } else {
        message = describeSpawnCwdError(err, effectiveCwd);
      }
      settle({ content: `Failed to execute: ${message}`, isError: true });
    });
  });
  };
}

/**
 * Default bash handler using the `'default'` permission mode.
 * Retained for backward compatibility with code that imports `bashHandler`
 * directly (e.g. unit tests, external plugins). Production sessions should
 * use {@link createBashHandler} with the session's actual permission mode.
 */
export const bashHandler: ToolHandler = createBashHandler('default');
