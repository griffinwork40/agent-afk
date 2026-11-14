/**
 * Pipe-retry helper for the grep handler.
 *
 * Models with a GNU-grep habit write `\|` for alternation. In ripgrep `\|`
 * matches a literal pipe character, not an alternation; the correct form is a
 * bare `|`. When a first search with `\|` in the pattern returns no matches
 * (rg exit 1), this module re-runs the search once with every unescaped `\|`
 * replaced by `|` and prefixes the result with a one-line note so the caller
 * knows what happened.
 *
 * The retry fires at most once and only on the "no matches" path. It never
 * fires when the first search had matches or errored, and never rewrites `\\|`
 * (an escaped backslash followed by alternation).
 *
 * @module agent/tools/handlers/grep.pipe-retry
 */

import { spawn } from 'child_process';
import type { SpawnOptions } from 'child_process';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { MODEL_CAP_BYTES } from './_output-cap.js';
import { createStreamingCap, scanCapKillNote } from './_streaming-cap.js';
import { awaitChildExit } from './_await-child-exit.js';
import { classifyRgExit2, type GrepSettleResult } from './_rg-exit2.js';

/**
 * Return true when `pattern` contains at least one unescaped `\|` sequence
 * that could be a mistyped alternation operator.
 *
 * A `\|` is "unescaped" unless the backslash is itself escaped (preceded by
 * another backslash). `\\|` is an escaped backslash followed by alternation
 * and must not be rewritten.
 *
 *   `foo\|bar`    → true  (single backslash before pipe — likely mistyped)
 *   `foo\\|bar`   → false (double backslash: escaped-backslash + bare-pipe)
 */
export function hasUnescapedBackslashPipe(pattern: string): boolean {
  // (?<!\\) negative lookbehind: the char before `\` must not itself be `\`.
  return /(?<!\\)\\\|/.test(pattern);
}

/**
 * Replace every unescaped `\|` in `pattern` with `|`.
 * Does not touch `\\|` (escaped backslash followed by alternation).
 */
export function rewriteBackslashPipe(pattern: string): string {
  return pattern.replace(/(?<!\\)\\\|/g, '|');
}

// ---------------------------------------------------------------------------
// Scan-cap state for the retry process
// ---------------------------------------------------------------------------

/** Outcome of a single retry rg run, before note decoration. */
interface RetryOutcome {
  /** True when rg found at least one match (exit 0). */
  hadMatches: boolean;
  result: GrepSettleResult;
}

// ---------------------------------------------------------------------------
// runPipeRetry
// ---------------------------------------------------------------------------

/**
 * Run the retry search with the rewritten pattern and return the settle result.
 *
 * Called only when the first run returned exit 1 (no matches) and the pattern
 * contains an unescaped `\|`. Spawns rg once more with the rewritten pattern
 * and returns a {@link GrepSettleResult} with an appropriate note prepended
 * when the retry finds matches, or the extended no-match message when it does
 * not.
 *
 * Contract: never rejects — all error paths are caught and mapped to a
 * {@link GrepSettleResult}. The caller may still attach `.catch` as a defence
 * against unexpected throws in this module's own code.
 *
 * @param signal      Abort signal from the parent handler; if already aborted
 *                    the retry is not spawned. If aborted mid-flight the retry
 *                    process is killed and the promise resolves with the abort
 *                    result.
 * @param scanCapBytes Scan-volume ceiling in bytes (same value the parent
 *                    handler uses). The retry is killed once stdout+stderr
 *                    total bytes cross this threshold, mirroring the parent
 *                    handler's {@link maybeScanCap} semantics.
 */
