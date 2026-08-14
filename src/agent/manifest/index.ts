/**
 * Wave manifest system — public barrel export.
 *
 * Provides the types, write helpers, worktree utilities, and session-start
 * reconciler for the interrupted-session recovery feature (#940).
 *
 * @module agent/manifest
 */

export type {
  WaveUnitStatus,
  PromptDigest,
  WaveUnit,
  WaveManifest,
} from './types.js';

export {
  computePromptDigest,
  buildWaveUnit,
  createManifest,
  writeManifestSync,
  readManifest,
  updateWaveUnit,
} from './write.js';

export {
  isWorktreeCwd,
  extractWorktreePath,
  checkWorktreePresence,
} from './worktree.js';

export type { ResumableUnit, StaleManifestOffer, ReconcileResult } from './reconcile.js';
export {
  reconcileWaveManifests,
  formatResumptionOffer,
  shouldSurfaceResumptionOffer,
  sweepExpiredManifests,
} from './reconcile.js';
