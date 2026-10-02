/**
 * Mid-stream transport termination classifier (#2776).
 *
 * The shared predicate {@link isMidStreamNetworkTermination} lives in
 * `providers/shared/network-termination.ts` so the openai-compatible provider
 * can import it without a cross-provider dependency (#2780). This module
 * re-exports it for backward-compatibility and adds the anthropic-specific
 * {@link isMidStreamCut} that couples to {@link StreamIncompleteError}.
 *
 * Pure: no SDK import, no I/O.
 */

export { isMidStreamNetworkTermination } from '../../shared/network-termination.js';
import { isMidStreamNetworkTermination } from '../../shared/network-termination.js';
import { StreamIncompleteError } from '../../../../utils/errors.js';

/**
 * Contract: true for any post-first-byte connection cut that the round's
 * stream-incomplete re-drive budget covers: a clean close without a terminal
 * signal ({@link StreamIncompleteError}, yielded by translate.ts) or a thrown
 * transport termination ({@link isMidStreamNetworkTermination}). Both burn a
 * partial generation per attempt, which is why they share one LOW budget
 * (STREAM_INCOMPLETE_MAX_RETRIES in retry-budget.ts).
 */
export function isMidStreamCut(err: unknown): boolean {
  return err instanceof StreamIncompleteError || isMidStreamNetworkTermination(err);
}
