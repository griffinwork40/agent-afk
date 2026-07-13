/**
 * Shared telemetry helpers for the skill-executor module family.
 *
 * Formerly module-scope privates of `skill-executor.ts`; extracted so the
 * facade (inline registry path), `load-mode.ts`, and the fork paths can all
 * emit routing-decision rows with the same gate roster, truncation bound,
 * and session-identity derivation. No mutable state lives here — `GATE_SKILLS`
 * is a read-only roster.
 *
 * @module agent/tools/skill-executor/telemetry
 */

import { deriveOrigin, actorFromDepth, type TraceOrigin, type TraceActor } from '../../session/session-identity.js';
import type { SkillExecutorContext } from './types.js';

// Invariant: "gate" skills fire as routing-hint disciplines and are frequently
// applied INLINE — the model follows the hint without dispatching the skill
// tool. Tagging dispatched gate invocations gives partial gate-firing
// visibility; fully inline applications stay uncountable here without model
// self-report. This roster is the semantic gate category — keep it in sync with
// the routing-hint gates in the system prompt's skill-routing section.
export const GATE_SKILLS = new Set<string>([
  'ask-gate',
  'fanout-pace',
  'right-size-delegation',
  'premise-gate',
  'intent-lock',
  'long-bash-gate',
  'exploration-gate',
  'irreversible-action-gate',
  'safe-destruct',
  'plan-probe',
]);

export function isGateSkill(name: string): boolean {
  return GATE_SKILLS.has(name);
}

/**
 * Maximum length of `error_message` written to routing-decisions.jsonl.
 * Honors the routing-telemetry privacy contract (§G.4: short error message,
 * no stack traces, no user content). Mirrors subagent-executor's local
 * `truncate` (subagent-executor.ts:158) — kept local so each emitter owns
 * its own bounds and the telemetry helper stays schema-only.
 */
export const MAX_TELEMETRY_ERROR_CHARS = 240;

export function truncateTelemetryString(s: string, max = MAX_TELEMETRY_ERROR_CHARS): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/**
 * Session-identity fields for telemetry rows (skill-invocations + routing).
 * Only populated when this executor was wired with a `surface` (the Stage B
 * top-level wiring); legacy/un-threaded contexts return `{}` so rows omit
 * `origin`/`actor`, preserving back-compat. `actor` derives from `depth`
 * (>0 ⟺ this executor is owned by a subagent).
 */
export function sessionIdentity(ctx: SkillExecutorContext): { origin?: TraceOrigin; actor?: TraceActor } {
  return ctx.surface !== undefined
    ? { origin: deriveOrigin(ctx.surface), actor: actorFromDepth(ctx.depth) }
    : {};
}
