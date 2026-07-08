/**
 * Grep tool handler.
 *
 * Searches for a pattern in files using `grep -rn` with optional include filter.
 * Runs in basic-regex (BRE) mode by default — where `|` is a *literal* pipe, not
 * alternation — and exposes an `extended` flag that adds `-E` for extended-regex
 * (ERE) semantics. The BRE default is deliberate: a bare `|` is a common literal
 * in source (TS union types `string | number`, shell pipes, bitwise OR), so the
 * tool must not silently reinterpret it. To keep the BRE `|`-is-literal footgun
 * from masquerading as proven absence, the no-match path appends a self-correcting
 * ERE hint when the pattern contains an unescaped `|` (see the `close` handler).
 * Respects signal-based cancellation and truncates output at 100KB. The 100KB
 * cap is enforced TWICE: a mid-stream byte counter kills the child as soon as
 * the threshold is crossed (prevents V8 max-string-length overflow on
 * pathologically large output), and the post-close handler re-applies the same
 * length cap as a safety net. Strips ANSI escape sequences.
 *
 * @module agent/tools/handlers/grep
 */

import { spawn } from 'child_process';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { appendRoutingDecision } from '../../routing-telemetry.js';
import { resolveAndContain } from './_cwd-utils.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { describeSpawnCwdError, isSpawnEnoent } from '../../../utils/spawn-cwd-error.js';

/**
 * Input shape for the grep tool (validated at runtime).
 */
interface GrepInput {
  pattern?: unknown;
  path?: unknown;
  include?: unknown;
  extended?: unknown;
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
  extended: boolean;
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

  let extended = false;
  if (grepInput.extended !== undefined) {
    if (typeof grepInput.extended !== 'boolean') {
      throw new Error('extended must be a boolean');
    }
    extended = grepInput.extended;
  }

  return {
    pattern: grepInput.pattern,
    path: resolvedPath,
    include,
    extended,
  };
}

/**
 * Detect an unescaped `|` in a search pattern. In basic-regex (BRE) mode — the
 * grep default — `|` is a *literal pipe*, not alternation, so a pattern like
 * `foo|bar` silently matches the literal text `foo|bar` and returns zero hits
 * when the model meant "foo OR bar". This predicate gates the educational hint
 * on the no-match path. A preceding backslash means the `|` was escaped
 * deliberately (the model wants the literal), so we suppress the hint there.
 */
