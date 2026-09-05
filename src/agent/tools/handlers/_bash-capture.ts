/**
 * Bounded capture storage for bash output that exceeded the model-facing cap.
 *
 * When a bash command produces more than MODEL_CAP_BYTES (100 KB) the handler
 * feeds the model a head+tail view and writes the full collected output (up to
 * HARD_CAP_BYTES, 8 MB) to a per-tool-call capture file so the TUI can offer
 * a discoverable path rather than silently discarding the middle.
 *
 * Storage layout:
 *   $AFK_STATE_DIR/bash-captures/<sessionId>/<toolUseId>.txt
 *
 * Retention: the witness sweep already evicts old session directories on the
 * 30-day / 2 GiB policy (see src/agent/witness-sweep.ts). Captures live in a
 * parallel sibling dir at the state level, not under witness/, so the sweep
 * does NOT currently purge them. This module caps each file at CAPTURE_MAX_BYTES
 * (8 MB) — the same floor as HARD_CAP_BYTES — to bound individual file size.
 * A follow-up sweep for the bash-captures dir is tracked separately.
 *
 * Access: restricted to the state dir (user-local). Capture files are written
 * 0o600 (owner read/write only). The parent directories are created via
 * mkdirSync without an explicit mode so they inherit the process umask.
 * The path is returned from `writeBashCapture` and exposed to the TUI as
 * `ToolResultChunk.capturePath`; the model never sees it (it is not in
 * `content`).
 *
 * @module agent/tools/handlers/_bash-capture
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getAfkStateDir } from '../../../paths.js';

/**
 * Hard cap on each individual capture file (bytes). Mirrors HARD_CAP_BYTES —
 * the most the bash accumulator ever holds — so `writeBashCapture` is always
 * called with at most this many bytes and never needs to truncate further.
 */
export const CAPTURE_MAX_BYTES = 8_000_000;

/**
 * Root for session-scoped bash capture files.
 * Distinct from the witness tree so the witness sweep does not evict these.
 */
export function getBashCapturesDir(sessionId?: string): string {
  const base = join(getAfkStateDir(), 'bash-captures');
  if (sessionId === undefined || sessionId === '') return base;
  // Session IDs come from provider-issued identifiers and must not allow path
  // traversal. Strip everything that is not alphanumeric, hyphen, or underscore.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return join(base, safe);
}

/**
 * Write `fullOutput` to a capture file and return its absolute path.
 *
 * Returns `undefined` on any write failure — capture is best-effort;
 * a write failure MUST NOT surface to the user as a tool error.
 *
 * Preconditions:
 * - `sessionId` and `toolUseId` are opaque strings; both are sanitised
 *   to `[A-Za-z0-9_-]` before use in paths.
 * - `fullOutput` is at most HARD_CAP_BYTES bytes (enforced by the bash
 *   accumulator before this is called).
 */
export function writeBashCapture(
  sessionId: string | undefined,
  toolUseId: string,
  fullOutput: string,
): string | undefined {
  try {
    const dir = getBashCapturesDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const safeId = toolUseId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
    const filePath = join(dir, `${safeId}.txt`);
    // Guard: never write more than CAPTURE_MAX_BYTES to disk.
    const buf = Buffer.from(fullOutput, 'utf8');
    const toWrite = buf.length <= CAPTURE_MAX_BYTES ? fullOutput : buf.subarray(0, CAPTURE_MAX_BYTES).toString('utf8');
    writeFileSync(filePath, toWrite, { encoding: 'utf8', mode: 0o600 });
    return filePath;
  } catch {
    // Best-effort: swallow any filesystem error (disk full, permissions, etc.)
    return undefined;
  }
}
