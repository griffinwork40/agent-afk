/**
 * Bounded retention for session sidecar files (`$AFK_STATE_DIR/sessions/*.json`).
 *
 * Each root session writes a flat JSON sidecar under `state/sessions/<id>.json`
 * containing the session summary (cost, model, label, etc.). The `<uuid>/`
 * subdirectories in the same folder are per-session ledger dirs — this sweep
 * only touches the `.json` files, never the subdirectories.
 *
 * Two eviction passes run in order:
 *   1. Age pass — remove any sidecar whose `savedAt` timestamp (or mtime
 *      fallback) is older than `AFK_SESSION_MAX_AGE_DAYS` (default 30).
 *   2. Count pass — evict oldest-first until at most `AFK_SESSION_MAX_COUNT`
 *      (default 1000) files remain.
 *
 * A 1-hour grace window protects files touched recently enough to belong to an
 * active or just-finished session. A stamp file throttles the sweep to at most
 * once every 6 hours.
 *
 * @module agent/session-sidecar-sweep
 */

import { readdir, readFile, stat, unlink, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { getSessionsDir } from '../paths.js';
import { env } from '../config/env.js';

/** Minimum wall-clock gap between two sweeps. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Files touched within this window are never evicted (protects active sessions). */
const GRACE_MS = 60 * 60 * 1000; // 1 hour

/** Stamp file name, written to the sessions dir after a sweep completes. */
const STAMP_FILE = '.last-sweep-sidecars';

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_COUNT = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delay before the sweep fires after a root session starts.
 *
 * Mirrors the witness-sweep delay: housekeeping must never compete with the
 * session's own startup and first-turn I/O. Callers must `.unref()` the timer
 * so a short-lived process never pays for a sweep it will not benefit from.
 */
export const SESSION_SIDECAR_SWEEP_START_DELAY_MS = 5_000;

export interface SessionSweepResult {
  /** True when the stamp (or the disable switch) short-circuited the run. */
  skipped: boolean;
  reason?: string;
  /** Number of sidecars removed by the age pass. */
  evictedAge: number;
  /** Number of sidecars removed by the count pass. */
  evictedCount: number;
  /** Number of sidecars remaining after the sweep. */
  remaining: number;
}

export interface SessionSweepOptions {
  /** Override the sessions directory (for testing). */
  root?: string;
  /** Bypass the inter-sweep stamp (for testing). */
  force?: boolean;
  /**
   * Session ID of the currently-running session. That sidecar is excluded from
   * the sweep by identity (not by timestamp) — mirrors the `activeLabel` pattern
   * used by the witness sweep.
   */
  activeSessionId?: string;
  /**
   * Override the unlink implementation (testing only). Allows unit tests to
   * simulate EPERM/EACCES without requiring `vi.mock` on non-configurable
   * native ESM exports.
   *
   * @internal
   */
  _unlink?: (path: string) => Promise<void>;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const noop = (reason: string): SessionSweepResult => ({
  skipped: true,
  reason,
  evictedAge: 0,
  evictedCount: 0,
  remaining: 0,
});

/** True when the stamp says a sweep ran recently enough to skip this one. */
async function sweptRecently(root: string, now: number): Promise<boolean> {
  try {
    const st = await stat(join(root, STAMP_FILE));
    return now - st.mtimeMs < SWEEP_INTERVAL_MS;
  } catch {
    return false; // no stamp yet — run the sweep
  }
}

/** True when the path exists (async replacement for existsSync). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sweep session sidecar files, evicting files that exceed the age bound,
 * then oldest-first until the count bound is met.
 *
 * Contract: best-effort and never throws — a missing root, permission error,
 * or mid-walk race resolves to a zeroed result. Retention housekeeping must
 * never be able to fail a session start.
 */
export async function sweepSessionSidecars(opts?: SessionSweepOptions): Promise<SessionSweepResult> {
  if (env.AFK_SESSION_RETENTION_DISABLE === '1') {
    return noop('disabled');
  }

  const root = opts?.root ?? getSessionsDir();
  const now = Date.now();

  try {
    if (opts?.force !== true && (await sweptRecently(root, now))) {
      return noop('stamp');
    }

    if (!(await pathExists(root))) {
      return { skipped: false, evictedAge: 0, evictedCount: 0, remaining: 0 };
    }

    const maxAgeDays = positiveNumber(env.AFK_SESSION_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS);
    const maxCount = positiveNumber(env.AFK_SESSION_MAX_COUNT, DEFAULT_MAX_COUNT);
    const maxAgeMs = maxAgeDays * DAY_MS;

    // Enumerate all flat .json files (skip subdirectories and the stamp file).
    const entries = await readdir(root, { withFileTypes: true });
    interface SidecarRecord {
      name: string;
      path: string;
      ageMs: number;    // how old: now - savedAt (or mtime), clamped to ≥0
      savedAtMs: number; // resolved content timestamp used for age ranking
      mtimeMs: number;   // OS mtime at enumeration time, used for the race guard
    }
    const sidecars: SidecarRecord[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;

      // Item 4: skip the active session's own sidecar by identity.
      if (opts?.activeSessionId !== undefined && entry.name === `${opts.activeSessionId}.json`) {
        continue;
      }

      const path = join(root, entry.name);

      let savedAtMs: number;
      let mtimeMs: number;
      try {
        const raw = await readFile(path, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        // Always stat for the race-guard mtime.
        const st = await stat(path);
        mtimeMs = st.mtimeMs;
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'savedAt' in parsed &&
          typeof (parsed as Record<string, unknown>)['savedAt'] === 'number'
        ) {
          savedAtMs = (parsed as Record<string, unknown>)['savedAt'] as number;
        } else {
          // Valid JSON but no usable savedAt — fall back to mtime.
          savedAtMs = mtimeMs;
        }
      } catch {
        // Corrupt JSON or unreadable file — fall back to mtime.
        try {
          const st = await stat(path);
          savedAtMs = st.mtimeMs;
          mtimeMs = st.mtimeMs;
        } catch {
          continue; // raced away; skip entirely
        }
      }

      // Item 2: clamp ageMs so a future savedAt (clock skew, corrupt value)
      // does not produce a negative age that permanently excludes the file.
      sidecars.push({ name: entry.name, path, ageMs: Math.max(0, now - savedAtMs), savedAtMs, mtimeMs });
    }

    // Protect files inside the grace window.
    const evictable = sidecars.filter((s) => s.ageMs >= GRACE_MS);

    // Sort oldest-first for both passes.
    evictable.sort((a, b) => a.savedAtMs - b.savedAtMs);

    let evictedAge = 0;
    let evictedCount = 0;
    // Item 1: tag each doomed path with the pass that condemned it so the
    // catch block can decrement the right counter on unlink failure.
    const doomed = new Map<string, 'age' | 'count'>();

    // Age pass.
    for (const s of evictable) {
      if (s.ageMs > maxAgeMs) {
        doomed.set(s.path, 'age');
        evictedAge += 1;
      }
    }

    // Count pass: count surviving files (those not already doomed + those in
    // the grace window), evict oldest until we're within the cap.
    const surviving = sidecars.filter((s) => !doomed.has(s.path));
    if (surviving.length > maxCount) {
      // Sort surviving oldest-first (grace-window files can't be evicted, so
      // only evictable survivors are candidates).
      const candidates = surviving.filter((s) => s.ageMs >= GRACE_MS);
      candidates.sort((a, b) => a.savedAtMs - b.savedAtMs);
      let count = surviving.length;
      for (const s of candidates) {
        if (count <= maxCount) break;
        if (!doomed.has(s.path)) {
          doomed.set(s.path, 'count');
          evictedCount += 1;
          count -= 1;
        }
      }
    }

    // Execute evictions.
    const unlinkFn = opts?._unlink ?? unlink;
    let actuallyEvicted = 0;
    for (const [path, bucket] of doomed) {
      try {
        // Item 5: re-stat before unlinking. If another process wrote to this
        // file after enumeration, its mtime will have changed; skip deletion to
        // avoid removing live data. Compare against the mtime recorded during
        // enumeration, not the content-derived savedAt.
        const sidecarRecord = sidecars.find((s) => s.path === path);
        if (sidecarRecord !== undefined) {
          const freshStat = await stat(path);
          if (freshStat.mtimeMs !== sidecarRecord.mtimeMs) {
            // File was modified after enumeration — leave it for the next sweep.
            if (bucket === 'age') evictedAge -= 1;
            else evictedCount -= 1;
            continue;
          }
        }
        await unlinkFn(path);
        actuallyEvicted += 1;
      } catch {
        // Raced away or permission error — leave it for the next sweep.
        // Item 1: decrement the correct counter based on which pass doomed it.
        if (bucket === 'age') evictedAge -= 1;
        else evictedCount -= 1;
      }
    }

    const remaining = sidecars.length - actuallyEvicted;

    // Write the stamp so the next session start is a no-op.
    try {
      await writeFile(join(root, STAMP_FILE), `${new Date(now).toISOString()}\n`, { mode: 0o600 });
    } catch {
      // Stamp is an optimization, not a correctness requirement.
    }

    return { skipped: false, evictedAge, evictedCount, remaining };
  } catch {
    return { skipped: false, evictedAge: 0, evictedCount: 0, remaining: 0 };
  }
}
