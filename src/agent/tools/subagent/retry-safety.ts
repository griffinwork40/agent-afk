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
   * Only the first case is dangerous, and it is reachable only when the
   * surface also carries the dispatch tool — which is exactly how the guard
   * below is conditioned.
   */
  nestedAgentTypes: readonly string[] | undefined;
}

/**
 * True only when re-running this child's entire prompt is provably free of
 * persistent side effects.
 *
 * Invariant: a re-dispatch replays the prompt against a brand-new child, so
 * every capability the child could reach fires a SECOND time. Authorization
 * therefore has to cover the transitive closure of that reach, not just the
 * child's own tool names. Two independent conditions:
 *
 *   1. Every granted tool is a member of the audited replay-safe contract.
 *      An unrestricted surface (`undefined`) fails closed rather than being
 *      guessed at, and `bash` is absent from the contract because its
 *      read-only classifier is best-effort and cannot prove replay safety.
 *   2. If the surface grants nested dispatch, that dispatch must be
 *      MECHANICALLY SCOPED. `STREAM_CUT_RETRY_SAFE_TOOLS` admits `agent` on
 *      the strength of scoped grants like `research-agent`'s
 *      `Agent(git-investigator)`, but a flat name check would also admit a
 *      bare `Agent` token — which resolves to unrestricted nesting, leaves
 *      `nestedAgentAllowlist` unset, and lets `subagent-executor`'s dispatch
 *      gate through `general-purpose` (inherit-all: `write_file`, `edit_file`,
 *      `bash`) as a GRANDCHILD. Replaying that prompt re-fires the
 *      grandchild's writes — precisely the double-fire this gate exists to
 *      prevent. So an unscoped grant fails closed, mirroring the depth-1
 *      reasoning one level down.
 */
export function isChildReplaySafe(input: ReplaySafetyInput): boolean {
  const { effectiveAllowedTools, nestedAgentTypes } = input;
  if (effectiveAllowedTools === undefined) return false;
  if (!effectiveAllowedTools.every((tool) => STREAM_CUT_RETRY_SAFE_TOOL_SET.has(tool))) {
    return false;
  }
  if (effectiveAllowedTools.includes(NESTED_DISPATCH_TOOL) && nestedAgentTypes === undefined) {
    return false;
  }
  return true;
}
