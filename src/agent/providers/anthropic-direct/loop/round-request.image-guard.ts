/**
 * Request-build image ceiling step for `openRound`.
 *
 * Runs {@link enforceImageLimits} over the round's history, and when it
 * replaced any image: records a `many_image_degraded` trace phase with the
 * ceiling and count that actually applied, asks the journal to re-append from
 * the earliest mutated message (the replacement was made IN PLACE, which the
 * by-reference journal diff cannot see), and returns ONE operator-facing
 * `notice` event for the caller to yield. Never throws.
 *
 * @module agent/providers/anthropic-direct/loop/round-request.image-guard
 */

import type { ProviderEvent } from '../../../provider.js';
import type { RunTurnInput } from '../types.js';
import { emitSessionPhase } from '../../../trace/emit.js';
import { enforceImageLimits, MANY_IMAGE_THRESHOLD, type ImageLimitReport } from './_many-image-guard.js';

type NoticeEvent = Extract<ProviderEvent, { type: 'notice' }>;

/** Operator-facing summary of one round's image repairs. */
export function imageOmittedNoticeText(report: ImageLimitReport): string {
  const n = report.omitted.length;
  const sizes = report.omitted.map((o) => `${o.width}x${o.height}`).join(', ');
  const limit = report.manyImage
    ? `the ${report.maxDimension}px per-side limit for requests with more than ${MANY_IMAGE_THRESHOLD} images`
    : `the ${report.maxDimension}px per-side image limit`;
  return `${n} image${n === 1 ? '' : 's'} (${sizes}) exceeded ${limit} and ${n === 1 ? 'was' : 'were'} replaced with a text note so the request would not fail. ` +
    'Ask for a viewport-size or single-element screenshot, or a cropped or smaller image, to show it to the model.';
}

/**
 * Enforce the per-image pixel ceiling on `input.messages` (in place) and
 * return the notice to yield, or null when nothing changed. Must run BEFORE
 * the round's `journalSync.sync`.
 */
export function applyImageLimitGuard(
  input: Pick<RunTurnInput, 'messages' | 'traceWriter' | 'journalSync' | 'model' | 'ctx'>,
): NoticeEvent | null {
  let report: ImageLimitReport;
  try {
    report = enforceImageLimits(input.messages);
  } catch {
    // Contract: the guard must never fail a request.
    return null;
  }
  if (report.omitted.length === 0 || report.earliestMessageIndex === null) return null;

  input.journalSync?.invalidateFrom(report.earliestMessageIndex);
  void emitSessionPhase(input.traceWriter, {
    phase: 'many_image_degraded',
    resolvedModel: input.model,
    metadata: {
      degradedCount: report.omitted.length,
      imageCount: report.imageCount,
      threshold: MANY_IMAGE_THRESHOLD,
      maxDimension: report.maxDimension,
      manyImage: report.manyImage,
    },
  });
  return {
    type: 'notice',
    text: imageOmittedNoticeText(report),
    kind: 'image-omitted',
    sessionId: input.ctx.sessionId,
  };
}
