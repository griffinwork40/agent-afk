/**
 * End-of-stream completeness check for one anthropic-direct model call.
 *
 * Answers exactly one question — "did this SSE stream terminate properly, and
 * what do we report if it did not?" — extracted from `translate.ts` so that
 * module stays under the 350-LOC ceiling and so the reasoning below lives next
 * to the predicate it governs rather than inline in the translation loop.
 *
 * History: the error this module builds used to assert its own cause —
 * "typically an intermediary closing the connection". That was a guess, it was
 * wrong often enough to matter, and it misdirected two separate investigations
 * into the provider/gateway layer before anyone executed the abort path. It is
 * now stated as an unknown, with a pointer to the trace phases that DO identify
 * the cause. Do not re-add a cause claim here; this layer cannot know one.
 *
 * @module agent/providers/anthropic-direct/stream-completeness
 */

import { StreamIncompleteError } from '../../../utils/errors.js';

/**
 * Contract: did the stream deliver a terminal signal?
 *
 * Complete when EITHER a `message_stop` event arrived (`stopped`) OR a
 * `message_delta` carried a real `stop_reason`. The `stopReason !== null` half
 * matters on its own: a stream that lost only the framing `message_stop` still
 * had the model state why it stopped, so it is complete — treating it as a cut
 * would fail a turn that actually finished.
 */
export function isStreamComplete(stopped: boolean, stopReason: string | null): boolean {
  return stopped || stopReason !== null;
}

/**
 * Invariant: the error for a stream that ended with no terminal signal.
 *
 * Reported rather than swallowed because yielding a turn-result from an
 * incomplete stream would present the partial as a clean, complete answer —
 * silent truncation. Surfacing it keeps the incomplete turn legible to BOTH the
 * top-level session and the forked-subagent consumer, which routes
 * `StreamIncompleteError` through its `status:'failed'` handling. This is the
 * #628 / #635 "fail loudly, don't silently succeed" contract; keep it.
 *
 * The message names no cause on purpose. The Anthropic SDK returns from its
 * stream iterator *silently* for any abort whose reason is an AbortError —
 * `node_modules/@anthropic-ai/sdk/core/streaming.js`: `if (isAbortError(e))
 * return;` — which covers the SDK's OWN default 10-minute request timeout
 * (`client.js`: `options.timeout ?? DEFAULT_TIMEOUT`), fired as a bare
 * `controller.abort()`. A genuine peer close produces a byte-identical clean
 * end. The two are indistinguishable from inside the translator.
 *
 * Note the asymmetry that makes this worth spelling out: agent-afk's own
 * watchdogs abort with CUSTOM Error reasons (`TTFB_TIMEOUT_MESSAGE`,
 * `STALL_TIMEOUT_MESSAGE`, `IdleWatchdogError`), whose `name` is not
 * `'AbortError'`, so `isAbortError` rejects them and they THROW instead —
 * reaching the translator's catch and being classified correctly. They are
 * therefore NOT what produces this error, and adding a watchdog check here
 * would be dead code. Only consumers holding the abort context
 * (`loop/stream-consumer.ts`) can attribute a cause.
 */
export function incompleteStreamError(): StreamIncompleteError {
  return new StreamIncompleteError(
    'the model stream ended without a terminal message (no message_stop and ' +
      'no stop_reason): the turn is incomplete. The cause is not knowable at ' +
      'this layer — a client-side abort carrying an AbortError reason ' +
      '(including the SDK request timeout) and an upstream peer close are ' +
      'indistinguishable here. Check the trace for a preceding ttfb_timeout, ' +
      'idle_watchdog_fired, or rate_limit phase before suspecting the network.',
  );
}
