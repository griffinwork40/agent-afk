/**
 * Session save/load — JSON sidecar files at ~/.afk/state/sessions/<id>.json.
 *
 * Each sidecar stores a session's `sessionId`, optional human `name`, model,
 * start time, turn history, and totals. Files are ALWAYS keyed by the SDK
 * `sessionId` (falling back to a timestamp id when none is known yet); the
 * `name` is metadata INSIDE the file, never the filename, so renaming a
 * session never forks a duplicate sidecar.
 *
 * Resume is client-side replay, not server-side restoration — there is no SDK
 * or server session store. `--resume <id|name>` / `/resume` read this sidecar
 * and the provider reconstructs the conversation by replaying `turns[]` as
 * `resumeHistory` (see resume-session.ts → resumeConfigFor). Only user/
 * assistant TEXT survives replay; tool calls and thinking blocks do not.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, realpathSync } from 'fs';
import { join, basename, resolve, sep } from 'path';
import { randomUUID } from 'node:crypto';
import { ensureSessionsMigrated, getSessionsDir } from '../paths.js';
import type { SessionStats, TurnRecord } from './slash/types.js';
import type { AgentModelInput } from '../agent/types.js';
import type { TraceActor } from '../agent/session/session-identity.js';

export interface StoredSession {
  sessionId?: string;
  /** Human-readable session name (kebab-case). Optional — absent on legacy
   * sidecars saved before naming existed; those resolve by id/sessionId. */
  name?: string;
  /** Origin surface ('cli' | 'telegram' | 'daemon'). Absent on legacy sidecars → 'cli'. */
  source?: 'cli' | 'telegram' | 'daemon';
  /** Telegram chat id when source === 'telegram' (reverse lookup). */
  telegramChatId?: number;
  model: AgentModelInput;
  startedAt: number;
  savedAt: number;
  totalTurns: number;
  totalCostUsd: number;
  totalTokens: number;
  totalDurationMs: number;
  turns: TurnRecord[];
  /** Provenance: the sessionId this session was forked from (set by /fork). */
  forkedFrom?: string;
  /** Wall-clock time the fork was created (set by /fork). */
  forkedAt?: number;
  /** Execution role ('main' | 'subagent'). Sidecars are top-level-only, so
   *  'main' when set; absent on legacy/un-threaded saves. */
  actor?: TraceActor;
  /** Effective working directory when the session was started. Used by /resume
   * to filter the list to sessions from the current directory. Absent on
   * legacy sidecars — those surface only in the global fallback view. */
  cwd?: string;
}

export interface SessionListEntry {
  path: string;
  id: string;   // derived from the filename
  sessionId?: string;
  name?: string;
  source?: 'cli' | 'telegram' | 'daemon';
  actor?: TraceActor;
  model: AgentModelInput;
  startedAt: number;
  savedAt: number;
  totalTurns: number;
  totalCostUsd: number;
  cwd?: string;
}

export interface FoundSession {
  path: string;
  id: string;
  data: StoredSession;
}

function sessionsDir(): string {
  ensureSessionsMigrated();
  return getSessionsDir();
}

function pathForId(id: string): string {
  return join(sessionsDir(), `${id}.json`);
}

/**
 * Resolves a caller-supplied id-or-path and asserts it is contained within
 * sessionsDir(). Returns the resolved absolute path, or throws if the path
 * escapes the sessions directory. Guards against traversal attacks such as
 * --resume ../../../etc/passwd or --resume /etc/passwd.
 *
 * Invariant: When `raw` already exists, both `raw` and `sessionsDir()` are
 * resolved through `realpathSync` so a symlink inside the sessions dir
 * pointing to e.g. /etc/sensitive is rejected. Both sides must live in the
 * same canonical-path space — on macOS `/tmp` is itself a symlink to
 * `/private/tmp`, so mixing lexical and canonical paths false-positives.
 *
 * For non-existing destinations (write paths, missing reads) both sides
 * use lexical resolve. Lexical resolve still blocks `..` traversal and
 * absolute-path escapes; it cannot resolve symlinks that don't exist yet,
 * which is acceptable — an attacker can't pre-plant a link at a
 * not-yet-created path the writer will create.
 */
