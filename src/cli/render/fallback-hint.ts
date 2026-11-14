/**
 * Pause-card fallback hint line.
 *
 * When a usage-limit pause fires AND a fallback model is configured AND the
 * session is not already on that fallback, one additional line is shown
 * telling the user what they can do. The automatic switch could not fire
 * (work was already in progress for the turn), so the instruction must be
 * accurate: `/retry` replays on the CURRENT model — the user must switch
 * first.
 *
 * Returns `undefined` when no hint applies (no fallback configured, or
 * already on the fallback).
 *
 * @module cli/render/fallback-hint
 */

import { getConfiguredFallbackModel } from '../../agent/session/fallback-model.js';
import { palette } from '../palette.js';

/**
 * Build the one-line fallback hint, or return `undefined` when none applies.
 *
 * @param currentModel - The model the session is currently on (stats.model).
 */
export function buildFallbackHint(currentModel: string): string | undefined {
  const fallback = getConfiguredFallbackModel();
  if (!fallback) return undefined;
  // Normalise for comparison: both sides are raw config strings, so a simple
  // string equality check is correct (we do not resolve aliases here — the
  // user set both values and they should match the same way they typed them).
  if (fallback === currentModel) return undefined;
  return (
    palette.dim(`  Fallback ${palette.brand(fallback)} is configured. `) +
    palette.dim(`Run ${palette.brand('/model ' + fallback)}, then ${palette.brand('/retry')}.`)
  );
}
