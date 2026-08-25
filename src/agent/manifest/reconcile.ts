/**
 * Session-start wave manifest reconciler.
 *
 * On session start (after the session id is known), call
 * `reconcileWaveManifests()` to discover stale manifests and surface a
 * resumption offer for unfinished work.
 *
 * Design invariants:
 *   - Resumption is OFFERED, never silently performed.
 *   - Non-interactive surfaces (daemon, one-shot chat) log to stderr and skip
 *     unless AFK_WAVE_RESUME_UNATTENDED=1.
 *   - Expired manifests are deleted on every reconciler pass.
 *   - Fire-and-forget: the function never throws to its caller.
 *
 * @module agent/manifest/reconcile
 */

import { readdirSync, unlinkSync } from 'node:fs';
import { readManifest } from './write.js';
import { checkWorktreePresence } from './worktree.js';
import { getWavesDir, getWaveManifestPath } from '../../paths.js';
import { env } from '../../config/env.js';
import type { WaveManifest, WaveUnit } from './types.js';
import { stripEscapeSequences } from '../../utils/terminal-sanitize.js';

const UNSETTLED_STATUSES = new Set<WaveUnit['status']>(['pending', 'running']);
const HOURS_48_MS = 48 * 60 * 60 * 1000;

/** An unsettled unit ready for resumption (worktree still present or absent). */
export interface ResumableUnit {
  unit: WaveUnit;
  worktreeStatus: 'ok' | 'missing';
}

/** A manifest that has at least one resumable unit. */
export interface StaleManifestOffer {
  manifest: WaveManifest;
  resumable: ResumableUnit[];
  /** Units with unsatisfied DAG upstream dependencies — cannot re-dispatch. */
  blocked: WaveUnit[];
}

export interface ReconcileResult {
  /** Qualifying manifests with at least one unsettled unit. */
  offers: StaleManifestOffer[];
  /** Number of expired manifests deleted. */
  deletedExpired: number;
}

/**
 * Scan `~/.afk/state/waves/` for stale manifests and categorize them.
 *
 * A manifest qualifies for an offer when:
 *   1. It has not yet expired (`expiresAt > now`).
 *   2. It has at least one unit with status `pending | running`.
 *   3. The parent session matches OR the manifest is recent enough (<48h).
 *
 * Expired manifests are deleted on discovery.
 *
 * Fire-and-forget: returns an empty result on any error.
 */
export function reconcileWaveManifests(opts: {
  sessionId: string;
}): ReconcileResult {
  const result: ReconcileResult = { offers: [], deletedExpired: 0 };

  try {
    const dir = getWavesDir();
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // Directory doesn't exist yet — nothing to reconcile.
      return result;
    }

    const now = Date.now();

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      // Extract waveId from filename (strip .json suffix)
      const waveId = entry.slice(0, -5);
      // Validate waveId to prevent path traversal (must be hex-alphanumeric only).
      if (!/^[A-Za-z0-9]+$/.test(waveId)) continue;

      const manifest = readManifest(waveId);
      if (manifest === undefined) continue;

      const expiresAt = new Date(manifest.expiresAt).getTime();

      // Delete expired manifests. Non-finite (NaN for corrupt values) treated as expired.
      if (!Number.isFinite(expiresAt) || expiresAt < now) {
        try {
          unlinkSync(getWaveManifestPath(waveId));
          result.deletedExpired += 1;
        } catch {
          // Best-effort deletion.
        }
        continue;
      }

      // Skip manifests that are too old for the 48h recency heuristic.
      // Guard against corrupt createdAt: new Date(<corrupt>).getTime() returns
      // NaN, which makes `now - NaN` = NaN and `NaN < HOURS_48_MS` = false,
      // silently skipping the manifest forever. Treat NaN as epoch (0) so
      // isRecent is definitively false — isOwnSession still carries it if the
      // parent session matches.
      const createdAtRaw = new Date(manifest.createdAt).getTime();
      const createdAt = Number.isFinite(createdAtRaw) ? createdAtRaw : 0;
      const isRecent = now - createdAt < HOURS_48_MS;
      const isOwnSession = manifest.parentSessionId === opts.sessionId;
      if (!isRecent && !isOwnSession) continue;

      // Collect unsettled units
      const unsettled = manifest.units.filter((u) => UNSETTLED_STATUSES.has(u.status));
      if (unsettled.length === 0) continue;

      // For DAG manifests, determine which units are blocked by failed/missing upstreams
      const doneIds = new Set(
        manifest.units.filter((u) => u.status === 'done').map((u) => u.id),
      );

      const blocked: WaveUnit[] = [];
      const resumable: ResumableUnit[] = [];

      for (const unit of unsettled) {
        const hasUnsatisfiedDeps =
          unit.upstreamIds.length > 0 &&
          unit.upstreamIds.some((depId) => !doneIds.has(depId));

        if (hasUnsatisfiedDeps) {
          blocked.push(unit);
          continue;
        }

        const worktreeStatus = checkWorktreePresence(unit.worktreePath);
        resumable.push({ unit, worktreeStatus });
      }

      if (resumable.length > 0 || blocked.length > 0) {
        result.offers.push({ manifest, resumable, blocked });
      }
    }
  } catch {
    // Fire-and-forget: reconciler errors must never fail a session start.
  }

  return result;
}

