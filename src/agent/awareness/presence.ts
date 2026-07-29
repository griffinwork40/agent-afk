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
import { unlinkSync, existsSync, mkdirSync, writeFileSync } from 'fs';
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
  /**
   * ISO 8601 timestamp of the moment this session began waiting on a human. Set
   * by {@link setPresenceBlocked} when an elicitation is about to prompt the
   * operator, and cleared the instant it settles (answer, skip, decline, cancel,
   * or turn abort).
   *
   * Present ⇒ the session is blocked on a human RIGHT NOW; absent ⇒ it is not.
   * This is the on-disk trace of an event that previously had none: the
   * elicitation router's only outward signal was a best-effort Telegram push, so
   * an out-of-process observer (a native app polling {@link readPresenceFiles})
   * could not see that an agent was stuck waiting.
   *
   * A timestamp rather than a boolean deliberately: it lets a reader render
   * "waiting 4m" and age out a marker that a hard-killed session never cleared.
   * Treat it as advisory and cross-check `liveness` — a `blockedSince` on a dead
   * pid is a leftover, not a live prompt.
   *
   * Distinct from {@link afk}: `afk` is a remote-control posture the operator
   * sets and unsets, while `blockedSince` is runtime-set and true only for the
   * duration of one pending prompt. Both may be present at once.
   *
   * Optional/additive (no {@link PRESENCE_SCHEMA_VERSION} bump): absent on
   * records written before this field existed and on any session not currently
   * waiting.
   */
  blockedSince?: string;
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
 *
 * `mode: 0o700` — presence records include `cwd`, `pid`, and (for AFK
 * sessions) an `afk` posture marker; a default umask would otherwise leave
 * the directory (and, by extension, every file mkdir creates under it)
 * world-readable. `recursive: true` no-ops the mode on an already-existing
 * directory (Node does not chmod on the recursive/no-op path), so this only
 * takes effect on first creation — existing installs are unaffected until
 * the dir is recreated.
 */
