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
 *   - readAcpSessionRecord returns undefined only when the file does not exist.
 *     An unreadable or malformed record throws, so a corrupt record is never
 *     mistaken for a session without one. A record path whose parent is not a
 *     directory also throws on every platform: Windows reports that case as
 *     ENOENT where POSIX reports ENOTDIR.
 *
 * @module cli/commands/acp.session-record
 */

import { readFileSync, statSync } from 'node:fs';
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
 * Read the record for `acpId`: undefined when no record file exists; throws
 * when the file exists but cannot be read or does not hold a non-empty `cwd`.
 */
export function readAcpSessionRecord(acpId: string): AcpSessionRecord | undefined {
  const file = getAcpSessionRecordPath(acpId);
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
