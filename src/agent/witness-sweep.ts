/**
 * Bounded retention for the witness tree (`$AFK_STATE_DIR/witness/`).
 *
 * Nothing pruned this tree before: the trace writer, compaction sidecars, and
 * the opt-in prompt/output captures all appended forever. On one developer
 * machine it reached 546 MB / 13,052 directories with no opt-in artifact even
 * enabled (#849). This module is the sibling of `log-retention.ts` for a tree
 * of directories rather than a single JSONL file, and is the standing gate on
 * ever defaulting `AFK_CAPTURE_SUBAGENT_PROMPTS` / `_OUTPUT` to on.
 *
 * Retention unit is the WHOLE session directory. Per-artifact caps inside a
 * session were rejected: a trace stripped of its sidecars is a more confusing
 * forensic record than no trace at all.
 *
 * @module agent/witness-sweep
 */

import { readdir, stat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from '../config/env.js';
import { getWitnessRoot } from '../paths.js';

/** Evict a session directory once its newest content is older than this. */
export const WITNESS_MAX_AGE_DAYS_DEFAULT = 30;

/** Evict oldest-first once the tree exceeds this many bytes in aggregate. */
export const WITNESS_MAX_BYTES_DEFAULT = 2 * 1024 * 1024 * 1024; // 2 GiB

/**
 * A directory whose newest content falls inside this window is never evicted,
 * regardless of the bounds. Covers concurrent sessions (REPL + daemon +
 * telegram all write here) whose labels this process cannot enumerate.
 */
export const WITNESS_EVICTION_GRACE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Minimum wall-clock gap between two sweeps, tracked by a stamp file in the
 * witness root. This is what bounds the sweep's cost: the walk is O(files in
 * the tree), so without a stamp every session start on a 13k-directory tree
 * would re-walk it.
 */
export const WITNESS_SWEEP_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

const STAMP_FILE = '.last-sweep';

export interface WitnessSweepOptions {
  /** Witness root to sweep. Defaults to the canonical `getWitnessRoot()`. */
  root?: string;
  /**
   * Label of the session running the sweep. Excluded by IDENTITY, never by
   * timestamp — see the mtime note on {@link newestMtimeAndBytes}.
   */
  activeLabel?: string | undefined;
  maxAgeDays?: number;
  maxBytes?: number;
  /** Bypass the inter-sweep stamp. Tests and explicit operator runs only. */
  force?: boolean;
}

export interface WitnessSweepResult {
  /** True when the stamp (or the disable switch) short-circuited the run. */
  skipped: boolean;
  scanned: number;
  evicted: number;
  freedBytes: number;
  /** Labels actually removed, oldest-first. */
  evictedLabels: string[];
}

const noop = (): WitnessSweepResult => ({
  skipped: true, scanned: 0, evicted: 0, freedBytes: 0, evictedLabels: [],
});

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface DirStats { newestMtimeMs: number; bytes: number }

// Invariant: a directory's OWN mtime is not a usable liveness signal here.
// POSIX bumps a directory's mtime when an entry is created or unlinked, but NOT
// when an existing file inside it is appended to. A long-running session that
// creates no new sidecars (no subagents, no compaction) therefore keeps
// appending to trace.jsonl while its directory mtime stays frozen at creation
// time — so an mtime-only sweep would evict a LIVE session's trace out from
// under it. Liveness must come from the newest mtime across the directory's
// CONTENTS, and the active session is additionally excluded by identity so its
// survival never depends on this walk being right.
async function newestMtimeAndBytes(dir: string): Promise<DirStats> {
  let newestMtimeMs = 0;
  let bytes = 0;
  const walk = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      try {
        const st = await stat(child);
        bytes += st.size;
        if (st.mtimeMs > newestMtimeMs) newestMtimeMs = st.mtimeMs;
      } catch {
        /* raced away mid-walk — ignore */
      }
    }
  };
  await walk(dir);
  if (newestMtimeMs === 0) {
    // No files at all (empty or freshly-created dir). Fall back to the
    // directory's own mtime so an empty dir is not treated as epoch-old.
    try {
      newestMtimeMs = (await stat(dir)).mtimeMs;
    } catch {
      newestMtimeMs = Date.now();
    }
  }
  return { newestMtimeMs, bytes };
}

