/**
 * Zod schemas for `session_phase` trace payloads, extracted from
 * {@link ./events} to keep that module under the 350-code-line ceiling.
 * Re-exported from `./events` — import from there. The TypeScript
 * `SessionPhaseName` union in {@link ./types} is the canonical list; this
 * enum must mirror it (see session-phase.test.ts parity check).
 *
 * @module agent/trace/events.session-phase
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// session_phase
// ---------------------------------------------------------------------------

export const SessionPhaseNameSchema = z.enum([
  'bootstrap_start',
  'bootstrap_done',
  'session_init_start',
  'session_init_done',
  'mcp_connect_start',
  'mcp_connect_done',
  'mcp_server_start',
  'mcp_server_done',
  'loop_start',
  'loop_end',
  'model_ttfb',
  // Interrupt→halt latency (single event, no paired start). See SessionPhaseName
  // JSDoc in types.ts — carries the ESC→terminal wall-clock in durationMs.
  'interrupt_halt',
  'rate_limit',
  // Client-side TTFB watchdog re-drive — distinct from `rate_limit` (no server
  // throttle, no retry-after). See SessionPhaseName JSDoc in types.ts.
  'ttfb_timeout',
  'usage_limit_pause',
  'usage_limit_resume',
  // Mid-stream overload (529) exhaustion park/unpark. See SessionPhaseName
  // JSDoc in types.ts — wall-clock bounded, no reset deadline to key on.
  'overload_pause',
  'overload_resume',
  'idle_watchdog_fired',
  // A fork's wall-clock ceiling granted a bounded pause extension (see
  // subagent/pause-ceiling.ts). Single event per grant; metadata carries
  // subagentId, grantMs, totalGrantedMs, remainingCapMs, grantCount, and
  // optionally pauseDescription.
  'pause_extension_granted',
  'suspected_loop',
  // Per-session compaction disable (single event, at most once). See
  // SessionPhaseName JSDoc in types.ts — metadata names the wire and cause.
  'compaction_disabled',
  // One bootstrap warning, emitted per-warning at push time (#754). See
  // SessionPhaseName JSDoc in types.ts — metadata carries producer + message.
  'boot_warning',
  // Workspace subscription lifecycle. See SessionPhaseName JSDoc in types.ts.
  'workspace_subscribed',
  'workspace_delivery',
  // Gate-shape telemetry for parallel dispatch (#1924). See SessionPhaseName
  // JSDoc in types.ts — metadata carries safeCount, unsafeCount, parallelGatesMs.
  'gate_shape',
  // Session-identity assignment. See SessionPhaseName JSDoc in types.ts.
  // `sessionId` on the payload carries the provider-issued id; present only
  // on this phase kind. Absent on all older traces — treat absence as unknown.
  'session_id_assigned',
  // Many-image dimension guard replacement. See SessionPhaseName JSDoc in
  // types.ts — metadata carries degradedCount, threshold, maxDimension.
  'many_image_degraded',
  // Mid-stream transport drop accepted as clean completion (#2780).
  // See SessionPhaseName JSDoc in types.ts for the full contract.
  'stream_accepted_after_drop',
  // Connection-phase network retry. See SessionPhaseName JSDoc in types.ts.
  'connection_retry',
  'usage_notice',
]);

export const SessionPhasePayloadSchema = z.object({
  phase: SessionPhaseNameSchema,
  durationMs: z.number().nonnegative().optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  // Model provenance — see SessionPhasePayload JSDoc in types.ts. `model` is
  // the operator-typed alias, `resolvedModel` the wire id. Both optional:
  // present on session_init_start; resolvedModel also on model_ttfb.
  model: z.string().optional(),
  resolvedModel: z.string().optional(),
  // Session-identity attribution — see SessionPhasePayload JSDoc in types.ts.
  // `origin` = user-facing surface; `actor` = main vs subagent. Both set on
  // session_init_start. Orthogonal to the JSONL `surface: 'afk'|'plugin'`
  // provenance tag.
  //
  // Invariant: this enum must list every member of the `origin` union in
  // types.ts. It is a runtime value, so `tsc` cannot flag divergence — a
  // surface present in the TS union but missing here makes writer.ts's
  // `.parse()` throw, which emit.ts swallows, silently dropping the whole
  // session_init_start record for that surface. That is how `'web'` lost its
  // trace events until this line was widened.
  origin: z.enum(['cli', 'telegram', 'daemon', 'web', 'unknown']).optional(),
  actor: z.enum(['main', 'subagent']).optional(),
  // Session id assignment — set ONLY on `session_id_assigned` phase events.
  // Absent on all other phase kinds and on older traces. See SessionPhasePayload
  // JSDoc in types.ts for the backward-compat contract.
  sessionId: z.string().optional(),
  priorSessionId: z.string().optional(),
});
