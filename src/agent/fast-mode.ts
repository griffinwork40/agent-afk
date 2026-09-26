export type FastModePreference = 'on' | 'off';
export type FastExecutionPath =
  | 'top-level' | 'child' | 'subagent' | 'skill' | 'compaction'
  | 'summarization' | 'one-shot' | 'auxiliary';
export type FastModeInactiveReason =
  | 'preference-off' | 'unsupported-provider' | 'custom-endpoint'
  | 'excluded-execution-path' | 'unsupported-model';

export interface FastModeContext {
  resolvedModelId: string;
  providerFamily: string;
  hasCustomEndpoint: boolean;
  executionPath: FastExecutionPath;
  /**
   * Optional pre-computed model eligibility for the current provider.
   * When supplied, skips the per-provider model check inside
   * `resolveFastModeStatus` — the caller is responsible for determining
   * eligibility (e.g. by consulting the Codex models catalog or a static
   * regex). `undefined` = "not yet determined; use built-in check".
   */
  modelEligible?: boolean;
}

export type FastModeStatus = Readonly<{
  preference: FastModePreference;
  effective: boolean;
  reason?: FastModeInactiveReason;
}>;
export type FastTurnDecision = FastModeStatus;

// ── Provider capability table ─────────────────────────────────────────────────

/**
 * Providers that support fast mode. Expressed as a Set rather than an
 * if-chain so adding a new provider is a one-line change here (plus the
 * per-provider model-eligibility path below).
 *
 * Contract: `'chatgpt-oauth'` routes to `'openai-compatible'` at the
 * provider-family level (see `providers/index.ts:providerForModel`), so
 * only `'openai-compatible'` appears in this set. Both ChatGPT-OAuth and
 * API-key OpenAI sessions share the same provider-family string.
 */
const FAST_CAPABLE_PROVIDERS = new Set([
  'anthropic-direct',
  'openai-compatible',
]);

/**
 * Anthropic: supported Opus models for the Fast tier.
 * Matches dateless keys AND dated wire ids via the `(?:-[a-z0-9]…)?` suffix.
 */
const SUPPORTED_OPUS = /^claude-opus-(?:5(?:-5)?|4-8)(?:-[a-z0-9][a-z0-9-]*)?$/;

/**
 * OpenAI fallback allowlist (used when the Codex models catalog is absent or
 * does not list the model). Covers gpt-5.5, gpt-5.6-*, gpt-6-*, and
 * gpt-reserve. A dated snapshot suffix (e.g. `-2026-09-01`) is allowed by the
 * `(?:-[a-z0-9]…)?` suffix pattern, matching how SUPPORTED_OPUS treats dates.
 *
 * Contract: this is the FALLBACK — the catalog reader in
 * `providers/openai-compatible/models-catalog.ts` is the source of truth when
 * the file is present. Any model the catalog lists as having a `priority`
 * service tier is eligible regardless of this regex.
 */
export const OPENAI_FAST_MODEL_FALLBACK =
  /^(?:gpt-5\.5|gpt-5\.6-[a-z]+|gpt-6-[a-z]+|gpt-reserve)(?:-[a-z0-9][a-z0-9-]*)?$/;

/**
 * Check whether a resolved model id is eligible for OpenAI fast mode.
 *
 * Delegates to the caller-supplied `modelEligible` field when present (the
 * Codex catalog path). Falls back to `OPENAI_FAST_MODEL_FALLBACK` otherwise.
 *
 * Pure: no I/O, no module state. Catalog reads happen upstream in the
 * `FastModeContext` assembly (bootstrap-slash-context / prepareTurnRequest).
 */
function isOpenAIModelEligible(context: FastModeContext): boolean {
  if (context.modelEligible !== undefined) return context.modelEligible;
  return OPENAI_FAST_MODEL_FALLBACK.test(context.resolvedModelId);
}

// ── Core resolver ─────────────────────────────────────────────────────────────

export function resolveFastModeStatus(
  preference: FastModePreference,
  context: FastModeContext,
): FastModeStatus {
  if (preference === 'off') return Object.freeze({ preference, effective: false, reason: 'preference-off' });
  if (!FAST_CAPABLE_PROVIDERS.has(context.providerFamily)) return Object.freeze({ preference, effective: false, reason: 'unsupported-provider' });
  if (context.hasCustomEndpoint) return Object.freeze({ preference, effective: false, reason: 'custom-endpoint' });
  if (context.executionPath !== 'top-level') return Object.freeze({ preference, effective: false, reason: 'excluded-execution-path' });

  // Per-provider model eligibility.
  if (context.providerFamily === 'anthropic-direct') {
    if (!SUPPORTED_OPUS.test(context.resolvedModelId)) return Object.freeze({ preference, effective: false, reason: 'unsupported-model' });
  } else if (context.providerFamily === 'openai-compatible') {
    if (!isOpenAIModelEligible(context)) return Object.freeze({ preference, effective: false, reason: 'unsupported-model' });
  } else {
    // Future providers: default to model-ineligible until explicitly listed.
    return Object.freeze({ preference, effective: false, reason: 'unsupported-model' });
  }

  return Object.freeze({ preference, effective: true });
}

export class FastModeController {
  private preference: FastModePreference;
  constructor(initial: FastModePreference = 'off') { this.preference = initial; }
  getPreference(): FastModePreference { return this.preference; }
  setPreference(preference: FastModePreference): void { this.preference = preference; }
  resolveStatus(context: FastModeContext): FastModeStatus {
    return resolveFastModeStatus(this.preference, context);
  }
  snapshotTurn(context: FastModeContext): FastTurnDecision {
    return this.resolveStatus(context);
  }
}
