/**
 * Per-session artifact directory for SkillPreflight outputs.
 *
 * Lives under ~/.afk/state/skill-preflight/<sessionId>/ so preflights can
 * write stable files (PR diffs, gathered metadata, etc.) the model can
 * reference by absolute path without re-fetching.
 *
 * `sessionId` is best-effort — the AgentSession exposes it post-init, but
 * the slash handler may fire before init completes (rare). When the id
 * isn't yet available, we fall back to a random 16-hex-char token so two
 * concurrent REPLs don't clobber each other and no exploitable identifier
 * leaks via the directory name.
 *
 * **Disk lifecycle.** The TTL prune (`pruneStaleDirs`) runs at most once per
 * `PRUNE_INTERVAL_MS` per process via `lastPruneAt`. The prune is fire-and-
 * forget (via `setImmediate`) so it never blocks the calling preflight.
 */

import { mkdirSync, readdirSync, rmSync, lstatSync } from 'fs';
import { join, resolve, sep } from 'path';
import { randomBytes } from 'crypto';
import { getAfkStateDir } from '../../../paths.js';
import { debugLog } from '../../../utils/debug.js';

/**
 * F04: Tighter session-ID allowlist — only UUID/hex characters and hyphens,
 * minimum 8 characters, maximum 128. Rejects path-traversal, whitespace,
 * underscores, and any other character not present in UUID-style identifiers.
 */
const SESSION_ID_RE = /^[0-9a-f-]{8,128}$/i;

/** Directories older than this are pruned. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * P01: Rate-limit the prune scan to at most once per 5 minutes per process.
 * The prune is a best-effort background task (setImmediate) — blocking the
 * event loop on every preflight invocation was unnecessary.
 */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastPruneAt = 0;

/** Reset prune rate-limit. Test-only. */
export function _resetPruneStateForTests(): void {
  lastPruneAt = 0;
}

/**
 * Prune subdirectories of `root` whose `mtime` is older than `ttlMs`.
 * Runs best-effort — individual entry errors are logged at warn level
 * (P05) so a stale or permission-denied entry never blocks the caller.
 *
 * F05: uses `lstatSync` instead of `statSync` so symlinks are not followed
 * during the existence check / age check — a symlink pointing at a real
 * directory would otherwise be treated as a pruneable directory entry.
 */
export function pruneStaleDirs(root: string, ttlMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    // root doesn't exist yet — nothing to prune
    return;
  }
  const cutoff = Date.now() - ttlMs;
  for (const entry of entries) {
    const full = join(root, entry);
    try {
      // F05: lstatSync — does NOT follow symlinks, so a symlink to a real
      // directory is stat'd as a symlink (isDirectory() → false) and skipped.
      const st = lstatSync(full);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch (err) {
      // P05: log at warn level with the offending path instead of silently
      // swallowing — helps operators diagnose permission or fs issues.
      debugLog(
        `[afk preflight] warn: pruneStaleDirs failed to remove "${full}": ` +
        (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

export function getSkillPreflightDir(sessionId: string | undefined): string {
  const raw = sessionId && sessionId.length > 0 ? sessionId : undefined;
  const id = raw !== undefined && SESSION_ID_RE.test(raw)
    ? raw
    // F07: use crypto.randomBytes instead of process.pid — the pid is
    // predictable and leaks process identity; a random token is collision-
    // resistant without revealing anything exploitable.
    : `unbound-${randomBytes(8).toString('hex')}`;
  const root = join(getAfkStateDir(), 'skill-preflight');

  // F04: assert the resolved dir stays inside root before any filesystem op —
  // defense-in-depth against path-traversal even when SESSION_ID_RE passes.
  const resolvedRoot = resolve(root);
  const resolvedDir = resolve(join(root, id));
  if (!resolvedDir.startsWith(resolvedRoot + sep)) {
    // This should never happen when SESSION_ID_RE is enforced, but belt-and-suspenders.
    throw new Error(
      `[afk preflight] Path traversal detected: resolved dir "${resolvedDir}" escapes root "${resolvedRoot}".`,
    );
  }

  // P01: Rate-limited, fire-and-forget prune. The prune runs via setImmediate
  // so it never blocks the current synchronous mkdirSync call below.
  // External constraint: setImmediate fires after I/O callbacks in the current
  // event-loop iteration — the directory we create below is already on disk
  // before the prune could possibly touch it.
  const now = Date.now();
  if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
    lastPruneAt = now;
    // Capture root in closure so the deferred call uses the resolved value.
    const capturedRoot = root;
    setImmediate(() => {
      pruneStaleDirs(capturedRoot, TTL_MS);
    });
  }

  mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });

  // F06: verify the created path is a real directory (not a symlink) owned
  // by the current process. Throws if the inode is a symlink or other
  // non-directory type — prevents TOCTOU attacks where a symlink is swapped
  // in between mkdirSync and the first write.
  const postStat = lstatSync(resolvedDir);
  if (!postStat.isDirectory()) {
    throw new Error(
      `[afk preflight] Expected a real directory at "${resolvedDir}" but got mode ${postStat.mode.toString(8)}.`,
    );
  }
  // UID check: only enforce when running as a non-root user.
  // process.getuid is POSIX-only; skip on Windows.
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    if (postStat.uid !== process.getuid()) {
      throw new Error(
        `[afk preflight] Directory "${resolvedDir}" is owned by uid ${postStat.uid}, expected ${process.getuid()}.`,
      );
    }
  }

  return resolvedDir;
}
