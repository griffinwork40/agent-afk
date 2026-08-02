/**
 * Stream-cut replay authorization — the single predicate that decides whether a
 * dead child's whole prompt may be re-run.
 *
 * Extracted from `child-config.ts` deliberately: this gate's entire value
 * proposition is that it is *provable*, so it lives in one auditable place
 * rather than inline among unrelated child-config wiring.
 */

import { STREAM_CUT_RETRY_SAFE_TOOLS } from '../../tool-category.js';

const STREAM_CUT_RETRY_SAFE_TOOL_SET = new Set(STREAM_CUT_RETRY_SAFE_TOOLS);

/**
 * The one member of the retry-safe set whose reach is TRANSITIVE rather than
 * local. Canonical lowercase: `normalizeAgentToolToken` lowercases every raw
 * token through `DISPATCH_TOOL_ALIASES` (`agents/resolve.ts`), so `Agent`,
 * `Task`, and `agent` all resolve to this name. Any other casing is absent
 * from the safe set and so already fails the membership test below.
 */
const NESTED_DISPATCH_TOOL = 'agent';

/**
 * The one tool whose replay safety is conditional on a gate rather than on set
 * membership. Absent from `STREAM_CUT_RETRY_SAFE_TOOLS` by design; admitted at
 * depth ≥2 only under the narrow, named exception documented on
 * {@link isChildReplaySafe}.
 */
const BASH_TOOL = 'bash';

/**
 * A scoped grandchild's resolved tool surface, flattened from
 * `resolveAgentToolAccess`. Supplied as plain DATA rather than a registry
 * handle so this module stays pure and unit-testable without I/O.
 */
export interface NestedAgentSurface {
  /** The leaf's effective allowlist. `undefined` = inherit-all — never safe. */
  allowedTools: readonly string[] | undefined;
  /** Whether the leaf's `bash` is mechanically read-only gated. */
  bashReadOnly: boolean;
  /** The leaf's OWN nested-dispatch scope (same overloaded encoding as below). */
  nestedAgentTypes: readonly string[] | undefined;
}

export interface ReplaySafetyInput {
  /**
   * The child's effective tool surface (definition ∩ cage). `undefined` means
   * unrestricted/unknown — never replay-safe.
   */
  effectiveAllowedTools: readonly string[] | undefined;
  /**
   * The child's resolved nested-dispatch allowlist, straight from
   * `resolveAgentToolAccess`. Read `undefined` carefully — it is overloaded
   * (`agents/resolve.ts` `extractNestedAgentScope`):
   *   - a BARE `Agent`/`Task` token → `undefined` = UNRESTRICTED nesting
   *   - no dispatch token at all    → `undefined` = nesting never requested
   *   - `Agent()`                   → `[]`        = explicit deny-all
   *   - `Agent(a, b)`               → `['a','b']` = scoped to those types
   * Both `undefined` cases are refused, and scoping alone is NOT sufficient —
   * see condition 3 on {@link isChildReplaySafe}.
   */
  nestedAgentTypes: readonly string[] | undefined;
  /**
   * Registry lookup for a scoped grandchild type. ABSENT ⇒ no scoped name can
   * be resolved, so any NON-EMPTY scope fails closed (an empty `[]` deny-all
   * scope still clears, since it reaches nothing). Threaded from
   * `child-config.ts` off `args.agentRegistry` + `resolveAgentToolAccess`.
   */
  resolveNestedAgent?: (name: string) => NestedAgentSurface | undefined;
}

/**
 * A scoped grandchild is replay-safe only as a TERMINAL leaf: resolvable, not
 * inherit-all, granting no onward dispatch of its own, and otherwise inside the
 * replay-safe contract (plus the gated-bash exception).
 *
 * Refusing onward chains rather than recursing into them is deliberate: it
 * bounds the analysis at exactly two levels, so no cycle guard or depth counter
 * is needed for a mutually-scoped pair (`a` → `Agent(b)` → `Agent(a)`).
 */
