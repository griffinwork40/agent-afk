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

import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
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
function sweptRecently(root: string, now: number): boolean {
  try {
    const st = statSync(join(root, STAMP_FILE));
    return now - st.mtimeMs < SWEEP_INTERVAL_MS;
  } catch {
    return false; // no stamp yet — run the sweep
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
    if (opts?.force !== true && sweptRecently(root, now)) {
      return noop('stamp');
    }

    if (!existsSync(root)) {
      return { skipped: false, evictedAge: 0, evictedCount: 0, remaining: 0 };
    }

    const maxAgeDays = positiveNumber(env.AFK_SESSION_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS);
    const maxCount = positiveNumber(env.AFK_SESSION_MAX_COUNT, DEFAULT_MAX_COUNT);
    const maxAgeMs = maxAgeDays * DAY_MS;

    // Enumerate all flat .json files (skip subdirectories and the stamp file).
    const entries = readdirSync(root, { withFileTypes: true });
    interface SidecarRecord {
      name: string;
      path: string;
      ageMs: number; // how old: now - savedAt (or mtime)
      savedAtMs: number; // the resolved timestamp used for age
    }
    const sidecars: SidecarRecord[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.json')) continue;

      const path = join(root, entry.name);

      let savedAtMs: number;
      try {
        const raw = readFileSync(path, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          'savedAt' in parsed &&
          typeof (parsed as Record<string, unknown>)['savedAt'] === 'number'
        ) {
          savedAtMs = (parsed as Record<string, unknown>)['savedAt'] as number;
        } else {
          // Valid JSON but no usable savedAt — fall back to mtime.
          savedAtMs = statSync(path).mtimeMs;
        }
      } catch {
        // Corrupt JSON or unreadable file — fall back to mtime.
        try {
          savedAtMs = statSync(path).mtimeMs;
        } catch {
          continue; // raced away; skip entirely
        }
      }

      sidecars.push({ name: entry.name, path, ageMs: now - savedAtMs, savedAtMs });
    }

    // Protect files inside the grace window.
    const evictable = sidecars.filter((s) => s.ageMs >= GRACE_MS);

    // Sort oldest-first for both passes.
    evictable.sort((a, b) => a.savedAtMs - b.savedAtMs);

    let evictedAge = 0;
    let evictedCount = 0;
    const doomed = new Set<string>();

    // Age pass.
    for (const s of evictable) {
      if (s.ageMs > maxAgeMs) {
        doomed.add(s.path);
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
          doomed.add(s.path);
          evictedCount += 1;
          count -= 1;
        }
      }
    }

    // Execute evictions.
    const actuallyEvicted = new Set<string>();
    for (const path of doomed) {
      try {
        unlinkSync(path);
        actuallyEvicted.add(path);
      } catch {
        // Raced away or permission error — leave it for the next sweep.
        evictedAge -= evictedAge > 0 && !actuallyEvicted.has(path) ? 1 : 0;
      }
    }

    const remaining = sidecars.length - actuallyEvicted.size;

    // Write the stamp so the next session start is a no-op.
    try {
      writeFileSync(join(root, STAMP_FILE), `${new Date(now).toISOString()}\n`, { mode: 0o600 });
    } catch {
      // Stamp is an optimization, not a correctness requirement.
    }

    return { skipped: false, evictedAge, evictedCount, remaining };
  } catch {
    return { skipped: false, evictedAge: 0, evictedCount: 0, remaining: 0 };
  }
}