async function ensurePresenceDir(): Promise<boolean> {
  try {
    await mkdir(getPresenceDir(), { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

// Invariant: presence writes for ONE session must land on disk in call order.
// Every mutator below is a read → modify → write cycle that awaits between the
// read and the write, so two overlapping calls for the same session both read
// the pre-mutation record and the later write silently drops the earlier
// mutation. This is not hypothetical for `blockedSince`: the elicitation router
// fires its set and its paired clear WITHOUT awaiting either
// (elicitation-router.ts:199,206) so telemetry can never delay an operator
// prompt. A prompt that settles before the set's I/O completes therefore raced
// its own clear — landing the set last strands a permanent "waiting on you"
// marker, and landing a previous prompt's clear last erases the marker of the
// next queued prompt. Both are the exact failure the set/clear pairing exists
// to prevent, and neither is reachable once the writes are ordered.
//
// Serializing per session rather than globally keeps unrelated sessions
// independent: one wedged filesystem write cannot stall another session's
// heartbeat. Every writer routes through here, so the fix also closes the
// pre-existing lost-update race between `touchPresenceHeartbeat` and the other
// mutators. `removePresenceFileSync` is deliberately NOT enrolled — it runs in
// a process-exit handler where a promise queue cannot be drained.
const presenceWriteTails = new Map<string, Promise<void>>();

/**
 * Chain `mutate` onto this session's serialized write tail and resolve once it
 * has run. Rejection of a predecessor never blocks a successor (`mutate` runs on
 * both settle paths); every caller's own body swallows its errors, so the tail
 * itself is not expected to reject.
 */
function enqueuePresenceWrite(sessionId: string, mutate: () => Promise<void>): Promise<void> {
  const previous = presenceWriteTails.get(sessionId) ?? Promise.resolve();
  const tail = previous.then(mutate, mutate);
  presenceWriteTails.set(sessionId, tail);
  // Drop the entry once this call is the last one queued, so a long-lived
  // process hosting many short sessions does not retain a promise per session
  // forever. The identity check is what makes eviction safe: a later enqueue has
  // already replaced the entry, and that newer tail must survive.
  void tail.catch(() => undefined).then(() => {
    if (presenceWriteTails.get(sessionId) === tail) presenceWriteTails.delete(sessionId);
  });
  return tail;
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
  return enqueuePresenceWrite(info.sessionId, async () => {
    try {
      const ok = await ensurePresenceDir();
      if (!ok) return;
      // mode: 0o600 — presence records carry cwd/pid/afk-posture; a default
      // umask would otherwise leave them world-readable (every mutator below
      // matches this mode so a read-modify-write cannot loosen it back up).
      await writeFile(presenceFilePath(info.sessionId), serializePresenceRecord(info), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      // Best-effort — swallow silently.
    }
  });
}

/**
 * Stamp the schema version and an initial heartbeat HERE rather than at the call
 * sites: more than one provider writes presence (anthropic-direct and
 * openai-compatible), so a per-caller stamp would silently miss a writer the
 * moment a third surface is added. Caller-supplied values win, which keeps tests
 * able to pin a specific version or heartbeat.
 *
 * Shared by the async and sync writers so the two cannot drift in record shape.
 */
function serializePresenceRecord(info: PresenceFileInfo): string {
  const record: PresenceFileInfo = {
    schemaVersion: PRESENCE_SCHEMA_VERSION,
    heartbeatAt: new Date().toISOString(),
    ...info,
  };
  return JSON.stringify(record, null, 2);
}

/**
 * Synchronous variant of {@link writePresenceFile}, for the session's INITIAL
 * advertisement.
 *
 * Invariant: this write must be complete before the call that triggered it
 * returns. It is issued from `registerPresenceLifecycle` inside a provider's
 * `query()`, and both providers expose a synchronous `close()`, so an async
 * write has no handle anything can await — it outlives the turn that started it.
 * Two concrete failures followed from that. (1) A host that points `AFK_HOME` at
 * a scratch dir and removes it right after a turn races the in-flight write and
 * gets `ENOTEMPTY` on teardown, because the write recreates `presence/` while
 * the tree is being walked. (2) `setPresenceAfk` is a read-modify-write that
 * swallows `ENOENT`, so an `/afk on` issued immediately after session start
 * could land BEFORE the initial file existed and silently no-op, leaving the
 * operator's posture unset. Writing synchronously removes both: the file exists
 * before `query()` proceeds, and every queued mutator necessarily runs after it.
 *
 * Deliberately NOT enrolled in the `presenceWriteTails` queue — it is the first
 * operation for this session id, and completing inline means later async
 * mutators serialize behind an already-durable file rather than racing it.
 *
 * Best-effort and never throws, matching the async writer.
 */
export function writePresenceFileSync(info: PresenceFileInfo): void {
  try {
    mkdirSync(getPresenceDir(), { recursive: true, mode: 0o700 });
    writeFileSync(presenceFilePath(info.sessionId), serializePresenceRecord(info), {
      encoding: 'utf8',
      mode: 0o600,
    });
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
  return enqueuePresenceWrite(sessionId, async () => {
    try {
      const filePath = presenceFilePath(sessionId);
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PresenceFileInfo;
      parsed.heartbeatAt = new Date().toISOString();
      await writeFile(filePath, JSON.stringify(parsed, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Best-effort — presence is non-critical.
    }
  });
}

/**
 * Update the `afk` marker on an existing presence file (best-effort,
 * read-modify-write). Used by the REPL `/afk` toggle so a watching Telegram
 * daemon can discover AFK sessions via `readPresenceFiles()`. No-op when the
 * presence file is absent or unreadable (presence is non-critical — the
 * keyboard elicitation path works regardless). Preserves every other field.
 */
export async function setPresenceAfk(sessionId: string, afk: boolean): Promise<void> {
  return enqueuePresenceWrite(sessionId, async () => {
    try {
      const filePath = presenceFilePath(sessionId);
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PresenceFileInfo;
      parsed.afk = afk;
      await writeFile(filePath, JSON.stringify(parsed, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Best-effort — presence is non-critical.
    }
  });
}

/**
 * Set or clear the {@link PresenceFileInfo.blockedSince} marker on an existing
 * presence file (best-effort, read-modify-write).
 *
 * Called from the elicitation router around a prompt the operator is actually
 * about to see: `blocked: true` immediately before the handler runs, `false` the
 * instant it settles. `true` stamps `new Date().toISOString()`; `false` deletes
 * the key entirely, so "not waiting" is represented by absence rather than by a
 * sentinel a reader would have to interpret.
 *
 * Idempotent, and safe to call for a session that has no presence file —
 * subagents never have one, and every non-top-level surface routes elicitations
 * through the same code path. No-op when the file is absent or unreadable.
 * Preserves every other field.
 *
 * Never throws: an elicitation must not fail because presence telemetry could
 * not be written. A dropped clear is bounded by the caller's `liveness` check
 * and by presence-file removal at process exit.
 */
export async function setPresenceBlocked(sessionId: string, blocked: boolean): Promise<void> {
  return enqueuePresenceWrite(sessionId, async () => {
    try {
      const filePath = presenceFilePath(sessionId);
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PresenceFileInfo;
      if (blocked) {
        parsed.blockedSince = new Date().toISOString();
      } else {
        delete parsed.blockedSince;
      }
      await writeFile(filePath, JSON.stringify(parsed, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Best-effort — presence is non-critical.
    }
  });
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
  return enqueuePresenceWrite(sessionId, async () => {
    try {
      const filePath = presenceFilePath(sessionId);
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PresenceFileInfo;
      parsed.cwd = cwd;
      await writeFile(filePath, JSON.stringify(parsed, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Best-effort — presence is non-critical.
    }
  });
}

/**
 * Asynchronously delete a presence file by session ID.
 *
 * Safe to call even if the file does not exist (ENOENT is swallowed).
 * All other errors are also swallowed — presence cleanup is best-effort.
 *
 * Enrolled in the same per-session write tail as the mutators: an unordered
 * delete racing an in-flight read-modify-write lets the mutator's `writeFile`
 * resurrect the file after the unlink, leaving a presence record for an exited
 * session that `readPresenceFiles()` then reports with a dead pid.
 */
export async function removePresenceFile(sessionId: string): Promise<void> {
  return enqueuePresenceWrite(sessionId, async () => {
    try {
      await unlink(presenceFilePath(sessionId));
    } catch {
      // ENOENT or any other error — swallow.
    }
  });
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
