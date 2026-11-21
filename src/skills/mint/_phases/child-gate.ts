/**
 * Surface approval gate for /mint phase forks.
 *
 * Contract: mirrors model-fallback.ts. The mint handler records
 * `ctx.childGate` (SkillExecutionContext) keyed by the parent session id at
 * the same points it records the model fallback; every mint fork site reads it
 * back with {@link mintChildGate} and spreads the result into its fork
 * `config`, so each phase child's dispatcher consults the surface callback.
 * Absent gate => nothing stored and `{}` spread (fork configs unchanged).
 *
 * @module skills/mint/_phases/child-gate
 */

import type { CanUseTool } from '../../../agent/types.js';
import { forkConfigGate } from '../../../agent/tools/nesting.can-use-tool.js';

type ChildGate = (agentType: string) => CanUseTool | undefined;

const gateBySession = new Map<string, ChildGate>();

export function setMintChildGate(parentSessionId: string, gate: ChildGate | undefined): void {
  if (gate === undefined) gateBySession.delete(parentSessionId);
  else gateBySession.set(parentSessionId, gate);
}

/** Spread into a mint fork's `config`: `{ canUseTool }` when a gate is recorded. */
export function mintChildGate(parentSessionId: string | undefined, agentType: string): { canUseTool: CanUseTool } | Record<string, never> {
  const gate = parentSessionId === undefined ? undefined : gateBySession.get(parentSessionId);
  return forkConfigGate(gate, agentType);
}

/** The recorded gate itself, for a nested inline handler's SkillExecutionContext. */
export function mintChildGateOpt(parentSessionId: string | undefined): { childGate: ChildGate } | Record<string, never> {
  const gate = parentSessionId === undefined ? undefined : gateBySession.get(parentSessionId);
  return gate !== undefined ? { childGate: gate } : {};
}