/**
 * Format a human-readable resumption offer for display in a session.
 *
 * Returns a multi-line string suitable for stderr logging or a synthetic
 * tool result. Does not perform any re-dispatch.
 */
export function formatResumptionOffer(offer: StaleManifestOffer): string {
  const { manifest, resumable, blocked } = offer;
  const createdAt = new Date(manifest.createdAt);
  const ageMs = Date.now() - createdAt.getTime();
  const ageStr = formatAge(ageMs);

  const lines: string[] = [
    `[wave-resume] Wave ${manifest.waveId} from ${ageStr} ago has ${resumable.length + blocked.length} unsettled unit(s).`,
    `  Source: ${manifest.source}`,
  ];

  if (resumable.length > 0) {
    lines.push(`  Units ready to resume:`);
    for (const { unit, worktreeStatus } of resumable) {
      const headPreview = stripEscapeSequences(unit.promptDigest.head.slice(0, 80)).replace(/\n/g, ' ');
      const cwdNote = unit.cwd !== undefined ? `  (cwd: ${stripEscapeSequences(unit.cwd)})` : '';
      const worktreeNote = worktreeStatus === 'missing'
        ? '  ⚠ worktree was swept — cannot re-dispatch without its working directory'
        : '';
      lines.push(`    · ${unit.id}: ${headPreview}...${cwdNote}${worktreeNote}`);
    }
  }

  if (blocked.length > 0) {
    lines.push(`  Units blocked on failed upstream deps:`);
    for (const unit of blocked) {
      lines.push(`    · ${unit.id} (depends on: ${unit.upstreamIds.join(', ')})`);
    }
  }

  lines.push(`  To retry, re-dispatch each ready unit's prompt from its listed cwd; this notice does not accept yes/no replies.`);
  return lines.join('\n');
}

/**
 * Determine whether resumption offers should be surfaced on this surface.
 *
 * Non-interactive surfaces (daemon, one-shot chat) only surface offers when
 * AFK_WAVE_RESUME_UNATTENDED=1 is explicitly set. Interactive surfaces always
 * surface offers.
 */
export function shouldSurfaceResumptionOffer(isInteractive: boolean): boolean {
  return isInteractive || env.AFK_WAVE_RESUME_UNATTENDED === '1';
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Sweep expired manifests from the waves directory without offering resumption.
 *
 * Intended as a lightweight cleanup called from the witness sweep co-location.
 * Fire-and-forget: never throws.
 */
export function sweepExpiredManifests(): { deleted: number } {
  let deleted = 0;
  try {
    const dir = getWavesDir();
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return { deleted };
    }

    const now = Date.now();
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const waveId = entry.slice(0, -5);
      if (!/^[A-Za-z0-9]+$/.test(waveId)) continue;
      const manifest = readManifest(waveId);
      if (manifest === undefined) continue;
      const expiresAt = new Date(manifest.expiresAt).getTime();
      if (Number.isFinite(expiresAt) && expiresAt >= now) continue;
      try {
        unlinkSync(getWaveManifestPath(waveId));
        deleted += 1;
      } catch {
        // Best-effort.
      }
    }
  } catch {
    // Fire-and-forget.
  }
  return { deleted };
}
