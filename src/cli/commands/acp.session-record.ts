/**
 * Per-session ACP record (profile §2): the canonical session directory that
 * `session/load` and `session/resume` of a non-live session must match.
 *
 * One file per ACP session id (`getAcpSessionRecordPath`), so concurrent
 * `afk acp` processes never read-modify-write a shared file.
 *
 * Contract:
 *   - writeAcpSessionRecord is synchronous and atomic (temp file then rename,
 *     owner-only mode, parent directory created) and throws on any failure.
 *   - readAcpSessionRecord returns undefined only when the file does not exist
 *     (confirmed absent: no entry for the id). An unreadable or malformed
 *     record throws, so a corrupt record is never mistaken for "no record".
 *     A dangling symlink at the record path throws: the link exists but its
 *     target does not, which is structurally distinct from the file being
 *     absent. A record path whose parent is not a directory also throws on
 *     every platform.
 *   - pruneAcpSessionRecord removes the record file when the caller has
 *     already determined the journal is gone. Best-effort: ENOENT is silently
 *     ignored. Any other error is re-thrown.
 *
 * @module cli/commands/acp.session-record
 */

import { lstatSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { getAcpSessionRecordPath } from '../../paths.journal.js';
import { atomicWriteFile } from '../../utils/atomic-write.js';

export interface AcpSessionRecord { cwd: string }

/** Write the record for `acpId`. Throws if the id is unsafe or the write fails. */
export function writeAcpSessionRecord(acpId: string, record: AcpSessionRecord): void {
  atomicWriteFile(getAcpSessionRecordPath(acpId), JSON.stringify({ cwd: record.cwd }), {
    mode: 0o600, mkdirp: true, mkdirMode: 0o700,
  });
}

/**
 * Remove the record for `acpId` when the backing journal is gone.
 * ENOENT (already removed) is silently ignored. Other errors are re-thrown.
 */
export function pruneAcpSessionRecord(acpId: string): void {
  const file = getAcpSessionRecordPath(acpId);
  try {
    rmSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw err;
  }
}

/**
 * True when the nearest existing ancestor of `file` is not a directory, or
 * cannot be examined. Windows answers ENOENT for a read through a file used
 * as a directory, so ENOENT alone does not prove the record is merely absent.
 * Links are followed (`statSync`), so a state directory or a `sessions`
 * directory that is a symbolic link or junction to a directory is not blocked.
 */
function parentBlocked(file: string): boolean {
  let dir = path.dirname(file);
  for (;;) {
    let st: ReturnType<typeof statSync> | undefined;
    try {
      st = statSync(dir, { throwIfNoEntry: false });
    } catch {
      return true;
    }
    if (st !== undefined) return !st.isDirectory();
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/**
 * True when `file` is a dangling symbolic link (the link exists but its
 * target does not). `lstatSync` sees the link itself; `statSync` follows it.
 * Returns false when `lstatSync` itself fails (e.g. the entry does not exist).
 */
function isDanglingSymlink(file: string): boolean {
  try {
    const lst = lstatSync(file, { throwIfNoEntry: false });
    if (lst === undefined || !lst.isSymbolicLink()) return false;
    // Link exists — check whether the target is reachable.
    const st = statSync(file, { throwIfNoEntry: false });
    return st === undefined;
  } catch {
    return false;
  }
}

/**
 * Read the record for `acpId`: undefined when no record file exists; throws
 * when the file exists but cannot be read or does not hold a non-empty `cwd`.
 * Also throws for a dangling symlink at the record path, which is structurally
 * different from the file being absent and must not silently become "no record".
 */
export function readAcpSessionRecord(acpId: string): AcpSessionRecord | undefined {
  const file = getAcpSessionRecordPath(acpId);
  // Fail-closed on a dangling symlink: the entry exists but the target is gone.
  if (isDanglingSymlink(file)) {
    throw Object.assign(new Error(`dangling symlink at ACP session record path for ${acpId}`), { code: 'ENOENT' });
  }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT' && !parentBlocked(file)) return undefined;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  const cwd = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)['cwd']
    : undefined;
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error(`malformed ACP session record for ${acpId}`);
  }
  return { cwd };
}
