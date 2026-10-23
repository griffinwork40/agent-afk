/**
 * Ordered per-session turn log for file checkpoints
 * (`file-checkpoints/<sessionId>/turns.jsonl`).
 *
 * Invariant: append order IS chronological order, and the log is the only
 * source of that order (turn directories carry none). Three entry kinds:
 *
 *   - `turn`    — a user turn began with this checkpoint turnId. Written for
 *                 every checkpointed turn, including turns that touch no file.
 *   - `post`    — content hashes of the paths a turn touched, taken at turn
 *                 end. The expected on-disk state the drift guard compares to.
 *   - `restore` — content hashes written by a live rewind. A restore supersedes
 *                 earlier `post` hashes for the paths it rewrote.
 *
 * Rewinding to turn N folds the snapshots of every turn logged at or after
 * N's `turn` entry, earliest snapshot per path winning. That equals the state
 * at the start of turn N because a turn still present in the conversation can
 * only be followed in the log by turns (and rewinds) that started after it.
 *
 * Contract: appends are best-effort. A failed append degrades rewind to the
 * single-turn behaviour (turn not in log) or skips the drift check (no `post`),
 * never to a wrong restore.
 *
 * @module agent/file-checkpoint/turn-log
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { getFileCheckpointTurnLogPath } from '../../paths.js';
import { isEnoent } from '../../utils/errors.js';

/** Content hash per absolute path; `null` = the path did not exist. */
export type PathHashes = Record<string, string | null>;

/**
 * Outcome of a bash call during a checkpointed turn.
 *
 * `captured`  — foreground bash ran and git-snapshot captured its effects.
 * `partial`   — some effects were noted but the set is incomplete (e.g. the
 *               process was detached mid-run).
 * `skipped`   — no usable capture (disabled, background, non-git, timeout,
 *               error, or abort before spawn). Subagent calls have no registry.
 *
 * `files` is the count of paths published, including successful partial capture.
 * `reason` is a short human-readable explanation; absent when the status is
 * self-explanatory (e.g. `captured` with no caveats).
 */
export type BashLogEntry = {
  kind: 'bash';
  turnId: string;
  status: 'captured' | 'partial' | 'skipped';
  reason?: string;
  files?: number;
  ts: number;
};

export type TurnLogEntry =
  | { kind: 'turn'; turnId: string; ts: number }
  | { kind: 'post'; turnId: string; paths: PathHashes; ts: number }
  | { kind: 'restore'; paths: PathHashes; ts: number }
  | BashLogEntry;

/** SHA-256 of `bytes`, or `null` for an absent file. */
export function hashBytes(bytes: Buffer | null): string | null {
  return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
}

/** Hash of a path's current bytes; `null` when it does not exist. Throws on other I/O errors. */
export function currentHash(absPath: string): string | null {
  try { return hashBytes(readFileSync(absPath)); }
  catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** Append one entry. Best-effort: returns false instead of throwing. */
export function appendTurnLog(sessionId: string, entry: TurnLogEntry, stateDir?: string): boolean {
  try {
    const path = getFileCheckpointTurnLogPath(sessionId, stateDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Invariant: one appendFileSync call per line, so a crash leaves at most a
    // torn final line, which readTurnLog skips.
    appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function isEntry(value: unknown): value is TurnLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['kind'] === 'turn') return typeof v['turnId'] === 'string';
  if (v['kind'] === 'post') return typeof v['turnId'] === 'string' && typeof v['paths'] === 'object' && v['paths'] !== null;
  if (v['kind'] === 'restore') return typeof v['paths'] === 'object' && v['paths'] !== null;
  if (v['kind'] === 'bash') return typeof v['turnId'] === 'string' && (v['status'] === 'captured' || v['status'] === 'partial' || v['status'] === 'skipped');
  return false;
}

/** Read the log in append order. Missing log = `[]`; malformed lines are skipped. */
export function readTurnLog(sessionId: string, stateDir?: string): TurnLogEntry[] {
  let raw: string;
  try { raw = readFileSync(getFileCheckpointTurnLogPath(sessionId, stateDir), 'utf8'); }
  catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const entries: TurnLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) entries.push(parsed);
    } catch { /* torn or foreign line */ }
  }
  return entries;
}

/**
 * Turn ids from `turnId`'s `turn` entry to the end of the log, in order.
 * `undefined` when the turn was never logged (legacy checkpoint).
 */
export function turnsFrom(log: readonly TurnLogEntry[], turnId: string): string[] | undefined {
  const start = log.findIndex((e) => e.kind === 'turn' && e.turnId === turnId);
  if (start < 0) return undefined;
  const ids: string[] = [];
  for (const entry of log.slice(start)) {
    if (entry.kind === 'turn' && !ids.includes(entry.turnId)) ids.push(entry.turnId);
  }
  return ids;
}

/** Latest recorded hash per path across `post` and `restore` entries. */
export function expectedHashes(log: readonly TurnLogEntry[]): Map<string, string | null> {
  const expected = new Map<string, string | null>();
  for (const entry of log) {
    if (entry.kind === 'turn' || entry.kind === 'bash') continue;
    for (const [path, hash] of Object.entries(entry.paths)) expected.set(path, hash as string | null);
  }
  return expected;
}

/** Hash each path now; paths that cannot be read are omitted (no expectation recorded). */
export function hashPaths(paths: Iterable<string>): PathHashes {
  const out: PathHashes = {};
  for (const path of paths) {
    try { out[path] = currentHash(path); } catch { /* unreadable: no drift baseline */ }
  }
  return out;
}
