/**
 * Episode collection for the what-if verify phase.
 *
 * Extracted from run.ts to keep that file within the 350-code-line ceiling.
 *
 * @module whatif/run.episodes
 */

import * as path from 'node:path';
import {
  collectRealTurns,
  syntheticEpisodes,
  loadSuiteEpisodes,
  type CorpusExclusions,
} from './episodes.js';
import type { Episode, Prediction, WhatifOptions } from './types.js';

/**
 * Collect all episode sources for the verify phase.
 *
 * Invariant: synthetic probe episodes MUST come before replay turns.
 * run.verify.ts builds tasks in episode order and the budget stop drops the
 * tail; if replay turns come first they consume budget that would otherwise
 * score predictions (replay turns target no prediction after #2427).
 */
export async function collectVerifyEpisodes(
  options: WhatifOptions & { sessionsDir?: string },
  predictions: Prediction[],
): Promise<{ episodes: Episode[]; corpusExclusions: CorpusExclusions }> {
  const corpusExclusions: CorpusExclusions = {
    whatifSessions: 0, excludedSessionIds: 0,
    nonStandaloneTurns: 0, whatifTopicTurns: 0,
  };
  const realTurns = await collectRealTurns({
    limit: options.turns,
    sessionsDir: options.sessionsDir,
    stats: corpusExclusions,
  });
  const synthetic = syntheticEpisodes(predictions);
  const suitesDir = path.join(options.realHome, 'whatif', 'suites');
  const suiteEps = await loadSuiteEpisodes(suitesDir).catch(() => []);
  return { episodes: [...synthetic, ...realTurns, ...suiteEps], corpusExclusions };
}
