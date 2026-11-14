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
import { createStreamingCap } from './_streaming-cap.js';
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

/**
 * Run the retry search with the rewritten pattern and return the settle result.
 *
 * Called only when the first run returned exit 1 (no matches) and the pattern
 * contains an unescaped `\|`. Spawns rg once more with the rewritten pattern
 * and returns a {@link GrepSettleResult} with an appropriate note prepended
 * when the retry finds matches, or the extended no-match message when it does
 * not.
 */
export async function runPipeRetry(
  originalPattern: string,
  rgPath: string,
  rgArgs: string[],
  spawnOptions: SpawnOptions,
  searchPath: string,
): Promise<GrepSettleResult> {
  const rewritten = rewriteBackslashPipe(originalPattern);

  const retryResult = await new Promise<GrepSettleResult>((res) => {
    const retryOut = createStreamingCap(MODEL_CAP_BYTES);
    const retryErr = createStreamingCap(MODEL_CAP_BYTES);
    const retryProc = spawn(rgPath, rgArgs, spawnOptions);
    retryProc.stdout!.on('data', (c: Buffer) => retryOut.push(c));
    retryProc.stderr!.on('data', (c: Buffer) => retryErr.push(c));
    retryProc.on('close', (rc) => {
      if (rc === 1) {
        res({ content: `No matches found for '${rewritten}' in ${searchPath}` });
      } else if (rc === 2) {
        res(classifyRgExit2(retryErr.render(), searchPath));
      } else {
        const body = stripEscapeSequences(retryOut.render().trimEnd());
        res({ content: body, ...(retryOut.truncated() ? { truncated: true } : {}) });
      }
    });
    retryProc.on('error', () => {
      res({ content: `No matches found for '${originalPattern}' in ${searchPath}` });
    });
  });

  if (retryResult.isError) {
    // Rewritten pattern caused an rg error (bad regex, etc.). Return plain
    // no-match for the original pattern.
    return { content: `No matches found for '${originalPattern}' in ${searchPath}` };
  }

  const retryHadMatches = !retryResult.content.startsWith('No matches found');

  if (retryHadMatches) {
    const note =
      `Note: the original pattern '${originalPattern}' matched nothing ` +
      `because \\| matches a literal pipe character in ripgrep; ` +
      `results below are for the reinterpreted pattern '${rewritten}'.`;
    return {
      content: `${note}\n${retryResult.content}`,
      ...(retryResult.truncated ? { truncated: true } : {}),
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
