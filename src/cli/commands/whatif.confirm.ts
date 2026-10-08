/**
 * TTY confirmation helper for `afk whatif`.
 *
 * Extracted from whatif.ts so the 350-code-line ceiling is respected.
 *
 * @module cli/commands/whatif.confirm
 */

import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

/**
 * Display `lines` on stderr then prompt with `question` and return `true`
 * if the user answers `y` (case-insensitive), `false` otherwise.
 *
 * The implementation resolves the promise **before** closing readline so the
 * `close` event (which fires synchronously inside `rl.close()`) can never race
 * with the `line` handler and force a `false` result.
 *
 * @param lines    Informational lines printed above the prompt.
 * @param question Prompt text (no trailing space needed — one is added).
 * @param input    Optional readable stream (defaults to process.stdin); used
 *                 by tests to inject a fake stdin without monkey-patching.
 */
export async function confirmSpec(
  lines: string[],
  question = 'Proceed with this change?',
  input: Readable = process.stdin,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const rl = createInterface({ input, output: process.stderr });
    process.stderr.write('\n');
    for (const l of lines) process.stderr.write(`  ${l}\n`);
    process.stderr.write(`\n${question} [y/N] `);

    let settled = false;

    rl.once('line', (answer) => {
      settled = true;
      resolve(answer.trim().toLowerCase() === 'y');
      rl.close();
    });

    rl.once('close', () => {
      // Only fires as the fallback when the stream closes before a line
      // arrives (e.g. the user hits Ctrl-D / stdin reaches EOF).
      if (!settled) resolve(false);
    });
  });
}
