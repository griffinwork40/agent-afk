/**
 * Wave manifest write helpers.
 *
 * All writes use a temp-file + rename pattern for atomicity: a crashed process
 * never leaves a half-written JSON file, and a concurrent reader always sees
 * a fully valid document.
 *
 * All public functions are fire-and-forget safe: they catch internal errors and
 * never throw to the caller, so a manifest write failure never aborts a wave.
 *
 * @module agent/manifest/write
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { env } from '../../config/env.js';
import { getWavesDir, getWaveManifestPath } from '../../paths.js';
import type { WaveManifest, WaveUnit, WaveUnitStatus, PromptDigest } from './types.js';
import { extractWorktreePath } from './worktree.js';

/** Default TTL in hours (48h). Overridable via AFK_WAVE_MANIFEST_TTL_HOURS. */
const DEFAULT_TTL_HOURS = 48;

/** Max chars stored in promptDigest.head. */
const PROMPT_HEAD_CHARS = 512;

/** Max chars stored in WaveUnit.errorMessage. */
const ERROR_MESSAGE_MAX_CHARS = 500;

/**
 * Compute a PromptDigest from a raw prompt string.
 * SHA-256 + 512-char head + byte length. Never stores the full prompt.
 */
export function computePromptDigest(prompt: string): PromptDigest {
  const sha256 = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const head = prompt.slice(0, PROMPT_HEAD_CHARS);
  const byteLen = Buffer.byteLength(prompt, 'utf8');
  return { sha256, head, byteLen };
}

function resolveTtlHours(): number {
  const raw = env.AFK_WAVE_MANIFEST_TTL_HOURS;
  if (raw !== undefined && raw !== '') {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TTL_HOURS;
}

/**
 * Build a WaveUnit from minimal inputs at manifest-creation time.
 * Status is always 'pending' here; callers update via updateWaveUnit.
 */
export function buildWaveUnit(opts: {
  id: string;
  prompt: string;
  cwd: string | undefined;
  model: string;
  upstreamIds?: string[];
}): WaveUnit {
  const worktreePath = opts.cwd !== undefined ? extractWorktreePath(opts.cwd) : undefined;
  return {
    id: opts.id,
    status: 'pending',
    promptDigest: computePromptDigest(opts.prompt),
    cwd: opts.cwd,
    model: opts.model,
    startedAt: undefined,
    settledAt: undefined,
    errorMessage: undefined,
    upstreamIds: opts.upstreamIds ?? [],
    worktreePath,
  };
}

/**
 * Create a new WaveManifest and write it to disk.
 *
 * Fire-and-forget: returns the waveId on success, undefined on any error.
 * Never throws.
 */
export function createManifest(opts: {
  source: WaveManifest['source'];
  parentSessionId: string;
  traceLabel: string | null;
  units: WaveUnit[];
}): string | undefined {
  if (env.AFK_WAVE_MANIFEST_DISABLED === '1') return undefined;
  try {
    const waveId = randomUUID().replace(/-/g, '');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + resolveTtlHours() * 60 * 60 * 1000);
    const manifest: WaveManifest = {
      version: 1,
      waveId,
      parentSessionId: opts.parentSessionId,
      traceLabel: opts.traceLabel,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      source: opts.source,
      units: opts.units,
    };
    writeManifestSync(manifest);
    return waveId;
  } catch {
    return undefined;
  }
}

/**
 * Atomically write a WaveManifest to disk using temp-file + rename.
 *
 * The waves directory is created if it does not exist.
 * Fire-and-forget: never throws.
 */
export function writeManifestSync(manifest: WaveManifest): void {
  try {
    const dir = getWavesDir();
    mkdirSync(dir, { recursive: true });
    const target = getWaveManifestPath(manifest.waveId);
    const tmp = join(dirname(target), `.${manifest.waveId}.tmp`);
    writeFileSync(tmp, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    // Fire-and-forget: manifest write failures must never abort a wave.
  }
}

/**
 * Read a manifest from disk. Returns undefined if the file is missing or unparseable.
 */
export function readManifest(waveId: string): WaveManifest | undefined {
  try {
    const raw = readFileSync(getWaveManifestPath(waveId), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || (parsed as WaveManifest).version !== 1) {
      return undefined;
    }
    return parsed as WaveManifest;
  } catch {
    return undefined;
  }
}

/**
 * Update a single unit's status in an existing manifest.
 *
 * Read-modify-write using temp-file + rename. Fire-and-forget: never throws.
 * No-op when the waveId does not exist on disk.
 */
export function updateWaveUnit(
  waveId: string,
  unitId: string,
  newStatus: WaveUnitStatus,
  extra?: {
    errorMessage?: string;
  },
): void {
  try {
    const manifest = readManifest(waveId);
    if (manifest === undefined) return;

    const now = new Date().toISOString();
    const unit = manifest.units.find((u) => u.id === unitId);
    if (unit === undefined) return;

    unit.status = newStatus;
    if (newStatus === 'running') {
      unit.startedAt = now;
    }
    if (newStatus === 'done' || newStatus === 'failed' || newStatus === 'skipped') {
      unit.settledAt = now;
    }
    if (extra?.errorMessage !== undefined) {
      unit.errorMessage = extra.errorMessage.slice(0, ERROR_MESSAGE_MAX_CHARS);
    }
    manifest.updatedAt = now;

    writeManifestSync(manifest);
  } catch {
    // Fire-and-forget: status update failures must never abort settlement.
  }
}
