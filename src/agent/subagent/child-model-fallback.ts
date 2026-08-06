/**
 * Cross-provider child-model fallback for forked sub-agents (issue #652).
 *
 * A forked child (agent-tool dispatch, skill fork, or compose node) resolves its
 * model from a `?? 'sonnet'`-terminated chain, or inherits an explicitly
 * Claude-pinned auto-dispatched agent (`git-investigator` → `sonnet`, `Explore`
 * → `haiku`; see `src/agent/agents/builtins.ts`). When the session is routed to
 * the `openai-compatible` provider — a global `AFK_PROVIDER=openai-compatible`
 * force, or a `chatgpt-oauth` / `openai` model slot — that Claude-family child
 * cannot run: the OpenAI / ChatGPT backend serves no Claude model and hard-errors
 * (`openai-compatible/query.ts`, the `isClaudeFamilyModel` guard). The child then
 * never executes, and for the auto-dispatched agents the operator has no recourse
 * (the pins are vendored / byte-locked).
 *
 * This module coerces such a child onto a provider-appropriate substitute — the
 * parent session's own model, which under this routing is the concrete
 * OpenAI/gpt target the session is already using — so the child runs instead of
 * dying. It is applied at `SubagentManager.forkSubagent`, the single choke point
 * through which every fork path converges.
 *
 * Issue #869: the Claude-family check must run on the TIER-RESOLVED id, not the
 * raw pin — see {@link isClaudeFamilyAfterTierResolution}, the sole difference
 * from the original #652 shape.
 */

import { providerForModel } from '../providers/index.js';
import { isClaudeFamilyModel } from '../providers/openai-compatible/responses-config.js';
import { resolveModelInput } from '../session/model-slots.js';

export interface ChildModelCoercion {
  /** The model the child should actually run — the substitute when coerced. */
  model: string | undefined;
  /**
   * The original model, set ONLY when a coercion happened. Callers use its
   * presence as the "did we override the caller's model" signal (for a warning
   * / trace note); left undefined on the common no-op path.
   */
  coercedFrom?: string;
}

/**
 * True when `model`, once resolved past a bare capability-tier alias
 * (`local`/`small`/`medium`/`large`, or a custom tier name — see
 * `model-slots.ts`), is a Claude-family id.
 *
 * Issue #869: `isClaudeFamilyModel` pattern-matches the literal string and has
 * no notion of tier indirection by design (it stays self-contained to avoid an
 * import cycle through the provider registry). A child pinned to the bare tier
 * name `medium` reads as "not Claude-family" even when that tier is BOUND to
 * `claude-sonnet-5` — so the raw predicate misses exactly the case this module
 * exists to catch. `resolveModelInput` is a no-op on an already-concrete id or
 * a fixed identity alias (`sonnet`/`opus`/`haiku`/`claude-*`/`local-*`), so this
 * changes nothing for those pre-#869 paths.
 */
function isClaudeFamilyAfterTierResolution(model: string | undefined): boolean {
  return isClaudeFamilyModel(resolveModelInput(model));
}

/**
 * Decide the effective model for a forked child, substituting a Claude-family
 * model that would starve on this session's `openai-compatible` routing.
 *
 * Coerces iff ALL hold:
 *   1. `childModel` is a Claude-family id once tier-resolved
 *      (`isClaudeFamilyAfterTierResolution`), AND
 *   2. it currently ROUTES to `openai-compatible` — i.e. a global
 *      `AFK_PROVIDER` force (or a chatgpt-oauth/openai slot) has overridden the
 *      id's natural anthropic-direct routing, AND
 *   3. `parentModel` is a usable substitute: defined, not itself Claude-family,
 *      and itself routing to `openai-compatible`.
 *
 * The `providerForModel(childModel) === 'openai-compatible'` conjunct keeps this
 * false-positive-safe. `providerForModel` routes `claude-*` / `opus` / `sonnet`
 * / `haiku` AND the local Anthropic-shim `local-*` ids to `anthropic-direct`
 * (Tier 2) UNLESS a Tier-1 force overrides — so a Claude-family child in a normal
 * Anthropic session, and a `local-*` model on a local Anthropic shim, both route
 * anthropic-direct and are left untouched. Only the genuinely-broken
 * "Claude id forced onto an OpenAI endpoint" combination is coerced.
 *
 * When the parent is NOT a usable substitute (undefined, or itself a Claude id
 * force-routed to OpenAI — a misconfigured parent that fails on its own), the
 * child model is left unchanged so the provider's actionable error can fire.
 *
 * `providerForModel` reads env on every call, so this reflects the live
 * `AFK_PROVIDER` / slot routing at fork time without any threaded hints.
 */
export function coerceCrossProviderChildModel(
  childModel: string | undefined,
  parentModel: string | undefined,
): ChildModelCoercion {
  if (
    childModel === undefined ||
    !isClaudeFamilyAfterTierResolution(childModel) ||
    providerForModel(childModel) !== 'openai-compatible'
  ) {
    return { model: childModel };
  }
  if (
    parentModel === undefined ||
    isClaudeFamilyAfterTierResolution(parentModel) ||
    providerForModel(parentModel) !== 'openai-compatible'
  ) {
    return { model: childModel };
  }
  return { model: parentModel, coercedFrom: childModel };
}