function safeResolvePath(
  idOrPath: string,
  { write = false }: { write?: boolean } = {},
): string {
  const raw = idOrPath.includes('/') ? idOrPath : pathForId(idOrPath);
  let resolved: string;
  let dir: string;
  if (!write && existsSync(raw)) {
    resolved = realpathSync(raw);
    dir = realpathSync(sessionsDir());
  } else {
    resolved = resolve(raw);
    dir = resolve(sessionsDir());
  }
  if (!resolved.startsWith(dir + sep) && resolved !== dir) {
    throw new Error(`Session path escapes sessions directory: ${idOrPath}`);
  }
  return resolved;
}

/**
 * Write the current session stats to disk. Uses the SDK sessionId when
 * present; otherwise falls back to a timestamped ID. Returns the path written.
 */
export function saveSession(stats: SessionStats, overrideId?: string): string {
  const dir = sessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const id = overrideId ?? stats.sessionId ?? `session-${Date.now()}`;
  const payload: StoredSession = {
    sessionId: stats.sessionId,
    ...(stats.name ? { name: stats.name } : {}),
    ...(stats.source ? { source: stats.source } : {}),
    ...(stats.actor ? { actor: stats.actor } : {}),
    ...(stats.telegramChatId !== undefined ? { telegramChatId: stats.telegramChatId } : {}),
    ...(stats.cwd ? { cwd: stats.cwd } : {}),
    model: stats.model,
    startedAt: stats.sessionStartTime,
    savedAt: Date.now(),
    totalTurns: stats.totalTurns,
    totalCostUsd: stats.totalCostUsd,
    totalTokens: stats.totalTokens,
    totalDurationMs: stats.totalDurationMs,
    turns: stats.turns,
  };
  // Validate write destination — pathForId(id) calls path.join() which does
  // NOT block traversal; `id = '../../evil'` would otherwise escape the
  // sessions dir. safeResolvePath rejects on prefix mismatch.
  const path = safeResolvePath(id, { write: true });
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

/** Fork the current in-memory session into a new, independent sidecar (for /fork). */
export function forkStoredSession(
  stats: SessionStats,
  opts: { newId?: string } = {},
): { id: string; path: string } {
  const dir = sessionsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const newId = opts.newId ?? randomUUID();

  // Invariant: the fork MUST receive a fresh sessionId — never the parent's.
  // On graceful exit the REPL persists the live session via saveSession(stats),
  // keyed by stats.sessionId (interactive.ts cleanup). If the fork reused the
  // parent's sessionId, the still-running parent and the forked child would
  // both flush to the same <sessionId>.json on exit — a last-writer-wins race
  // that silently destroys one of the two conversations. A fresh UUID used as
  // BOTH the filename id and the stored sessionId mirrors how every normal
  // sidecar looks (filename == sessionId) and guarantees the two sessions can
  // never collide on disk. Fidelity note: the fork carries exactly what
  // `--resume` carries — resumeHistoryToMessages replays user/assistant text
  // turns only. In-flight execution context (live subagents, background shell
  // jobs, tool-call structure) belongs to no sidecar and is therefore not
  // forked; this is the same contract every `--resume` already honours.
  const payload: StoredSession = {
    sessionId: newId,
    model: stats.model,
    startedAt: stats.sessionStartTime,
    savedAt: Date.now(),
    totalTurns: stats.totalTurns,
    totalCostUsd: stats.totalCostUsd,
    totalTokens: stats.totalTokens,
    totalDurationMs: stats.totalDurationMs,
    turns: [...stats.turns],
    // Preserve the session's cwd so a forked sidecar records where it was
    // running (e.g. an `afk --worktree` session). Without this, resuming the
    // fork lands in the launch cwd instead of the worktree. Mirrors saveSession.
    ...(stats.cwd ? { cwd: stats.cwd } : {}),
    ...(stats.sessionId ? { forkedFrom: stats.sessionId } : {}),
    forkedAt: Date.now(),
  };
  const path = safeResolvePath(newId, { write: true });
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return { id: newId, path };
}

/** Load a single saved session by id or absolute path. */
export function loadSession(idOrPath: string): StoredSession | undefined {
  let path: string;
  try {
    path = safeResolvePath(idOrPath);
  } catch {
    return undefined;
  }
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as StoredSession;
  } catch {
    return undefined;
  }
}

