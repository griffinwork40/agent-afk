/**
 * Bash tool handler.
 *
 * Executes shell commands using `child_process.spawn`. Output is capped at
 * 100KB via TWO independent guards: a mid-stream byte counter that kills the
 * child via SIGKILL as soon as combined stdout+stderr cross the threshold
 * (prevents V8 max-string-length overflow when a command emits hundreds of MB
 * of output before exiting), and a post-close length cap as a safety net.
 * Respects timeout and signal-based cancellation. Strips ANSI escape sequences.
 *
 * @module agent/tools/handlers/bash
 */

import { spawn } from 'child_process';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { appendRoutingDecision } from '../../routing-telemetry.js';
import { detectTestResult } from './test-runner-detector.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { describeSpawnCwdError, isSpawnEnoent } from '../../../utils/spawn-cwd-error.js';

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

    // Mid-stream byte cap. Without this, `stdout += chunk.toString()`
    // / `stderr += chunk.toString()` accumulate unboundedly: a command
    // that emits >~512MB before exiting (`yes | head -c 600MB`,
    // accidental `cat` of a binary, recursive log dump) overflows V8's
    // max string length and throws `RangeError: Invalid string length`
    // synchronously inside this data callback — escaping every try/catch
    // because the throw originates inside Node's Socket.emit →
    // Readable.push chain. The 120s timeout does NOT save us: the crash
    // is byte-driven, not time-driven, and `yes | head -c 600MB`
    // completes well under 120s. The post-close cap does NOT save us
    // either: `close` never fires when the throw aborts the read
    // pipeline. So we count bytes here and kill+settle as soon as the
    // cap is crossed. SIGKILL (not SIGTERM) so the child cannot flush
    // more output during termination.
    //
    // External constraint: V8 max string length (~512MB on x64). The
    // 100KB cap matches the post-close cap so behavior is consistent
    // regardless of which path fires.
    const MAX_OUTPUT_BYTES = 100_000;
    let totalBytes = 0;
    let overflowKilled = false;

    function maybeOverflow(stream: 'stdout' | 'stderr'): void {
      // M3: one-shot latch — concurrent stdout+stderr data events can both
      // push totalBytes past the threshold before the kill takes effect.
      // Check overflowKilled first so only the first caller settles.
      if (overflowKilled) return;
      if (resolved) return;
      if (totalBytes < MAX_OUTPUT_BYTES) return;
      overflowKilled = true;
      // P1: structured log so operators can observe overflow frequency in
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
      let combined = (stdout + stderr).trimEnd();
      combined = stripEscapeSequences(combined);
      // Test-runner detection runs on the truncated buffer (we cannot
      // wait for more data — the child is being killed). If the result
      // marker is in the first ~100KB it will still be picked up; if it
      // is past the cap it is unrecoverable, which is the same boundary
      // as any other 100KB-truncated command.
      const testResult = detectTestResult(combined) ?? undefined;
      // The process was SIGKILL'd because output exceeded the byte cap —
      // we always truncate here. Slice the display string to the byte cap
      // (the primary guard already capped incoming buffers, so this is
      // belt-and-suspenders for the string-layer), then append the sentinel
      // unconditionally so the model sees the in-band signal. The
      // structured `truncated: true` flag below is the parallel signal for
      // non-model consumers (subagent traces, hooks, caller code) — they
      // should not need to substring-scan `content` for the sentinel.
      if (combined.length > MAX_OUTPUT_BYTES) {
        combined = combined.slice(0, MAX_OUTPUT_BYTES);
      }
      combined += '\n[output truncated — exceeded 100KB]';
      settle({ content: combined, truncated: true, ...(testResult !== undefined ? { testResult } : {}) });
    }

    proc.stdout!.on('data', (chunk: Buffer) => {
      // H1 + M1: slice at the Buffer layer BEFORE .toString() so a single
      // oversized chunk (>= MAX_OUTPUT_BYTES) never allocates a full V8
      // string. Remaining budget is computed in bytes (not UTF-16 code
      // units) so truncation always lands on a valid byte boundary.
      const remaining = MAX_OUTPUT_BYTES - totalBytes;
      const safe = chunk.length <= remaining ? chunk : chunk.subarray(0, Math.max(0, remaining));
      totalBytes += safe.length;
      stdout += safe.toString('utf8');
      maybeOverflow('stdout');
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      // H1 + M1: same Buffer-layer guard as stdout handler above.
      const remaining = MAX_OUTPUT_BYTES - totalBytes;
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
        const detail = stderr.trimEnd() || stdout.trimEnd();
        settle({
          content: `Command exited with code ${code}${detail ? '\n' + detail : ''}`,
          isError: true,
        });
        return;
      }

      // Overflow path already settled before the SIGKILL → close
      // round-trip; nothing more to do.
      if (overflowKilled) return;

      let combined = (stdout + stderr).trimEnd();
      combined = stripEscapeSequences(combined);

      // Detect test-runner results BEFORE truncation so patterns near the
      // end of long output are not missed. External constraint: detection
      // runs on the full ANSI-stripped output; the 100KB cap applied below
      // is for model-context cost only — it must not silently hide test
      // summaries from the structured result.
      const testResult = detectTestResult(combined) ?? undefined;

      let truncatedHere = false;
      if (combined.length > MAX_OUTPUT_BYTES) {
        combined = combined.slice(0, MAX_OUTPUT_BYTES) + '\n[output truncated — exceeded 100KB]';
        truncatedHere = true;
      }

      settle({
        content: combined,
        ...(truncatedHere ? { truncated: true } : {}),
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
