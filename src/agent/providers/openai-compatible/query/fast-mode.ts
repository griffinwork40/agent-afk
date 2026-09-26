/**
 * OpenAI fast-mode support for the `openai-compatible` provider.
 *
 * Mirrors `anthropic-direct/query/turn-request.ts`'s fast-mode pattern:
 *   1. `snapshotFastDecision` snapshots the turn-level decision once from the
 *      `FastModeController`, keyed on `'openai-compatible'` as the provider
 *      family, and pre-resolves model eligibility from the Codex catalog (or
 *      the static fallback regex).
 *   2. `snapshotFastDecision` ONLY returns effective=true for `'top-level'`
 *      execution paths — subagents, skills, compaction, etc. are excluded.
 *   3. When effective, `FastTierSession` (fast-tier-session.ts) adds
 *      `service_tier: "priority"` to the request body at create time.
 *   4. `extract*ServiceTier` read the response's `service_tier` field and
 *      `makeFastModeMismatchWarning` words the one-time downgrade notice.
 *   5. `isFastModeServiceTierError` detects HTTP 400 errors that mention
 *      `service_tier`/`priority` so the caller can latch-disable fast for the
 *      session and retry without the field.
 *
 * Contract: the `FastModeController` is only accessed at turn-snapshot time
 * (once per turn) — not every round. Toggling `/fast` off mid-turn has no
 * effect on the current turn; it takes effect on the next.
 *
 * @module agent/providers/openai-compatible/query/fast-mode
 */

import type { FastModeController, FastTurnDecision } from '../../../fast-mode.js';
import { isCatalogModelPriorityEligible } from '../models-catalog.js';

/**
 * Snapshot the fast-mode decision for the current turn.
 *
 * Contract: called ONCE per turn inside `_runTurnInner` (before the first
 * `runIteration`), not per iteration, so toggling fast mid-turn has no effect
 * on the current turn. Only top-level sessions resolve effective=true — the
 * controller itself gates on `executionPath: 'top-level'`.
 *
 * Model eligibility is pre-resolved here (catalog → fallback regex) and passed
 * as `modelEligible` into the context so `resolveFastModeStatus` stays pure.
 *
 * The `hasCustomEndpoint` parameter must be `false` for the ChatGPT-OAuth
 * backend (CHATGPT_BACKEND_BASE_URL) — that is a first-party endpoint, not
 * a user-set proxy. The caller is responsible for this distinction.
 */
export function snapshotFastDecision(
  controller: FastModeController | undefined,
  model: string,
  hasCustomEndpoint: boolean,
): FastTurnDecision | undefined {
  if (!controller) return undefined;
  const catalogEligible = isCatalogModelPriorityEligible(model);
  return controller.snapshotTurn({
    resolvedModelId: model,
    providerFamily: 'openai-compatible',
    hasCustomEndpoint,
    executionPath: 'top-level',
    // Pass pre-resolved eligibility so the resolver stays pure.
    ...(catalogEligible !== undefined ? { modelEligible: catalogEligible } : {}),
  });
}

/**
 * Detect whether an error is a 400 that mentions `service_tier` or `priority`.
 *
 * Used to latch-disable fast mode for the rest of the session when the API
 * rejects the `service_tier` field with a deterministic client error.
 *
 * Contract: returns true ONLY for HTTP 400 whose message text contains
 * `service_tier` or `priority` (case-insensitive). Other 400s (e.g. a bad
 * model id, malformed body) must NOT trigger the latch.
 */
export function isFastModeServiceTierError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as Record<string, unknown>;
  const status = typeof e['status'] === 'number' ? e['status'] : undefined;
  if (status !== 400) return false;
  const message =
    (typeof e['message'] === 'string' ? e['message'] : '') +
    (typeof (e['error'] as Record<string, unknown> | undefined)?.['message'] === 'string'
      ? (e['error'] as Record<string, unknown>)['message']
      : '');
  const lower = message.toLowerCase();
  return lower.includes('service_tier') || lower.includes('priority');
}

/**
 * Extract the `service_tier` field from a Responses-API response object.
 *
 * The Responses API returns `service_tier` on the completed response object.
 * Returns `undefined` when the field is absent or not a string.
 */
export function extractResponsesServiceTier(
  responseObj: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!responseObj) return undefined;
  return typeof responseObj['service_tier'] === 'string'
    ? responseObj['service_tier']
    : undefined;
}

/**
 * Extract the `service_tier` field from a Chat Completions chunk.
 *
 * OpenAI adds this to the final chunk that also carries `usage`. Returns
 * `undefined` when the field is absent or not a string.
 */
export function extractChatCompletionsServiceTier(
  chunk: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!chunk) return undefined;
  return typeof chunk['service_tier'] === 'string' ? chunk['service_tier'] : undefined;
}

/**
 * Returns a user-visible warning string when fast was requested but the
 * response reports a different tier. Returns `undefined` when no warning is
 * needed (tier matched, or no tier info is available).
 *
 * Contract: only fires when `fast === true` (requested) AND the applied tier
 * is present AND it is NOT `'priority'`. Absent applied tier = "provider did
 * not report tier", which is not a mismatch we can act on.
 */
export function makeFastModeMismatchWarning(
  fast: boolean,
  appliedTier: string | undefined,
): string | undefined {
  if (!fast) return undefined;
  if (appliedTier === undefined) return undefined;
  if (appliedTier === 'priority' || appliedTier === 'fast') return undefined;
  return (
    `Fast mode requested service_tier "priority" but OpenAI served this turn at tier "${appliedTier}", ` +
    `so it ran at standard speed; this model or account may not have fast mode available right now.`
  );
}
