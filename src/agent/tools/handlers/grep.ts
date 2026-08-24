/**
 * Grep tool handler.
 *
 * Searches for a pattern in files using bundled ripgrep (`@vscode/ripgrep`'s
 * `rgPath`) with optional include filter. Ripgrep has no basic-regex (BRE)
 * mode: `|` `+` `?` `(` `)` `{` `}` are always regex metacharacters (e.g. a
 * bare `foo|bar` alternates, matching either branch) — a deliberate contract
 * change from the previous system-`grep`-backed implementation, which ran in
 * BRE mode by default and required an `extended` opt-in for alternation.
 * Respects signal-based cancellation. Output streams through a bounded
 * head+tail collector (see `_streaming-cap.ts`) that retains at most
 * MODEL_CAP_BYTES (100KB) while counting every byte and matching line, so
 * memory no longer scales with match volume and a truncated view always
 * reports the true total it was drawn from. A separate {@link SCAN_CAP_BYTES}
 * ceiling SIGKILLs only a genuine runaway. Strips ANSI escape sequences.
 *
 * @module agent/tools/handlers/grep
 */

import { spawn } from 'child_process';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import { appendRoutingDecision } from '../../routing-telemetry.js';
import { resolveAndContain } from './_cwd-utils.js';
import { getReadDenylistDescendants } from './read-denylist.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { describeSpawnCwdError, isSpawnEnoent } from '../../../utils/spawn-cwd-error.js';
import { describeRgUnavailable } from './_rg-availability.js';
import { MODEL_CAP_BYTES } from './_output-cap.js';
import { classifyRgExit2, type GrepSettleResult } from './_rg-exit2.js';
import { createStreamingCap, SCAN_CAP_BYTES, scanCapKillNote } from './_streaming-cap.js';

