/**
 * Grep tool handler.
 *
 * Searches for a pattern in files using bundled ripgrep (`@vscode/ripgrep`'s
 * `rgPath`) with optional include filter. Ripgrep has no basic-regex (BRE)
 * mode: `|` `+` `?` `(` `)` `{` `}` are always regex metacharacters (e.g. a
 * bare `foo|bar` alternates, matching either branch) — a deliberate contract
 * change from the previous system-`grep`-backed implementation, which ran in
 * BRE mode by default and required an `extended` opt-in for alternation.
 * Respects signal-based cancellation. Output is governed by two decoupled
 * thresholds (see `_output-cap.ts`): the accumulator is bounded at
 * HARD_CAP_BYTES (8MB) with a mid-stream SIGKILL only when it is crossed — a
 * genuine-runaway guard against V8 max-string-length overflow — while the
 * model-facing view is reduced to head+tail at MODEL_CAP_BYTES (100KB). A
 * broad-but-legitimate search therefore runs to completion. Strips ANSI escape
 * sequences.
 *
 * @module agent/tools/handlers/grep
 */

import { spawn } from 'child_process';
import { rgPath } from '@vscode/ripgrep';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { appendRoutingDecision } from '../../routing-telemetry.js';
import { resolveAndContain } from './_cwd-utils.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { describeSpawnCwdError, isSpawnEnoent } from '../../../utils/spawn-cwd-error.js';
import { describeRgUnavailable } from './_rg-availability.js';
import { HARD_CAP_BYTES, MODEL_CAP_BYTES, headAndTail, capForModel, HARD_CAP_KILL_NOTE } from './_output-cap.js';

/**
 * Input shape for the grep tool (validated at runtime).
 */
interface GrepInput {
  pattern?: unknown;
  path?: unknown;
  include?: unknown;
}

/**
 * Validate and parse grep tool input.
 * `sessionCwd` is the effective working directory (context.resolveBase,
 * context.cwd, or factory cwd — in priority order); used as the default
 * search path when the model omits one.
 *
 * @throws if `pattern` is not a string or if path is outside allowed roots
 */
function parseGrepInput(
  input: unknown,
  context: ToolHandlerContext | undefined,
  sessionCwd: string | undefined,
): {
  pattern: string;
  path: string;
  include?: string;
} {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Input must be an object');
  }

  const grepInput = input as GrepInput;

  if (typeof grepInput.pattern !== 'string') {
    throw new Error('Input must have a "pattern" field of type string');
  }

  // Effective cwd priority:
  // 1. context?.resolveBase — permission-system anchor (from dispatcher)
  // 2. context?.cwd — per-call back-compat
  // 3. sessionCwd — factory-level worktree isolation
  // 4. process.cwd() fallback
  const rawPath = typeof grepInput.path === 'string'
    ? grepInput.path
    : (context?.resolveBase ?? context?.cwd ?? sessionCwd ?? process.cwd());

  // Apply containment — throws if path escapes allowed read roots
  const resolvedPath = resolveAndContain(rawPath, context, 'read');

  let include: string | undefined;
  if (grepInput.include !== undefined) {
    if (typeof grepInput.include !== 'string') {
      throw new Error('include must be a string');
    }
    include = grepInput.include;
  }

  return {
    pattern: grepInput.pattern,
    path: resolvedPath,
    include,
  };
}

/**
 * Create a grep handler closed over the session's working directory.
 *
 * `cwd` scopes both the default search path (when the model omits `path`)
 * and the spawned `grep` process itself, so relative paths in output and
 * any shell-resolved globs honor the session worktree rather than the
 * host's `process.cwd()`. Pass `undefined` for legacy/test contexts that
 * want host-global behavior.
 */