export async function runPipeRetry(
  originalPattern: string,
  rgPath: string,
  rgArgs: string[],
  spawnOptions: SpawnOptions,
  searchPath: string,
  signal: AbortSignal,
  scanCapBytes: number,
): Promise<GrepSettleResult> {
  // Contract: do not spawn if the signal is already aborted.
  if (signal.aborted) {
    return { content: 'Search aborted', isError: true };
  }

  const rewritten = rewriteBackslashPipe(originalPattern);

  const outcome = await new Promise<RetryOutcome>((res) => {
    const retryOut = createStreamingCap(MODEL_CAP_BYTES);
    const retryErr = createStreamingCap(MODEL_CAP_BYTES);
    const retryProc = spawn(rgPath, rgArgs, spawnOptions);

    let settled = false;
    let scanKilled = false;

    function settle(o: RetryOutcome, afterKill = false): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abortHandler);
      if (afterKill) {
        void awaitChildExit(retryProc).then(() => res(o));
      } else {
        res(o);
      }
    }

    // Abort handler: kill the retry process and settle as aborted.
    const abortHandler = (): void => {
      retryProc.kill();
      settle(
        { hadMatches: false, result: { content: 'Search aborted', isError: true } },
        true,
      );
    };
    signal.addEventListener('abort', abortHandler);

    function maybeScanCap(): void {
      if (scanKilled || settled) return;
      const totalBytes = retryOut.totalBytes() + retryErr.totalBytes();
      if (totalBytes < scanCapBytes) return;
      scanKilled = true;
      retryProc.kill('SIGKILL');
      const body =
        retryOut.totalBytes() === 0 && retryErr.totalBytes() > 0
          ? retryErr.render()
          : retryOut.render();
      const note =
        `Note: the original pattern '${originalPattern}' matched nothing ` +
        `because \\| matches a literal pipe character in ripgrep; ` +
        `results below are for the reinterpreted pattern '${rewritten}'.`;
      settle(
        {
          hadMatches: true,
          result: {
            content: `${note}\n${stripEscapeSequences(body.trimEnd())}${scanCapKillNote(scanCapBytes)}`,
            truncated: true,
          },
        },
        true,
      );
    }

    retryProc.stdout!.on('data', (c: Buffer) => {
      retryOut.push(c);
      maybeScanCap();
    });
    retryProc.stderr!.on('data', (c: Buffer) => {
      retryErr.push(c);
      maybeScanCap();
    });

    retryProc.on('close', (rc) => {
      // Scan-cap or abort already settled; ignore the close.
      if (scanKilled || settled) return;

      if (rc === 0) {
        const body = stripEscapeSequences(retryOut.render().trimEnd());
        settle({
          hadMatches: true,
          result: { content: body, ...(retryOut.truncated() ? { truncated: true } : {}) },
        });
        return;
      }

      if (rc === 1) {
        settle({
          hadMatches: false,
          result: { content: `No matches found for '${rewritten}' in ${searchPath}` },
        });
        return;
      }

      if (rc === 2) {
        settle({ hadMatches: false, result: classifyRgExit2(retryErr.render(), searchPath) });
        return;
      }

      // rc === null: process was killed by a signal (not by our scanKilled path,
      // which already returned above). Treat as no matches rather than matches.
      settle({
        hadMatches: false,
        result: { content: `No matches found for '${rewritten}' in ${searchPath}` },
      });
    });

    retryProc.on('error', () => {
      settle({
        hadMatches: false,
        result: { content: `No matches found for '${originalPattern}' in ${searchPath}` },
      });
    });
  });

  if (outcome.result.isError && !outcome.result.content.includes('Search aborted')) {
    // Rewritten pattern caused an rg error (bad regex, etc.). Return plain
    // no-match for the original pattern.
    return { content: `No matches found for '${originalPattern}' in ${searchPath}` };
  }

  // Abort result passes through directly.
  if (outcome.result.isError) {
    return outcome.result;
  }

  if (outcome.hadMatches) {
    // Scan-cap result already has the note prepended inside maybeScanCap.
    if (outcome.result.truncated && outcome.result.content.includes('matched nothing')) {
      return outcome.result;
    }
    const note =
      `Note: the original pattern '${originalPattern}' matched nothing ` +
      `because \\| matches a literal pipe character in ripgrep; ` +
      `results below are for the reinterpreted pattern '${rewritten}'.`;
    return {
      content: `${note}\n${outcome.result.content}`,
      ...(outcome.result.truncated ? { truncated: true } : {}),
    };
  }

  // Both readings found nothing.
  const base = `No matches found for '${originalPattern}' in ${searchPath}`;
  return {
    content:
      `${base} ` +
      `(also tried '${rewritten}' treating \\| as alternation — no matches either)`,
  };
}

// ---------------------------------------------------------------------------
// handlePipeRetry — call-site helper extracted from createGrepHandler
// ---------------------------------------------------------------------------

/**
 * Wire the pipe-retry decision into the parent handler's settle function.
 *
 * Extracted from `createGrepHandler` to keep that function within the 200-line
 * ceiling. Called from the `code === 1` branch of the parent's `proc.on('close')`
 * handler when the pattern contains an unescaped `\|`.
 *
 * Contract: always calls `settle` exactly once — either with the retry result
 * or with an abort result — and never lets the returned Promise escape as an
 * unhandled rejection. The `.catch` on the call site is a defence-in-depth
 * guard against unexpected throws inside `runPipeRetry`.
 */
export function handlePipeRetry(
  originalPattern: string,
  rgPath: string,
  rgArgs: string[],
  effectiveCwd: string | undefined,
  searchPath: string,
  signal: AbortSignal,
  scanCapBytes: number,
  settle: (result: GrepSettleResult) => void,
): void {
  const spawnOptions: SpawnOptions = effectiveCwd !== undefined ? { cwd: effectiveCwd } : {};
  runPipeRetry(originalPattern, rgPath, rgArgs, spawnOptions, searchPath, signal, scanCapBytes)
    .then((result) => settle(result))
    .catch(() => settle({ content: `No matches found for '${originalPattern}' in ${searchPath}` }));
}
