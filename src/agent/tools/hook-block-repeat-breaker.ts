/**
 * Hook-block repeat circuit breaker (#3736).
 *
 * Agents sometimes retry slight variants of a blocked tool call after a
 * `PreToolUse` block — varying a path, a flag, or a parameter — without
 * the block condition changing. The existing breakers miss this:
 *   - The byte-identical repeat breaker ({@link ./repeat-circuit-breaker})
 *     requires IDENTICAL inputs; any variation resets it.
 *   - The denial circuit breaker ({@link ./denial-circuit-breaker}) targets
 *     only path-approval READ containment denials in forked children.
 *
 * This breaker closes the gap by counting consecutive `PreToolUse` blocks
 * keyed on a **stable gate identity** — `toolName` alone (conservative:
 * hooks do not yet expose a stable id; toolName is the framework-owned
 * stable component of every hook block on a given tool). The count resets
 * on any successful tool call — identical to the denial breaker's invariant.
 *
 * Behaviours at {@link HOOK_BLOCK_REPEAT_THRESHOLD} consecutive blocks
 * (same gate key, no intervening success):
 *   - **Forked children** (`parentSessionId` set): the result is upgraded to
 *     `failureClass: 'hook-block-repeat'`, which the provider loop surfaces as
 *     a loud `error` event — the same path the denial breaker uses.
 *   - **Top-level sessions**: a one-time escalation message is appended to
 *     the block reason instructing the agent to stop retrying and report
 *     Blocked, rather than aborting the session outright (a human is present
 *     and can redirect).
 *
 * The trip is recorded as a `hook_block_repeat_tripped` `session_phase`
 * event so witness traces capture it.
 *
 * @module agent/tools/hook-block-repeat-breaker
 */

import type { ToolFailureClass } from '../trace/types.js';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Consecutive `PreToolUse` blocks on the same gate key (with no intervening
 * successful tool call) after which the breaker trips.
 *
 * Chosen as 3: one extra variant is a reasonable probe; two or more variants
 * on the same blocked tool signals a spin. Deliberately lower than
 * {@link DENIAL_CIRCUIT_BREAKER_THRESHOLD} (5) because block-retry loops
 * on a human-gated interactive session are more disruptive.
 */
export const HOOK_BLOCK_REPEAT_THRESHOLD = 3;

/**
 * The `failureClass` stamped on the upgraded result for forked children.
 * Consumed by the provider tool-use loops to surface a loud `error` event.
 * Member of {@link ToolFailureClass} (see `trace/types.ts`).
 */
export const HOOK_BLOCK_REPEAT_FAILURE_CLASS: ToolFailureClass = 'hook-block-repeat';

/**
 * Derive a stable gate identity from a tool name.
 *
 * Conservative derivation: the tool name is the framework-owned, stable
 * component of every `PreToolUse` block. Hook `reason` text is deliberately
 * excluded — it is free-form, may carry path or parameter fragments, and
 * changes across retries, which is exactly the variant pattern we want to catch.
 * When hooks expose a stable id in the future, this function can incorporate
 * it without changing call sites.
 */
export function gateKey(toolName: string): string {
  return toolName;
}

// ---------------------------------------------------------------------------
// Mutable state (per-dispatcher, owned by PreDispatchGateMutableState)
// ---------------------------------------------------------------------------

/**
 * Mutable state for the hook-block repeat breaker. Null when the count has
 * been reset (no block since the last successful tool call).
 */
export interface HookBlockRepeatState {
  /** The stable gate key that is currently accumulating. */
  key: string;
  /** Number of consecutive blocks seen for this key. */
  count: number;
  /** True once the trip message has been appended (top-level sessions only). */
  escalated: boolean;
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * Record a consecutive `PreToolUse` block and return the updated count.
 * Caller owns the state object; mutates in place.
 */
export function recordHookBlock(
  state: HookBlockRepeatState | null,
  toolName: string,
): { state: HookBlockRepeatState; count: number } {
  const key = gateKey(toolName);
  if (state !== null && state.key === key) {
    state.count += 1;
    return { state, count: state.count };
  }
  const next: HookBlockRepeatState = { key, count: 1, escalated: false };
  return { state: next, count: 1 };
}

/**
 * Reset the breaker on any successful tool call. Returns null (the cleared
 * state), typed for direct assignment to the state field.
 */
export function resetHookBlockRepeat(): null {
  return null;
}

/**
 * Build the loud fork-abort message embedded in the upgraded `ToolResult`.
 */
export function buildHookBlockRepeatMessage(toolName: string, count: number): string {
  return (
    `Hook-block repeat circuit breaker: "${toolName}" has been blocked by a ` +
    `PreToolUse hook ${count} times in a row with no successful tool call in ` +
    `between. The block condition has not changed. Stop retrying variants of ` +
    `this call — the hook will continue to deny it. If the task genuinely ` +
    `requires this tool, stop and report Blocked to your caller with the ` +
    `hook's reason so it can re-dispatch with wider permissions or a ` +
    `different approach.`
  );
}

/**
 * Build the one-time escalation suffix appended to the block reason for
 * top-level (non-forked) sessions. Appended once; subsequent blocks on the
 * same key after trip are returned unchanged (no double-append).
 */
export function buildHookBlockRepeatEscalation(toolName: string, count: number): string {
  return (
    `\n\n[Hook-block repeat breaker] "${toolName}" has been blocked ${count} ` +
    `consecutive times by the same hook gate. Stop retrying variants — the ` +
    `block condition is stable. Report Blocked and explain why you cannot ` +
    `proceed without this tool.`
  );
}
