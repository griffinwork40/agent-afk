/**
 * Non-TTY fallback for the autocomplete reader.
 *
 * When stdin or stdout is not a TTY, raw-mode keypress handling is
 * impossible, so the input collection delegates to the line-oriented
 * `readInput()` from `multi-line-reader.ts`.
 *
 * Bug fix: the TTY path honors `opts.onSigint`, but the previous non-TTY
 * code path ignored it — the `onSigint` contract was silently dropped. We
 * install a process-level SIGINT handler for the duration of the read so
 * the contract holds across both surfaces, and uninstall it on the way out.
 */

import { readInput } from '../multi-line-reader.js';
import type { ReadWithAutocompleteOpts, ReadWithAutocompleteResult } from './types.js';

export async function readNonTty(
  opts: ReadWithAutocompleteOpts,
): Promise<ReadWithAutocompleteResult> {
  // Honor `initialBuffer` on non-TTY surfaces by returning it as the read
  // result without consuming stdin. This mirrors the TTY auto-submit
  // semantics: the REPL queues a message during a streaming turn (user
  // already pressed Enter once), and the next prompt should surface that
  // queued text immediately rather than block on stdin or drop it silently.
  // Without this branch, piped/CI sessions would lose queued input.
  if (opts.initialBuffer !== undefined && opts.initialBuffer.length > 0) {
    return { text: opts.initialBuffer, attachments: [] };
  }
  let sigintHandler: (() => void) | null = null;
  if (opts.onSigint) {
    const userHandler = opts.onSigint;
    sigintHandler = () => userHandler();
    process.on('SIGINT', sigintHandler);
  }
  try {
    const text = await readInput({
      rl: opts.rl,
      promptFn: opts.promptFn,
    });
    return { text, attachments: [] };
  } finally {
    if (sigintHandler) {
      process.removeListener('SIGINT', sigintHandler);
    }
  }
}
