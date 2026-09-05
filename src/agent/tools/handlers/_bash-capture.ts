/**
 * Bounded capture storage for bash output that exceeded the model-facing cap.
 *
 * When a bash command produces more than MODEL_CAP_BYTES (100 KB) the handler
 * feeds the model a head+tail view and writes the full collected output (up to
 * HARD_CAP_BYTES, 8 MB) to a per-tool-call capture file so the TUI can offer
 * a discoverable path rather than silently discarding the middle.
 *
 * Storage layout:
 *   $AFK_STATE_DIR/witness/<sessionId>/bash-captures/<toolUseId>.txt
 *
 * Retention: capture files live inside the per-session witness trace directory,
 * so the existing witness sweep (30-day / 2 GiB policy in witness-sweep.ts)
 * evicts them automatically together with the rest of the session's trace data.
 * No separate sweeper is required.
 *
 * Access: restricted to the trace directory (user-local).
 *   - Parent directories are created with mode 0700 (owner only).
 *   - Capture files are written with O_CREAT|O_WRONLY|O_EXCL + mode 0600
 *     (exclusive create, owner read/write only, no symlink following).
 *   - `toolUseId` is sanitized to `[A-Za-z0-9_-]` before use in paths.
 *
 * The path is returned from `writeBashCapture` and exposed to the TUI as
 * `ToolResultChunk.capturePath`; the model never sees it (it is not in
 * `content`). When the session ID is absent or the write fails, `undefined`
 * is returned — the TUI renders "output capped" without a path, which is
 * truthful: the middle is hidden but was not persisted.
 *
 * @module agent/tools/handlers/_bash-capture
 */

import { mkdirSync, openSync, writeSync, closeSync } from 'fs';
import { getBashCapturesDir } from '../../../paths.js';

/**
 * Hard cap on each individual capture file (bytes). Mirrors HARD_CAP_BYTES —
 * the most the bash accumulator ever holds — so `writeBashCapture` is always
 * called with at most this many bytes and never needs to truncate further.
 */
export const CAPTURE_MAX_BYTES = 8_000_000;

/**
 * Write `fullOutput` to a capture file and return its absolute path.
 *
 * Returns `undefined` on any write failure or when `sessionId` is absent —
 * capture is best-effort; a write failure MUST NOT surface as a tool error.
 *
 * Security properties:
 * - `sessionId` is validated by `getBashCapturesDir → getTraceDir → validateSessionId`.
 * - `toolUseId` is sanitised to `[A-Za-z0-9_-]` before use in the filename.
 * - The capture directory is created with mode 0700 (owner only).
 * - The file is opened with O_CREAT|O_WRONLY|O_EXCL so it cannot follow a
 *   pre-existing symlink and cannot collide with a concurrent write.
 * - File mode is 0600 (owner read+write only).
 *
 * Preconditions:
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
    if (dir === undefined) return undefined;
    // 0o700: owner rwx, no group or other access. The directory itself
    // contains session-scoped bash output and should not be world-readable.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safeId = toolUseId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'capture';
    const filePath = `${dir}/${safeId}.txt`;
    // Guard: never write more than CAPTURE_MAX_BYTES to disk.
    const buf = Buffer.from(fullOutput, 'utf8');
    const toWrite = buf.length <= CAPTURE_MAX_BYTES ? buf : buf.subarray(0, CAPTURE_MAX_BYTES);
    // O_CREAT|O_WRONLY|O_EXCL: creates a new file exclusively — fails if the
    // path already exists (collision-safe) and does not follow symlinks
    // (symlink-safe). Mode 0o600: owner read+write only.
    const fd = openSync(filePath, 'wx', 0o600);
    try {
      writeSync(fd, toWrite);
    } finally {
      closeSync(fd);
    }
    return filePath;
  } catch {
    // Best-effort: swallow any filesystem error (disk full, permissions,
    // collision with a prior identical toolUseId in the same session, etc.)
    return undefined;
  }
}
