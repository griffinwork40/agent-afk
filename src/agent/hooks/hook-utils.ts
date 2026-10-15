/**
 * Shared predicates and helpers for hook implementations.
 *
 * @module agent/hooks/hook-utils
 */

import type { HookContext } from '../hooks.js';
import type { ForkSignals } from '../memory/memory-hot-guard.js';

/**
 * Predicate: does this hook context belong to a sub-agent session?
 * Handles the `SubagentStopContext` variant, which may lack the field.
 *
 * Accepts optional `extraSignals` (the same {@link ForkSignals} shape used by
 * `isForkedChildSession`) so that hook factories capturing fork signals at
 * construction time — notably `createChildMemoryHotBlockHook` — can detect
 * skill forks whose `PreToolUseContext` carries no `parentSessionId` (stub-
 * parent forks set only `subagentToolOutputCapBytes`).
 */
export function isSubagentContext(context: HookContext, extraSignals?: ForkSignals): boolean {
  if ('parentSessionId' in context && context.parentSessionId !== undefined) return true;
  if (extraSignals?.parentSessionId !== undefined) return true;
  if (extraSignals?.subagentToolOutputCapBytes !== undefined) return true;
  return false;
}

/**
 * Resolve the session id for a hook command invocation.
 *
 * Contract: prefer the live `context.sessionId` over the registration-time
 * `registrationSessionId` so command hooks fired on the REPL / `afk chat`
 * surfaces receive the provider-assigned id rather than `undefined`.
 * `SubagentStartContext` and `SubagentStopContext` carry no `sessionId` field,
 * so for those events the registration-time fallback is the only source.
 *
 * Invariant: this function is the single merge point for hook command session
 * id resolution — do not inline the precedence in callers.
 */
export function resolveContextSessionId(
  context: HookContext,
  registrationSessionId: string | undefined,
): string | undefined {
  if ('sessionId' in context && context.sessionId !== undefined) return context.sessionId;
  return registrationSessionId;
}
