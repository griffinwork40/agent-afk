/**
 * Trace emission helper for the `session_id_assigned` phase event.
 *
 * Extracted so the emission logic is testable in isolation from the full
 * provider-lifecycle wiring. The emitter is called from
 * {@link SessionStateManager}'s `onSessionIdAssigned` callback — itself
 * wired in `buildProviderLifecycle` — so it fires exactly once per new or
 * changed session id, before any dependent work can act on the identity.
 *
 * Consumers: downstream tools (friction analyzer, `afk insights`, harvest)
 * that need to join a trace file (keyed by its directory label) to a
 * SessionFacet or ledger entry (keyed by session id). They should:
 *   1. Scan events for `kind === 'session_phase' && payload.phase === 'session_id_assigned'`.
 *   2. Read `payload.sessionId` as the canonical durable id.
 *   3. Fall back gracefully when the event is absent (old trace format).
 *
 * @module agent/session/session-id-trace
 */

import { emitSessionPhase } from '../trace/emit.js';
import type { TraceSink } from '../trace/index.js';

/**
 * Emit a `session_id_assigned` trace event.
 *
 * Safe to call fire-and-forget (returns a Promise that the caller need
 * not await). `emitSessionPhase` already swallows writer errors — this
 * wrapper exists solely to name the intent at the call site.
 *
 * @param writer     - The active trace sink, or `undefined` when tracing
 *                     is disabled. No-op when absent.
 * @param sessionId  - The newly assigned provider-issued session id.
 * @param priorSessionId - The id that was set before this call, or
 *                     `undefined` on first assignment.
 */
export function emitSessionIdAssigned(
  writer: TraceSink | undefined,
  sessionId: string,
  priorSessionId: string | undefined,
): Promise<void> {
  return emitSessionPhase(writer, {
    phase: 'session_id_assigned',
    sessionId,
    ...(priorSessionId !== undefined ? { priorSessionId } : {}),
  });
}