/** Optional overrides for {@link createGrepHandler}. */
export interface GrepHandlerOptions {
  /**
   * Override the scan-volume ceiling (default {@link SCAN_CAP_BYTES}). Tests
   * inject a small value to exercise the runaway kill without writing a
   * multi-hundred-MB fixture.
   */
  scanCapBytes?: number;
}

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
export function createGrepHandler(cwd?: string, options?: GrepHandlerOptions): ToolHandler {
  const scanCap = options?.scanCapBytes ?? SCAN_CAP_BYTES;
  return async (input: unknown, signal: AbortSignal, context?: ToolHandlerContext) => {
  const { pattern, path, include } = parseGrepInput(input, context, cwd);

  if (signal.aborted) {
    return { content: 'Search aborted', isError: true };
  }

  // Invariant: load `@vscode/ripgrep` LAZILY, not at module top-level. The
  // package resolves its platform-specific optional-dependency binary AT
  // MODULE IMPORT and THROWS if that package is absent (a `--no-optional`
  // install, an unsupported os/cpu, or a corrupted node_modules). A top-level
  // `import { rgPath }` would let that throw abort PROCESS STARTUP — the
  // handlers index pulls this module in at tool-registration, so a missing
  // optional-dep would take down EVERY tool and never reach the graceful
  // diagnostics below. Importing here, behind a catch, confines the failure to
  // the grep call and returns the same actionable "ripgrep unavailable" shape
  // the spawn-error path (describeRgUnavailable) produces for a present-but-
  // broken binary.
  let rgPath: string;
  try {
    ({ rgPath } = await import('@vscode/ripgrep'));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      content: `Failed to execute grep: ripgrep is unavailable — ${detail}`,
      isError: true,
    };
  }

  return new Promise((resolve) => {
    let resolved = false;

    function settle(result: GrepSettleResult) {
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

    // `resolveAndContain` protects the requested root, but a readable parent
    // can contain unconditionally protected descendants. Prune each such
    // subtree before ripgrep opens any files. Anchor the globs at the search
    // root and escape glob metacharacters in literal path names.
    // Invariant: normalization lives in `getReadDenylistDescendants` — do not
    // reintroduce a local `relative(path, blocked)` (see its docstring).
    for (const literalRel of getReadDenylistDescendants(path)) {
      const literal = literalRel
        .split('/')
        .map((s) => s.replace(/([*?\[\]{}\\])/g, '\\$1'))
        .join('/');
      args.push('-g', `!${literal}`, '-g', `!${literal}/**`);
    }

    // `--hidden` re-includes .git (a dot-dir not covered by .gitignore); exclude
    // it explicitly. Pushed AFTER any include glob so it always wins for .git paths.
    args.push('-g', '!.git');

    // Invariant: `pattern` and `path` MUST follow a `--` end-of-options separator.
    // Without it, ripgrep parses any argument beginning with `-` as a FLAG, not a
    // positional: a benign pattern like `->` fails ("unrecognized flag"), and a
    // prompt-injected `--pre=<cmd>` reaches rg's preprocessor flag and EXECUTES
    // <cmd> for every file (argument-injection → command execution — system `grep`
    // had no such flag, so the swap to rg makes the missing `--` exploitable).
    // `--` forces rg to treat everything after it as positionals: pattern, then path.
    args.push('--', pattern, path);

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

    // Invariant: the model never receives more than MODEL_CAP_BYTES, so there
    // is no reason to hold more than that in memory. Both streams feed bounded
    // head+tail collectors that discard the interior AS IT ARRIVES while
    // keeping exact byte and line totals — which is what lets a truncated
    // result state how much it omitted instead of looking complete. This
    // replaces an accumulate-then-truncate design that buffered up to 8MB in
    // order to show 100KB and SIGKILL'd at that ceiling, losing both the true
    // total and the remainder of the traversal. The V8 max-string-length
    // hazard that justified the old kill cannot arise here: neither collector
    // grows past its budget no matter how much ripgrep emits.
    const out = createStreamingCap(MODEL_CAP_BYTES);
    const err = createStreamingCap(MODEL_CAP_BYTES);

    let scanKilled = false;

    function maybeScanCap(stream: 'stdout' | 'stderr'): void {
      // M3: one-shot latch — concurrent stdout+stderr data events can both
      // cross the threshold before the kill takes effect. Check the latch
      // FIRST so only the first caller settles.
      if (scanKilled) return;
      if (resolved) return;
      const totalBytes = out.totalBytes() + err.totalBytes();
      if (totalBytes < scanCap) return;
      scanKilled = true;
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
      // F1 + F2: hard-code isError: false — a scan-cap event is distinct from
      // a grep error (exit code 2), which the post-close path keeps separate.
      // Render the stream that actually produced the volume: a runaway is
      // normally matches on stdout, but a search over an unreadable tree can
      // be all stderr, and falling back keeps that diagnosable.
      const body = out.totalBytes() === 0 && err.totalBytes() > 0 ? err.render() : out.render();
      settle({ content: stripEscapeSequences(body.trimEnd()) + scanCapKillNote(scanCap), truncated: true });
    }

    proc.stdout!.on('data', (chunk: Buffer) => {
      out.push(chunk);
      maybeScanCap('stdout');
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      err.push(chunk);
      maybeScanCap('stderr');
    });

    // Abort — resolve immediately, don't wait for streams.
    const abortHandler = () => {
      proc.kill();
      settle({ content: 'Search aborted', isError: true });
    };
    signal.addEventListener('abort', abortHandler);

    // Normal completion — `close` fires after all stdio streams drain.
    proc.on('close', (code) => {
      // Scan-cap path already settled before the SIGKILL → close
      // round-trip; drop the exit code (it is going to be `null` from
      // the signal) so we don't re-classify the result as "no matches"
      // (code === 1) or "grep error" (code === 2).
      if (scanKilled) return;

      if (code === 1) {
        const message = `No matches found for '${pattern}' in ${path}`;
        settle({ content: message });
        return;
      }

      if (code === 2) {
        // rg exits 2 for a missing path, an unreadable path, AND a bad regex.
        // `classifyRgExit2` splits the first (benign `no-such-target`) from the
        // rest (unclassified, alarming) — see `_rg-exit2.ts` for the shapes.
        // The collector already bounds stderr at the model budget and reports
        // whether anything was dropped.
        settle(classifyRgExit2(err.render(), path));
        return;
      }

      const combined = stripEscapeSequences(out.render().trimEnd());
      settle({ content: combined, ...(out.truncated() ? { truncated: true } : {}) });
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
