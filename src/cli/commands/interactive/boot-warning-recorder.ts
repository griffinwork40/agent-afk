/**
 * Shared push+emit recorder for bootstrap warnings (#754).
 *
 * Both bootstrap-warning producers — the agent-registry builtin-shadow
 * callback (`bootstrap-infra.ts`) and the MCP config-loader warnings
 * (`bootstrap-mcp.ts`) — call this ONE function instead of pushing onto
 * `bootWarnings` directly. That is deliberate, not stylistic:
 *
 * Invariant: a warning must land in BOTH sinks with the identical string, or
 * `afk trace show` and the terminal-facing drain (`drainBootWarnings`) can
 * disagree about what was collected. That divergence already had to be
 * repaired once for the terminal side alone (#751 hoisted the bucket to
 * survive a bootstrap throw); routing both producers through one recorder
 * makes a second divergence structurally impossible rather than merely
 * disciplined.
 *
 * Emission happens at PUSH time — inside `bootstrapSession`, before either
 * drain site runs and before a possible bootstrap throw — because neither
 * drain site can reach a trace writer: `InteractiveCtx` exposes none, and
 * the abort path's `bootstrapSession` call has already thrown by the time
 * `interactive.ts` would try to read one. The writer is created before the
 * earliest producer fires, so covering push time covers every warning,
 * including ones that precede a throw.
 *
 * @module cli/commands/interactive/boot-warning-recorder
 */

import { emitSessionPhase } from '../../../agent/trace/emit.js';
import type { TraceWriter } from '../../../agent/trace/index.js';

/** Which producer collected the warning. Keep in sync with the two call
 *  sites — widening this set is explicitly out of scope for #754 (see the
 *  larger erased class named in the issue: path-approval, hook-registry,
 *  config-bridge, permissions-store, mcp/manager, tool-injector). */
export type BootWarningProducer = 'agent-registry' | 'mcp';

/**
 * Push `message` onto the caller-owned `bootWarnings` bucket (unchanged
 * terminal-facing behavior — `drainBootWarnings` still prints it post-clear
 * or on abort) AND emit a durable `boot_warning` session_phase event
 * carrying the same string. One event per warning, never aggregated:
 * `SessionPhasePayload.metadata` is a flat `Record<string, string | number |
 * boolean>` with no array support, so an aggregate would have to join
 * every warning into one unbounded field.
 *
 * `traceWriter` may be `undefined` (tracing disabled via
 * `AFK_TRACE_DISABLED=1`, or no writer constructed yet) — `emitSessionPhase`
 * no-ops in that case, so this function never needs its own guard.
 */
export function recordBootWarning(a: {
  bootWarnings: string[];
  traceWriter: TraceWriter | undefined;
  producer: BootWarningProducer;
  message: string;
}): void {
  a.bootWarnings.push(a.message);
  void emitSessionPhase(a.traceWriter, {
    phase: 'boot_warning',
    metadata: { producer: a.producer, message: a.message },
  });
}