function hasUnescapedAlternation(pattern: string): boolean {
  return /(?<!\\)\|/.test(pattern);
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
  const { pattern, path, include, extended } = parseGrepInput(input, context, cwd);

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

    const args = ['-rn'];

    // ERE opt-in: `-E` makes `|` alternation and `+ ? ( ) { }` metacharacters.
    // Default (BRE) leaves them literal — see the module header for why.
    if (extended) {
      args.push('-E');
    }

    if (include) {
      args.push(`--include=${include}`);
    }

    args.push(pattern, path);

    // Scope the spawned grep to the session's worktree. spawn treats
    // `cwd: undefined` as inherit from process.cwd().
    const proc = spawn('grep', args, cwd !== undefined ? { cwd } : {});

    let stdout = '';
    let stderr = '';

    // Mid-stream byte cap. Without this, `stdout += chunk.toString()`
    // accumulates unboundedly: a grep that emits >~512MB of stdout
    // (e.g. an unconstrained recursive search across `node_modules`)
    // overflows V8's max string length and throws `RangeError: Invalid
    // string length` synchronously inside this data callback — escaping
    // every try/catch because the throw originates inside Node's
    // Socket.emit → Readable.push chain. The post-close 100KB cap
    // cannot save us because `close` never fires when the throw aborts
    // the read pipeline. So we count bytes here and kill+settle as soon
    // as the cap is crossed. SIGKILL (not SIGTERM) so the child cannot
    // flush more output during termination.
    //
    // External constraint: V8 max string length (~512MB on x64). The
    // 100KB cap is identical to the post-close cap so behavior is
    // consistent regardless of which path fires.
    const MAX_OUTPUT_BYTES = 100_000;
    let totalBytes = 0;
    let overflowKilled = false;

    function maybeOverflow(stream: 'stdout' | 'stderr'): void {
      // M3: one-shot latch — concurrent stdout+stderr data events can both
      // push totalBytes past the threshold before the kill takes effect.
      // Check overflowKilled FIRST so only the first caller settles.
      if (overflowKilled) return;
      if (resolved) return;
      if (totalBytes < MAX_OUTPUT_BYTES) return;
      overflowKilled = true;
      // P1: structured log so operators can observe overflow frequency in
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
      // isError: false. The earlier H2/M2 design picked one stream based
      // on which crossed the threshold first, which (a) silently discarded
      // valid stdout matches when stderr happened to drive overflow, and
      // (b) set isError on a byte-cap event, conflating "overflow fired"
      // with "grep reported an error" (exit code 2) — the post-close path
      // keeps those distinct. The triggering stream is preserved in the
      // P1 console.warn above, so operators still see which stream filled
      // the buffer. Callers detect overflow via the structured
      // `truncated: true` flag below (model-facing sentinel kept in
      // `content` for the in-band signal the model sees).
      let combined = (stdout + stderr).trimEnd();
      combined = stripEscapeSequences(combined);
      // The process was SIGKILL'd because output exceeded the byte cap —
      // we always truncate here. Slice the display string to the byte cap
      // (the primary guard already capped incoming buffers, so this is
      // belt-and-suspenders for the string-layer), then append the sentinel
      // unconditionally so the model sees the in-band signal. Non-model
      // consumers read `truncated: true` below instead.
      if (combined.length > MAX_OUTPUT_BYTES) {
        combined = combined.slice(0, MAX_OUTPUT_BYTES);
      }
      combined += '\n[output truncated]';
      settle({ content: combined, truncated: true });
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
        let message = `No matches found for '${pattern}' in ${path}`;
        // BRE footgun guard: in basic-regex mode `|` is a literal pipe, so
        // `foo|bar` silently returns zero hits when the model meant "foo OR
        // bar" — the classic false-negative this tool is prone to. Append a
        // self-correcting hint so an empty result is never mistaken for proven
        // absence. Suppressed in `extended` mode (where `|` already alternated)
        // and when the `|` was explicitly escaped (deliberate literal).
        if (!extended && hasUnescapedAlternation(pattern)) {
          message +=
            "\n\nNote: this search ran in basic-regex (BRE) mode, where '|' is a " +
            "literal pipe — not alternation. If you intended \"A or B\", retry with " +
            'extended: true (extended regex / ERE). If you meant the literal ' +
            "character '|', this empty result stands.";
        }
        settle({ content: message });
        return;
      }

      if (code === 2) {
        settle({ content: `grep error: ${stderr.trim()}`, isError: true });
        return;
      }

      let combined = stdout.trimEnd();
      combined = stripEscapeSequences(combined);

      let truncatedHere = false;
      if (combined.length > MAX_OUTPUT_BYTES) {
        combined = combined.slice(0, MAX_OUTPUT_BYTES) + '\n[output truncated]';
        truncatedHere = true;
      }

      settle({ content: combined, ...(truncatedHere ? { truncated: true } : {}) });
    });

    proc.on('error', (err) => {
      // Spawn ENOENT masquerade: a dead working directory (e.g. a git worktree
      // reaped mid-session) surfaces as `spawn grep ENOENT` — naming the binary,
      // not the missing dir — so an agent retries blindly. Translate it into an
      // actionable message via statSync on the error path only (no TOCTOU, no
      // happy-path cost). Parity with the bash handler (#441).
      const effectiveCwd = context?.resolveBase ?? context?.cwd ?? cwd;
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
