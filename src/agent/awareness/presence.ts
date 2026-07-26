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
import type { TraceActor } from '../session/session-identity.js';
import { classifyPidLiveness, type ProcessLiveness } from '../process-liveness.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Current presence-file schema version.
 *
 * Stamped by {@link writePresenceFile} onto every record it writes. Readers —
 * including out-of-process ones that are not part of this codebase — can branch
 * on it instead of inferring shape from which fields happen to be present.
 *
 * Absent on records written before versioning existed; treat a missing value as
 * version 0 and fail SOFT, never throwing. Presence is best-effort telemetry,
 * not a transaction log: a reader that rejects an unrecognised version makes a
 * live session invisible, which is strictly worse than reading it partially.
 *
 * Bump when a field's MEANING changes or a required field is added. Purely
 * additive optional fields do not require a bump.
 */
export const PRESENCE_SCHEMA_VERSION = 1;

/** Data written to the presence file for a live top-level session. */
export interface PresenceFileInfo {
  sessionId: string;
  surface: string;
  /**
   * Execution role ('main' | 'subagent'). Presence files are written for
   * top-level sessions only, so this is 'main' when set; carried for schema
   * uniformity with the other session-identity telemetry surfaces. Optional —
   * absent on presence files written before this field existed.
   */
  actor?: TraceActor;
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
  /**
   * Schema version of this record — see {@link PRESENCE_SCHEMA_VERSION}.
   * Optional: absent on records written before versioning existed.
   */
  schemaVersion?: number;
  /**
   * ISO 8601 timestamp of the last time the owning session affirmed it is alive,
   * via {@link touchPresenceHeartbeat}. Stamped at write time and refreshed
   * thereafter.
   *
   * Exists to bound the one hole pid-liveness cannot cover: the OS recycles
   * pids, so a record whose owner was SIGKILLed can read `'alive'` again once an
   * unrelated process inherits that pid. A stale heartbeat on a nominally-alive
   * pid is the signal for that case. Optional/additive: absent on records
   * written before this field existed, and on any session that never refreshed.
   */
  heartbeatAt?: string;
}

/**
 * Liveness verdict for a presence record. Re-exported so consumers need not
 * import from `process-liveness` directly.
 */
export type PresenceLiveness = ProcessLiveness;

/**
 * A presence record loaded from disk — `PresenceFileInfo` plus the file path and
 * fields COMPUTED at read time.
 *
 * `liveness` and `heartbeatAgeMs` are derived on every read and never persisted;
 * writing them would immediately stale them.
 */
export interface PresenceRecord extends PresenceFileInfo {
  path: string;
  /**
   * Whether the recorded `pid` is still running, computed at read time.
   *
   * `'unknown'` means the pid was absent or unusable — NOT that the session
   * ended. Consumers must filter on `'dead'` and never treat `'unknown'` as
   * finished.
   */
  liveness: PresenceLiveness;
  /**
   * Milliseconds since {@link PresenceFileInfo.heartbeatAt}, or `null` when no
   * parseable heartbeat is recorded. Lets a consumer require freshness on top of
   * pid-liveness without reimplementing the date math.
   */
  heartbeatAgeMs: number | null;
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
    // Stamp the schema version and an initial heartbeat HERE rather than at the
    // call sites: more than one provider writes presence (anthropic-direct and
    // openai-compatible), so a per-caller stamp would silently miss a writer the
    // moment a third surface is added. Caller-supplied values win, which keeps
    // tests able to pin a specific version or heartbeat.
    const record: PresenceFileInfo = {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      heartbeatAt: new Date().toISOString(),
      ...info,
    };
    await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
  } catch {
    // Best-effort — swallow silently.
  }
}

/**
 * Refresh the `heartbeatAt` timestamp on an existing presence file (best-effort,
 * read-modify-write). Preserves every other field.
 *
 * Call this at turn boundaries. A session that is alive but wedged, or whose pid
 * has been recycled after a SIGKILL, is indistinguishable from a healthy one on
 * pid-liveness alone — a stale heartbeat is what separates them.
 *
 * No-op when the presence file is absent (subagents never have one). Never
 * throws: presence is non-critical and the session must proceed regardless.
 */
