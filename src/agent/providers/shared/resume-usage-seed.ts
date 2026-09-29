/**
 * Context-overflow guard seed for a resumed session (#1294), shared by the
 * anthropic-direct and openai-compatible providers.
 *
 * The guard (shared/auto-compact.ts `guardContextOverflow`) needs a known
 * input-token count. A sidecar resume carries the last turn's real
 * `inputTokens`; a journal-only resume (`--resume <rawId>` with no sidecar, or
 * a router `/model` swap whose shadow turns carry no counts) does not. Without
 * a seed the guard skips the first turn, so a full resumed context reaches
 * the wire and is rejected with HTTP 400.
 *
 * Invariant: prefer the real sidecar count; otherwise estimate from the
 * resumed journal messages with {@link estimateInputTokens} (chars / 3.5 plus
 * a fixed overhead: an intentional over-estimate, which at worst triggers
 * compaction). Binary payloads (base64 images/documents) are NOT counted by
 * their encoded length, which would overshoot by orders of magnitude and
 * block the resume outright; each counts a flat {@link BINARY_TOKEN_ESTIMATE}.
 *
 * @module agent/providers/shared/resume-usage-seed
 */

import type { JournalMessage } from '../../journal/types.js';
import type { ResumeHistoryTurn } from '../../types/config-types.js';
import { estimateInputTokens } from './rate-limit-bucket.js';

/** Flat per-binary token estimate (roughly a large image's cost). */
export const BINARY_TOKEN_ESTIMATE = 1_600;

/** Estimate the input tokens a resumed journal conversation will cost. */
export function estimateJournalInputTokens(messages: readonly JournalMessage[]): number {
  let binaries = 0;
  const json = JSON.stringify(messages, (_key, value: unknown) => {
    if (value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'base64') {
      binaries++;
      return undefined;
    }
    return value;
  });
  return estimateInputTokens(json) + binaries * BINARY_TOKEN_ESTIMATE;
}

/**
 * Input-token seed for the overflow guard: the last sidecar turn's
 * `inputTokens` when present, else an estimate over `resumeMessages`, else
 * `undefined` (nothing resumed: the guard skips the first turn as before).
 */
export function resumeSeedInputTokens(config: {
  resumeHistory?: ResumeHistoryTurn[];
  resumeMessages?: JournalMessage[];
}): number | undefined {
  const recorded = config.resumeHistory?.at(-1)?.inputTokens;
  if (recorded !== undefined && recorded > 0) return recorded;
  const resumed = config.resumeMessages;
  if (resumed === undefined || resumed.length === 0) return recorded;
  return estimateJournalInputTokens(resumed);
}
