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
 *     mistaken for a session without one.
 *
 * @module cli/commands/acp.session-record
 */

import { readFileSync } from 'node:fs';

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
 * Read the record for `acpId`: undefined when no record file exists; throws
 * when the file exists but cannot be read or does not hold a non-empty `cwd`.
 */
export function readAcpSessionRecord(acpId: string): AcpSessionRecord | undefined {
  let raw: string;
  try {
    raw = readFileSync(getAcpSessionRecordPath(acpId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined;
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
