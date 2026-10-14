/**
 * Wave-manifest path helpers — extracted from src/paths.ts for the 350-line ceiling.
 *
 * @module paths.wave
 */

import { join } from 'node:path';
import { getAfkStateDir } from './paths.js';

/**
 * Root for wave manifests: `~/.afk/state/waves/`.
 *
 * One JSON file per wave (≥2 concurrent dispatches in one turn) lives here.
 * Written by coordinators (SubagentExecutor, ComposeExecutor) before a fan-out
 * starts; cleaned up by the reconciler and witness sweep after TTL expiry.
 */
export function getWavesDir(): string {
  return join(getAfkStateDir(), 'waves');
}

/**
 * Per-manifest file: `~/.afk/state/waves/<waveId>.json`.
 *
 * waveId is a UUID v4, which fits the isSafeLedgerSessionId charset
 * ([A-Za-z0-9_-]), so no extra validation is needed beyond the UUID generator.
 */
export function getWaveManifestPath(waveId: string): string {
  return join(getWavesDir(), `${waveId}.json`);
}
