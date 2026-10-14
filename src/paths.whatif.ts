/** What-if engine state paths, extracted to keep the paths barrel below its ceiling. */
import { join } from 'node:path';
import { getAfkStateDir } from './paths.js';

/**
 * Root directory for what-if engine state.
 *
 * Stores the calibration ledger (`ledger.jsonl`) and per-run outputs.
 * Lives at `<getAfkStateDir()>/whatif`.
 */
export function getWhatifDir(): string {
  return join(getAfkStateDir(), 'whatif');
}
