/**
 * Dead-letter quarantine for malformed or unsafe daemon handoff records.
 *
 * A malformed handoff record (invalid JSON, unsafe taskId, or persistently
 * unreadable claimed file) is moved into `<handoffsDir>/dead-letter/` so it
 * stops being re-scanned on every sweep tick while remaining available for
 * operator diagnosis.
 *
 * Mirrors the `quarantinePoisonEntry` convention used by queue-store.ts for
 * FIFO queue entries.
 *
 * @module agent/daemon/handoff-consume.dead-letter
 */

import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { errorMessage } from '../../utils/errors.js';
import { redactInlineSecrets } from '../session/prompt-dump.js';

/**
 * Subdirectory (relative to `handoffsDir`) used to quarantine malformed or
 * unsafe handoff records instead of silently skipping them on every sweep tick.
 *
 * NOTE: dead-letter files are never auto-pruned — the directory grows unbounded
 * and is expected to be inspected and cleared manually by the operator. A
 * periodic sweep is a tracked follow-up, kept out of this fix to limit scope.
 */
export const DEAD_LETTER_SUBDIR = 'dead-letter';

/**
 * Maximum consecutive re-read failures on a claimed file before it is moved
 * to the dead-letter dir. A single failure is likely a transient I/O hiccup;
 * repeated failures on the same taskId indicate a persistently unreadable
 * record that would loop forever without this cap.
 */
export const MAX_CLAIM_REREAD_FAILURES = 3;

/**
 * In-process counter for consecutive re-read failures per taskId in the claim
 * path. Mirrors `stuckEntryEncounters` in queue-store.ts. Keys are taskId
 * strings (validated by assertSafeJobId before insertion). The map grows by at
 * most one entry per distinct persistently-unreadable claimed file and is
 * cleared once the file is successfully dead-lettered or processes successfully.
 */
export const claimRereadFailures: Map<string, number> = new Map();

/**
 * Move a malformed or unsafe handoff file into `<handoffsDir>/dead-letter/`
 * so it stops being re-scanned on every sweep tick, while preserving it for
 * operator diagnosis. Uses an atomic same-directory rename; appends a
 * timestamp+random suffix on name collision. Never throws — if the move fails,
 * logs the failure and leaves the file in place (it will be re-encountered and
 * re-attempted on the next sweep).
 *
 * The `srcPath` must be a safe path derived from OS readdir output or an
 * internal `.claiming-*` path, not from user-controlled content.
 * The `displayName` is redacted before logging.
 *
 * @param handoffsDir - The handoffs directory.
 * @param srcPath     - Full path to the file to dead-letter.
 * @param displayName - Filename (from readdir or internal) used in log messages.
 * @param reason      - Human-readable reason for dead-lettering.
 */
export async function deadLetterHandoffFile(
  handoffsDir: string,
  srcPath: string,
  displayName: string,
  reason: string,
): Promise<void> {
  const redactedName = redactInlineSecrets(displayName);
  const deadLetterDir = join(handoffsDir, DEAD_LETTER_SUBDIR);
  try {
    await mkdir(deadLetterDir, { recursive: true });
    let dest = join(deadLetterDir, displayName);
    try {
      await rename(srcPath, dest);
    } catch {
      // Name collision in dead-letter/ — append unique suffix and retry.
      const suffix = `${Date.now()}-${randomBytes(3).toString('hex')}`;
      dest = join(deadLetterDir, `${suffix}-${displayName}`);
      await rename(srcPath, dest);
    }
    // eslint-disable-next-line no-console
    console.error(
      `[daemon] handoff-consume: dead-lettered malformed record ${redactedName} → ${DEAD_LETTER_SUBDIR}/ (${reason})`,
    );
  } catch (moveErr) {
    const moveReason = redactInlineSecrets(errorMessage(moveErr));
    // eslint-disable-next-line no-console
    console.error(
      `[daemon] handoff-consume: failed to dead-letter ${redactedName}; leaving in place (${moveReason})`,
    );
  }
}
