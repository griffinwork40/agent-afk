/**
 * Error presenter: renders a ClassifiedError to the terminal.
 *
 * TTY surfaces get a full errorBox with borders; non-TTY surfaces get a
 * plain "afk: error:" line on stderr. Debug mode appends the raw stack.
 *
 * @module cli/errors/presenter
 */

import { errorBox } from '../render.js';
import { isDebugEnabled } from '../../utils/debug.js';
import type { ClassifiedError } from './classifier.js';

/**
 * Present a classified error to the user.
 *
 * @param classified - The classified error to render.
 * @param opts       - Override isTTY detection or the write sink (for tests).
 */
export function presentError(
  classified: ClassifiedError,
  opts?: { isTTY?: boolean; write?: (s: string) => void },
): void {
  const isTTY = opts?.isTTY ?? (process.stdout.isTTY ?? false);
  const write = opts?.write ?? ((s: string) => { process.stderr.write(s); });

  if (isTTY) {
    write(errorBox(classified.userMessage, classified.hint) + '\n');
  } else {
    const hint = classified.hint ? ` (${classified.hint})` : '';
    write(`afk: error: ${classified.userMessage}${hint}\n`);
  }

  if (isDebugEnabled() && classified.raw instanceof Error && classified.raw.stack) {
    write(classified.raw.stack + '\n');
  }
}