export async function touchPresenceHeartbeat(sessionId: string): Promise<void> {
  try {
    const filePath = presenceFilePath(sessionId);
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as PresenceFileInfo;
    parsed.heartbeatAt = new Date().toISOString();
    await writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf8');
  } catch {
    // Best-effort — presence is non-critical.
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
 * Update the `cwd` field on an existing presence file (best-effort,
 * read-modify-write). Called from `AgentSession.setCwd` so a session's presence
 * record tracks its CURRENT working directory after a mid-session cwd change —
 * notably the born-named `afk -w` worktree, which is created on the first turn
 * AFTER presence was written with the launch dir. Without this the worktree
 * sweep's live-session guard (`isPathWithin(presence.cwd, worktreePath)`) never
 * matches, so the sweep can reap the worktree out from under the running
 * session. No-op when the file is absent (subagents never have one). Preserves
 * every other field.
 */
export async function updatePresenceCwd(sessionId: string, cwd: string): Promise<void> {
  try {
    const filePath = presenceFilePath(sessionId);
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as PresenceFileInfo;
    parsed.cwd = cwd;
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

/** Compute `heartbeatAgeMs` from a possibly-absent, possibly-garbage timestamp. */
function heartbeatAge(heartbeatAt: unknown, now: number): number | null {
  if (typeof heartbeatAt !== 'string') return null;
  const parsed = Date.parse(heartbeatAt);
  if (Number.isNaN(parsed)) return null;
  return now - parsed;
}

/**
 * Scan the presence directory and return all parseable presence records,
 * annotated with computed `liveness` and `heartbeatAgeMs`.
 *
 * Silently skips:
 *   - Files that are not valid JSON.
 *   - Files whose parsed object does not have the required `sessionId` field.
 *   - Any file read or directory scan errors.
 *
 * Returns `[]` when the presence directory does not exist.
 *
 * DOES NOT FILTER dead sessions. This is deliberate and safety-critical: the
 * worktree sweep uses these records to decide whether a worktree is still in use
 * (`isPathWithin(presence.cwd, worktreePath)`), so a false 'dead' verdict here
 * would let the sweep delete the worktree out from under a running session.
 * Liveness is surfaced as an annotation and callers opt in — see
 * {@link readLivePresenceFiles}.
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

  const now = Date.now();
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
        const info = parsed as PresenceFileInfo;
        const fields = parsed as Record<string, unknown>;
        records.push({
          ...info,
          path: filePath,
          liveness: classifyPidLiveness(fields['pid']),
          heartbeatAgeMs: heartbeatAge(fields['heartbeatAt'], now),
        });
      }
    } catch {
      // Malformed JSON or unreadable file — skip.
    }
  }
  return records;
}

/** Options for {@link readLivePresenceFiles}. */
export interface ReadLivePresenceOptions {
  /**
   * When set, additionally drop records whose heartbeat is older than this many
   * milliseconds. Records with no parseable heartbeat are KEPT — absence of a
   * heartbeat is not evidence of death, and pre-heartbeat records must stay
   * visible.
   */
  maxHeartbeatAgeMs?: number;
}

/**
 * Presence records for sessions that are plausibly still running.
 *
 * Opt-in counterpart to {@link readPresenceFiles}, for consumers that want a
 * "currently live sessions" list — a status UI, a session picker, a notifier —
 * without every existing caller silently changing behaviour.
 *
 * Drops only records proven dead (`liveness === 'dead'`). Records classified
 * `'unknown'` are RETAINED: an unusable pid means we could not determine
 * liveness, and hiding a running session is a worse failure than showing a stale
 * one.
 *
 * The bug this addresses: presence cleanup runs from
 * `process.once('exit'|'SIGINT'|'SIGTERM')`, none of which fire on SIGKILL or an
 * OOM kill, and nothing else reaps the directory. Before this, a crashed session
 * appeared live forever to every consumer.
 */
export async function readLivePresenceFiles(
  options: ReadLivePresenceOptions = {},
): Promise<PresenceRecord[]> {
  const records = await readPresenceFiles();
  const { maxHeartbeatAgeMs } = options;
  return records.filter((r) => {
    if (r.liveness === 'dead') return false;
    if (
      maxHeartbeatAgeMs !== undefined &&
      r.heartbeatAgeMs !== null &&
      r.heartbeatAgeMs > maxHeartbeatAgeMs
    ) {
      return false;
    }
    return true;
  });
}