function isNestedLeafReplaySafe(surface: NestedAgentSurface | undefined): boolean {
  if (surface === undefined) return false; // unresolvable name / no registry
  const { allowedTools, bashReadOnly, nestedAgentTypes } = surface;
  if (allowedTools === undefined) return false; // inherit-all grandchild
  // Non-terminal leaf: refuse rather than recurse. `Agent()` (deny-all, `[]`)
  // IS terminal — it reaches nothing — so it stays admissible.
  if (
    allowedTools.includes(NESTED_DISPATCH_TOOL) &&
    (nestedAgentTypes === undefined || nestedAgentTypes.length > 0)
  ) {
    return false;
  }
  return allowedTools.every(
    (tool) => STREAM_CUT_RETRY_SAFE_TOOL_SET.has(tool) || (tool === BASH_TOOL && bashReadOnly),
  );
}

/**
 * True only when re-running this child's entire prompt introduces no persistent
 * side effect that AFK can mechanically prevent — at this child's depth AND at
 * the one nested depth it can reach.
 *
 * Invariant: a re-dispatch replays the prompt against a brand-new child, so
 * every capability the child could reach fires a SECOND time. Authorization
 * therefore has to cover the reach of that replay, not just the child's own
 * tool names. Three conditions, all fail-closed:
 *
 *   1. Every granted tool is a member of the audited replay-safe contract.
 *      An unrestricted surface (`undefined`) fails closed rather than being
 *      guessed at, and `bash` is absent from the contract because its
 *      read-only classifier is best-effort and cannot prove replay safety.
 *   2. If the surface grants nested dispatch, that dispatch must be
 *      MECHANICALLY SCOPED. A bare `Agent` token resolves to unrestricted
 *      nesting, leaves `nestedAgentAllowlist` unset, and lets
 *      `subagent-executor`'s dispatch gate through `general-purpose`
 *      (inherit-all: `write_file`, `edit_file`, `bash`) as an UNCAGED
 *      grandchild — `child-config.ts` forwards the CAGE (absent at top level),
 *      so `nesting.ts` falls back to `CHILD_ALLOWED_TOOLS`. Unscoped fails closed.
 *   3. Scoping alone is NOT sufficient. `Agent(general-purpose)` is a scoped
 *      grant and still reaches that same uncaged, write-capable grandchild.
 *      Every scoped name is therefore RESOLVED through the registry and must be
 *      a replay-safe terminal leaf (see {@link isNestedLeafReplaySafe}).
 *
 * Contract: the guarantee is deliberately BOUNDED, and is not a blanket
 * provability claim.
 *
 *   - Depth ≥2 admits `bash` when the leaf is `bashReadOnly`-gated; depth 1
 *     never does. That asymmetry is an ACCEPTED, NAMED decision rather than a
 *     proof — `readonly-bash.ts` documents its classifier as best-effort,
 *     default-ALLOW, and explicitly NOT a security boundary. Condition 3 bounds
 *     the exposure: the leaf must be a named, registry-resolved, non-dispatching
 *     terminal (today only `git-investigator`, whose contract is git reads), so
 *     the residual risk is one audited agent's shell surface, not an open class.
 *   - Onward chains are REFUSED, not recursed, which caps the analysis at two
 *     levels and removes any need for a cycle or depth guard.
 */
export function isChildReplaySafe(input: ReplaySafetyInput): boolean {
  const { effectiveAllowedTools, nestedAgentTypes, resolveNestedAgent } = input;
  if (effectiveAllowedTools === undefined) return false;
  if (!effectiveAllowedTools.every((tool) => STREAM_CUT_RETRY_SAFE_TOOL_SET.has(tool))) {
    return false;
  }
  if (!effectiveAllowedTools.includes(NESTED_DISPATCH_TOOL)) return true;
  if (nestedAgentTypes === undefined) return false; // unscoped ⇒ unrestricted
  // No resolver ⇒ nothing can be proven about a named leaf, so only the
  // deny-all scope (`[]`, which reaches nothing) can clear.
  if (resolveNestedAgent === undefined) return nestedAgentTypes.length === 0;
  return nestedAgentTypes.every((name) => isNestedLeafReplaySafe(resolveNestedAgent(name)));
}
