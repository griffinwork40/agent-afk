/**
 * Session presence files (Phase 2).
 *
 * Top-level sessions write a lightweight JSON file to `~/.afk/state/presence/`
 * on session start and delete it on exit. Subagent sessions do NOT write
 * presence files — they are identified by `depth > 0` or a non-null
 * `parentSessionId`. Callers must enforce this gate.
 *
 * Design:
 *   - Best-effort: write/delete failures are caught and swallowed.
 *     They never throw and never propagate to the caller.
 *   - Async write / async delete: callers fire-and-forget the Promises.
 *   - Sync delete variant (`removePresenceFileSync`) is provided for use in
 *     `process.on('exit')` handlers, which cannot await Promises.
 *   - `readPresenceFiles()` scans the presence directory and parses each file,
 *     skipping malformed or unreadable entries silently.
 *   - Uses `getPresenceDir()` from `paths.ts` — override via `AFK_HOME` for
 *     testing (set `AFK_HOME` to a temp dir).
 *
 * @module agent/awareness/presence
 */

import { mkdir, writeFile, unlink, readdir, readFile } from 'fs/promises';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { getPresenceDir } from '../../paths.js';
import type { RuntimeWorkspace } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Data written to the presence file for a live top-level session. */
export interface PresenceFileInfo {
  sessionId: string;
  surface: string;
  cwd: string;
  startedAt: string;            // ISO 8601
  model: { provider: string; name: string };
  workspace: RuntimeWorkspace;
  pid: number;
  /**
   * AFK remote-control marker (bidirectional Telegram). Set `true` by the REPL
   * `/afk on` toggle and cleared on `/afk off` via {@link setPresenceAfk}. A
   * watching Telegram daemon filters `readPresenceFiles()` on
   * `surface === 'cli' && afk === true` to auto-discover sessions whose
   * questions it should render to the operator's phone. Optional/additive:
   * absent (treated as `false`) on sessions that never entered AFK mode and on
   * every non-REPL surface.
   */
  afk?: boolean;
}

/** A presence record loaded from disk — same as PresenceFileInfo plus the file path. */
export interface PresenceRecord extends PresenceFileInfo {
  path: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function presenceFilePath(sessionId: string): string {
  return join(getPresenceDir(), `${sessionId}.json`);
}

/**
 * Ensure the presence directory exists. Returns `true` on success, `false` on
 * any fs error (caller treats write as best-effort).
 */
async function ensurePresenceDir(): Promise<boolean> {
  try {
    await mkdir(getPresenceDir(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a presence file for a top-level session.
 *
 * Fire-and-forget safe: callers may `void writePresenceFile(info)` without
 * awaiting. On any error, the failure is swallowed — presence files are
 * best-effort. The session starts normally regardless.
 */
export async function writePresenceFile(info: PresenceFileInfo): Promise<void> {
  try {
    const ok = await ensurePresenceDir();
    if (!ok) return;
    const filePath = presenceFilePath(info.sessionId);
    await writeFile(filePath, JSON.stringify(info, null, 2), 'utf8');
  } catch {
    // Best-effort — swallow silently.
  }
}

/**
 * Update the `afk` marker on an existing presence file (best-effort,
 * read-modify-write). Used by the REPL `/afk` toggle so a watching Telegram
 * daemon can discover AFK sessions via `readPresenceFiles()`. No-op when the
 * presence file is absent or unreadable (presence is non-critical — the
 * keyboard elicitation path works regardless). Preserves every other field.
 */
export async function setPresenceAfk(sessionId: string, afk: boolean): Promise<void> {
  try {
    const filePath = presenceFilePath(sessionId);
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as PresenceFileInfo;
    parsed.afk = afk;
    await writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf8');
  } catch {
    // Best-effort — presence is non-critical.
  }
}

/**
 * Asynchronously delete a presence file by session ID.
 *
 * Safe to call even if the file does not exist (ENOENT is swallowed).
 * All other errors are also swallowed — presence cleanup is best-effort.
 */
export async function removePresenceFile(sessionId: string): Promise<void> {
  try {
    await unlink(presenceFilePath(sessionId));
  } catch {
    // ENOENT or any other error — swallow.
  }
}

/**
 * Synchronously delete a presence file by session ID.
 *
 * Use in `process.on('exit')` handlers where Promises cannot be awaited.
 * All errors are swallowed — presence cleanup is best-effort.
 */
export function removePresenceFileSync(sessionId: string): void {
  try {
    const filePath = presenceFilePath(sessionId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Swallow — best-effort.
  }
}

/**
 * Scan the presence directory and return all parseable presence records.
 *
 * Silently skips:
 *   - Files that are not valid JSON.
 *   - Files whose parsed object does not have the required `sessionId` field.
 *   - Any file read or directory scan errors.
 *
 * Returns `[]` when the presence directory does not exist.
 */
export async function readPresenceFiles(): Promise<PresenceRecord[]> {
  const dir = getPresenceDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory does not exist or is unreadable — no sessions.
    return [];
  }

  const records: PresenceRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const filePath = join(dir, entry);
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'sessionId' in parsed &&
        typeof (parsed as Record<string, unknown>)['sessionId'] === 'string'
      ) {
        records.push({ ...(parsed as PresenceFileInfo), path: filePath });
      }
    } catch {
      // Malformed JSON or unreadable file — skip.
    }
  }
  return records;
}
