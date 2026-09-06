/**
 * Shared progress-event constants used by both emit-progress.ts and handle.ts.
 * Extracted to a dedicated file to avoid a circular value dependency between
 * the two modules (emit-progress imports type SubagentHandleImpl from handle).
 *
 * @module agent/subagent/progress-constants
 */

/** Ring buffer capacity per handle for child-to-parent progress events. */
export const PROGRESS_RING_CAPACITY = 20;

/** Maximum UTF-8 byte length of the `phase` field. */
export const PROGRESS_MAX_PHASE_BYTES = 256;
