/**
 * Age-based retention for per-session directories (`sessions/<id>/`).
 *
 * The flat-sidecar sweep (session-sidecar-sweep.ts) evicts `<id>.json` files;
 * this sibling pass evicts the `<id>/` directories beside them: the ledger
 * (`events.jsonl`), message journal (`journal.jsonl`), `blobs/`,
 * `subagents/`, `compose/`, `subagent-handoffs/`, and so on.
 *
 * Rules (same as the witness sweep):
 *   - The active session's directory is excluded by identity.
 *   - Age is the newest mtime across the directory's CONTENTS, walked
 *     recursively, not the directory's own mtime (POSIX does not bump a
 *     directory's mtime when a file inside it is appended to).
 *   - Anything touched inside the grace window is kept.
 *   - Directories older than `maxAgeMs` (AFK_SESSION_MAX_AGE_DAYS) are removed.
 *
 * Fork safety: a forked journal references its parent's blobs by path
 * (`BlobRef.path` is relative to the sessions root), so a directory that a
 * surviving journal names as its `forkedFrom` parent is kept too, transitively.
 * The ACTIVE session is part of that scan (it is never removed, but its own
 * `forkedFrom` chain is protected): the sweep runs at start-up of the session
 * that may itself be a `/fork` child of a long-idle parent.
 *
 * @module agent/session-sidecar-sweep.dirs
 */

import { open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { newestMtimeAndBytes } from './_lib/dir-newest-mtime.js';
import { isSafeLedgerSessionId } from '../paths.js';

export interface SessionDirSweepOptions {
  root: string;
  now: number;
  maxAgeMs: number;
  graceMs: number;
  activeSessionId?: string;
  /** @internal test seam */
  _rm?: (path: string) => Promise<void>;
}

interface DirRecord { id: string; path: string; newestMtimeMs: number; active?: boolean }

/** Bytes read from the head of journal.jsonl to find the `meta` record. */
const META_HEAD_BYTES = 8 * 1024;

/** The `forkedFrom.sessionId` in a journal's first (meta) line, if any. */
async function readForkParent(dir: string): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(join(dir, 'journal.jsonl'), 'r');
    const buf = Buffer.alloc(META_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, META_HEAD_BYTES, 0);
    const firstLine = buf.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? '';
    const rec = JSON.parse(firstLine) as { kind?: unknown; forkedFrom?: { sessionId?: unknown } };
    const parent = rec.kind === 'meta' ? rec.forkedFrom?.sessionId : undefined;
    return typeof parent === 'string' ? parent : undefined;
  } catch {
    return undefined; // no journal, truncated/oversized meta line, or corrupt JSON
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Un-doom any directory that a surviving journal forked from (fixpoint). */
async function protectForkParents(all: DirRecord[], doomed: Set<string>): Promise<void> {
  const parentOf = new Map<string, string | undefined>();
  let changed = true;
  while (changed && doomed.size > 0) {
    changed = false;
    for (const d of all) {
      if (doomed.has(d.id)) continue;
      if (!parentOf.has(d.id)) parentOf.set(d.id, await readForkParent(d.path));
      const parent = parentOf.get(d.id);
      if (parent !== undefined && doomed.delete(parent)) changed = true;
    }
  }
}

/**
 * Remove stale `sessions/<id>/` directories. Returns the number removed.
 * Best-effort and never throws.
 */
export async function sweepSessionDirs(opts: SessionDirSweepOptions): Promise<number> {
  try {
    const entries = await readdir(opts.root, { withFileTypes: true });
    const all: DirRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSafeLedgerSessionId(entry.name)) continue;
      const path = join(opts.root, entry.name);
      if (entry.name === opts.activeSessionId) {
        // Never a removal candidate, but its fork chain must be protected.
        all.push({ id: entry.name, path, newestMtimeMs: opts.now, active: true });
        continue;
      }
      try {
        all.push({ id: entry.name, path, ...(await newestMtimeAndBytes(path)) });
      } catch {
        /* raced away mid-walk — skip */
      }
    }

    const isStale = (mtimeMs: number): boolean => {
      const ageMs = Math.max(0, opts.now - mtimeMs);
      return ageMs >= opts.graceMs && ageMs > opts.maxAgeMs;
    };
    const doomed = new Set(all.filter((d) => !d.active && isStale(d.newestMtimeMs)).map((d) => d.id));
    await protectForkParents(all, doomed);

    const rmFn = opts._rm ?? ((p: string) => rm(p, { recursive: true, force: true }));
    let removed = 0;
    for (const d of all) {
      if (d.active || !doomed.has(d.id)) continue;
      try {
        // Race guard: re-walk right before removal; a write since enumeration
        // means the session came back to life — leave it for the next sweep.
        const fresh = await newestMtimeAndBytes(d.path);
        if (fresh.newestMtimeMs !== d.newestMtimeMs) continue;
        await rmFn(d.path);
        removed += 1;
      } catch {
        /* raced away or permission error — leave for the next sweep */
      }
    }
    return removed;
  } catch {
    return 0;
  }
}