/** True when the stamp says a sweep ran recently enough to skip this one. */
async function sweptRecently(root: string, now: number): Promise<boolean> {
  try {
    const st = await stat(join(root, STAMP_FILE));
    return now - st.mtimeMs < WITNESS_SWEEP_MIN_INTERVAL_MS;
  } catch {
    return false; // no stamp yet — sweep.
  }
}

/**
 * Sweep the witness tree, evicting whole session directories that exceed the
 * age bound, then oldest-first until the aggregate byte bound is met.
 *
 * Contract: best-effort and never throws — a missing root, permission error,
 * or mid-walk race resolves to a zeroed result. Retention housekeeping must
 * never be able to fail a session start.
 */
export async function sweepWitnessTree(
  options: WitnessSweepOptions = {},
): Promise<WitnessSweepResult> {
  if (env.AFK_WITNESS_RETENTION_DISABLE === '1') return noop();

  const root = options.root ?? getWitnessRoot();
  const now = Date.now();

  try {
    if (options.force !== true && (await sweptRecently(root, now))) return noop();

    const maxAgeMs =
      positiveNumber(
        options.maxAgeDays?.toString() ?? env.AFK_WITNESS_MAX_AGE_DAYS,
        WITNESS_MAX_AGE_DAYS_DEFAULT,
      ) * 24 * 60 * 60 * 1000;
    const maxBytes = positiveNumber(
      options.maxBytes?.toString() ?? env.AFK_WITNESS_MAX_BYTES,
      WITNESS_MAX_BYTES_DEFAULT,
    );

    const entries = await readdir(root, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && e.name !== options.activeLabel);

    const measured: Array<{ label: string; path: string } & DirStats> = [];
    for (const d of dirs) {
      const path = join(root, d.name);
      try {
        measured.push({ label: d.name, path, ...(await newestMtimeAndBytes(path)) });
      } catch {
        /* unreadable — leave it alone */
      }
    }

    // Oldest first: the age pass and the byte pass both evict from this end.
    measured.sort((a, b) => a.newestMtimeMs - b.newestMtimeMs);

    const evictable = measured.filter(
      (m) => now - m.newestMtimeMs >= WITNESS_EVICTION_GRACE_MS,
    );
    let totalBytes = measured.reduce((sum, m) => sum + m.bytes, 0);

    const doomed = new Set<string>();
    for (const m of evictable) {
      if (now - m.newestMtimeMs > maxAgeMs) doomed.add(m.label);
    }
    for (const m of evictable) {
      if (totalBytes <= maxBytes) break;
      if (doomed.has(m.label)) {
        totalBytes -= m.bytes;
        continue;
      }
      doomed.add(m.label);
      totalBytes -= m.bytes;
    }

    const result: WitnessSweepResult = {
      skipped: false, scanned: measured.length, evicted: 0, freedBytes: 0, evictedLabels: [],
    };
    for (const m of measured) {
      if (!doomed.has(m.label)) continue;
      try {
        await rm(m.path, { recursive: true, force: true });
        result.evicted += 1;
        result.freedBytes += m.bytes;
        result.evictedLabels.push(m.label);
      } catch {
        /* eviction failed — leave it for the next sweep */
      }
    }

    try {
      await writeFile(join(root, STAMP_FILE), `${new Date(now).toISOString()}\n`, { mode: 0o600 });
    } catch {
      /* stamp is an optimization, not a correctness requirement */
    }
    return result;
  } catch {
    return { skipped: false, scanned: 0, evicted: 0, freedBytes: 0, evictedLabels: [] };
  }
}

/**
 * Delay before the sweep runs after a root session starts.
 *
 * Mirrors BackgroundAgentRegistry's 5-second eviction delay: housekeeping must
 * never compete with the session's own startup and first-turn I/O. The caller
 * is expected to `.unref()` the timer so a short-lived process never pays for
 * a sweep it will not benefit from.
 */
export const WITNESS_SWEEP_START_DELAY_MS = 5000;