/** Find a saved session by sidecar id, absolute path, SDK session id, or human name. */
export function findSession(idOrName: string): FoundSession | undefined {
  let directPath: string;
  try {
    directPath = safeResolvePath(idOrName);
  } catch {
    return undefined;
  }
  const direct = loadSession(directPath);
  if (direct) {
    return {
      path: directPath,
      id: basename(directPath, '.json'),
      data: direct,
    };
  }

  const entries = listSessions();
  // Exact match on sidecar id, SDK session id, or human name (newest first,
  // since listSessions is sorted by savedAt descending).
  for (const entry of entries) {
    if (entry.id !== idOrName && entry.sessionId !== idOrName && entry.name !== idOrName) continue;
    const data = loadSession(entry.path);
    if (!data) continue;
    return {
      path: entry.path,
      id: entry.id,
      data,
    };
  }

  // Convenience fallback: a unique NAME prefix (so `--resume fix-tele`
  // resolves `fix-telegram-resume`). Two guards prevent silently resuming the
  // wrong session: (1) the input must be at least MIN_PREFIX_MATCH_LEN chars,
  // so a 1–2 char input like `--resume a` can never prefix-match an arbitrary
  // session; (2) the prefix must be unambiguous (match exactly one name).
  const MIN_PREFIX_MATCH_LEN = 3;
  if (idOrName.length >= MIN_PREFIX_MATCH_LEN) {
    const prefixMatches = entries.filter(
      (e) => e.name !== undefined && e.name.startsWith(idOrName),
    );
    if (prefixMatches.length === 1) {
      const only = prefixMatches[0];
      if (only) {
        const data = loadSession(only.path);
        if (data) return { path: only.path, id: only.id, data };
      }
    }
  }
  return undefined;
}

/** List saved sessions, newest first. */
export function listSessions(): SessionListEntry[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const entries: SessionListEntry[] = [];
  for (const fname of readdirSync(dir)) {
    if (!fname.endsWith('.json')) continue;
    const full = join(dir, fname);
    try {
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      const loaded = loadSession(full);
      if (!loaded) continue;
      // Skip files that aren't AFK session saves — /resume expects these
      // fields to exist on every persisted session entry.
      if (typeof loaded.savedAt !== 'number' || typeof loaded.model !== 'string') continue;
      entries.push({
        path: full,
        id: basename(fname, '.json'),
        sessionId: loaded.sessionId,
        name: loaded.name,
        source: loaded.source,
        actor: loaded.actor,
        model: loaded.model,
        startedAt: loaded.startedAt,
        savedAt: loaded.savedAt,
        totalTurns: loaded.totalTurns,
        totalCostUsd: loaded.totalCostUsd,
        cwd: loaded.cwd,
      });
    } catch {
      // skip corrupted files
    }
  }
  entries.sort((a, b) => b.savedAt - a.savedAt);
  return entries;
}

/** Find the SDK sessionId for a given short id or human name. Used by the --resume flag. */
export function sdkSessionIdFor(idOrName: string): string | undefined {
  const byId = loadSession(idOrName);
  if (byId?.sessionId) return byId.sessionId;
  // Scan all saved sessions for a matching SDK sessionId, sidecar id, or name.
  for (const entry of listSessions()) {
    if (entry.sessionId === idOrName) return entry.sessionId;
    if (entry.id === idOrName) return entry.sessionId;
    if (entry.name === idOrName) return entry.sessionId;
  }
  return undefined;
}