export function createGrepHandler(cwd?: string): ToolHandler {
  return async (input: unknown, signal: AbortSignal, context?: ToolHandlerContext) => {
  const { pattern, path, include } = parseGrepInput(input, context, cwd);

  if (signal.aborted) {
    return { content: 'Search aborted', isError: true };
  }

  return new Promise((resolve) => {
    let resolved = false;

    function settle(result: { content: string; isError?: boolean; truncated?: boolean }) {
      if (resolved) return;
      resolved = true;
      signal.removeEventListener('abort', abortHandler);
      resolve(result);
    }

    // Base flags. `-n` = line numbers. `--no-heading`/`--color=never` force the
    // flat `path:line:content` shape on a pipe (don't rely on rg's tty auto-
    // detection). `--hidden` makes rg search dotfiles/dirs (.github, .env,
    // .claude) that the old `grep -rn` reached and agents grep constantly — rg
    // skips them by default; .gitignore is still honored (node_modules/dist
    // stay skipped). Do NOT add `-r`/`-rn`: in ripgrep `-r` is `--replace=TEXT`
    // and would silently rewrite every match.
    const args = ['-n', '--no-heading', '--color=never', '--hidden'];

    if (include) {
      args.push('-g', include);
    }

    // `--hidden` re-includes .git (a dot-dir not covered by .gitignore); exclude
    // it explicitly. Pushed AFTER any include glob so it always wins for .git paths.
    args.push('-g', '!.git');

    args.push(pattern, path);

    // Effective cwd priority (parity with the bash handler, #441):
    //   1. context?.resolveBase — permission anchor (updated in place on an
    //      in-flight setResolveBase re-anchor)
    //   2. context?.cwd — per-call override (back-compat)
    //   3. factory-level `cwd` — session worktree isolation (createGrepHandler)
    // Computed ONCE so the spawn cwd and the ENOENT diagnosis below cannot
    // disagree: a stale factory `cwd` would otherwise make the diagnosis stat a
    // different dir than spawn used, reverting to a raw `spawn <rgPath> ENOENT`
    // (Codex P2 on #471). spawn treats `cwd: undefined` as inherit process.cwd().
    const effectiveCwd = context?.resolveBase ?? context?.cwd ?? cwd;
    const proc = spawn(rgPath, args, effectiveCwd !== undefined ? { cwd: effectiveCwd } : {});

    let stdout = '';
    let stderr = '';

    // Mid-stream hard cap. Without an accumulator bound, `stdout += ...`
    // grows unboundedly: a grep emitting >~512MB of stdout (an unconstrained
    // recursive search across `node_modules`) overflows V8's max string
    // length and throws `RangeError: Invalid string length` synchronously
    // inside this data callback — escaping every try/catch because the throw
    // originates inside Node's Socket.emit → Readable.push chain, and the
    // post-close cap cannot save us (`close` never fires once the throw
    // aborts the read pipeline). So we bound the string at HARD_CAP_BYTES and
    // SIGKILL only when it is crossed — a genuine-runaway circuit-breaker.
    // Broad-but-legitimate searches (well under 8MB) run to completion.
    let totalBytes = 0;
    let overflowKilled = false;

    function maybeOverflow(stream: 'stdout' | 'stderr'): void {
      // M3: one-shot latch — concurrent stdout+stderr data events can both
      // push totalBytes past the threshold before the kill takes effect.
      // Check overflowKilled FIRST so only the first caller settles.
      if (overflowKilled) return;
      if (resolved) return;
      if (totalBytes < HARD_CAP_BYTES) return;
      overflowKilled = true;
      // P1: structured log so operators can observe runaway kills in
      // production without grepping for RangeError crash traces.
      console.warn(
        `[grep] overflow kill: stream=${stream} totalBytes=${totalBytes} pattern=${pattern} path=${path}`,
      );
      // P2: structured JSONL counterpart so the same event is queryable from
      // routing-decisions.jsonl. Fire-and-forget — appendRoutingDecision
      // swallows its own errors so telemetry never blocks the tool result.
      // Privacy: pattern/path are tool inputs and stay out of telemetry
      // (audit §G.4) — only the operational metrics (tool, total_bytes,
      // stream) are emitted.
      void appendRoutingDecision({
        event: 'tool.overflow_kill',
        tool: 'grep',
        total_bytes: totalBytes,
        stream,
      });
      proc.kill('SIGKILL');
      // F1 + F2: combine stdout + stderr (mirror bash.ts) and hard-code
      // isError: false — a byte-cap event is distinct from a grep error
      // (exit code 2), which the post-close path keeps separate. The child
      // was SIGKILL'd for exceeding the hard cap; give the model a head+tail
      // view plus the kill sentinel, and signal non-model consumers via the
      // structured `truncated: true` flag.
      const combined = stripEscapeSequences((stdout + stderr).trimEnd());
      const content = headAndTail(combined, MODEL_CAP_BYTES) + HARD_CAP_KILL_NOTE;
      settle({ content, truncated: true });
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

    // Abort — resolve immediately, don't wait for streams.
    const abortHandler = () => {
      proc.kill();
      settle({ content: 'Search aborted', isError: true });
    };
    signal.addEventListener('abort', abortHandler);

    // Normal completion — `close` fires after all stdio streams drain.
    proc.on('close', (code) => {
      // Overflow path already settled before the SIGKILL → close
      // round-trip; drop the exit code (it is going to be `null` from
      // the signal) so we don't re-classify the result as "no matches"
      // (code === 1) or "grep error" (code === 2).
      if (overflowKilled) return;

      if (code === 1) {
        const message = `No matches found for '${pattern}' in ${path}`;
        settle({ content: message });
        return;
      }

      if (code === 2) {
        // stderr may accumulate up to HARD_CAP_BYTES (e.g. a recursive search
        // across a tree with many unreadable files), so cap it to the model budget.
        const capped = capForModel(stderr.trim());
        settle({
          content: `grep error: ${capped.content}`,
          isError: true,
          ...(capped.truncated ? { truncated: true } : {}),
        });
        return;
      }

      const combined = stripEscapeSequences(stdout.trimEnd());
      const capped = capForModel(combined);
      settle({ content: capped.content, ...(capped.truncated ? { truncated: true } : {}) });
    });

    proc.on('error', (err) => {
      // Dual-cause ENOENT: a missing or non-executable bundled `rgPath` (e.g. a
      // @vscode/ripgrep platform optional-dep that didn't install) also surfaces
      // as `spawn <rgPath> ENOENT`, indistinguishable by error shape from the
      // dead-cwd masquerade below. Check rg-binary availability FIRST (stats
      // rgPath on the error path only) so a bad binary is diagnosed as such and
      // never misattributed to a deleted worktree.
      const rgUnavailable = describeRgUnavailable(rgPath);
      if (rgUnavailable !== undefined) {
        settle({ content: `Failed to execute grep: ${rgUnavailable}`, isError: true });
        return;
      }

      // Spawn ENOENT masquerade: a dead working directory (e.g. a git worktree
      // reaped mid-session) surfaces as `spawn grep ENOENT` — naming the binary,
      // not the missing dir — so an agent retries blindly. Translate it into an
      // actionable message via statSync on the error path only (no TOCTOU, no
      // happy-path cost). Diagnoses against the SAME hoisted `effectiveCwd` that
      // spawn used above, so the two can never stat different dirs (bash parity,
      // #441).
      let message: string;
      if (effectiveCwd === undefined && isSpawnEnoent(err)) {
        // No explicit cwd was passed, so spawn inherited process.cwd(); that
        // directory itself can be deleted (same masquerade) — report as such.
        try {
          message = describeSpawnCwdError(err, process.cwd());
        } catch {
          message = `working directory does not exist (process cwd deleted — deleted worktree?) — underlying: ${err.message}`;
        }
      } else {
        message = describeSpawnCwdError(err, effectiveCwd);
      }
      settle({ content: `Failed to execute grep: ${message}`, isError: true });
    });
  });
  };
}

/**
 * Default grep handler with no session cwd. Defaults to `process.cwd()`
 * when the model omits `path`. Retained for backward compat (tests,
 * external plugins). Production sessions use {@link createGrepHandler}.
 */
export const grepHandler: ToolHandler = createGrepHandler();
