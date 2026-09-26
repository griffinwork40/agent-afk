/**
 * Per-query fast-mode state for the `openai-compatible` provider.
 *
 * OpenAI's fast mode is the request field `service_tier: "priority"` (OpenAI
 * also accepts the alias `"fast"`, but Codex CLI always sends `"priority"`, so
 * we do too). It is honoured on BOTH the public API-key path and the ChatGPT
 * subscription backend (chatgpt.com/backend-api/codex) — Codex sends it on
 * both. See https://platform.openai.com/docs/guides/fast-mode.
 *
 * Invariant: the fast decision is snapshotted ONCE per turn (`beginTurn`), so
 * toggling `/fast` mid-turn takes effect on the next turn, mirroring
 * anthropic-direct/query/turn-request.ts#prepareTurnRequest. Subagents never
 * go fast: their providers are built in tools/nesting.ts without a
 * FastModeController, so `controller` is undefined for every fork.
 *
 * Invariant: the response's `service_tier` reports the tier actually applied
 * and may be a silent downgrade to `"default"`. We price and report what was
 * applied, never what was requested.
 *
 * @module agent/providers/openai-compatible/query/fast-tier-session
 */

import type { FastModeController } from '../../../fast-mode.js';
import type { ProviderEvent } from '../../../provider.js';
import { CHATGPT_BACKEND_BASE_URL } from '../responses-config.js';
import {
  extractChatCompletionsServiceTier,
  extractResponsesServiceTier,
  isFastModeServiceTierError,
  makeFastModeMismatchWarning,
  snapshotFastDecision,
} from './fast-mode.js';

/** Wire value sent for fast mode (Codex parity: ServiceTier::Fast => "priority"). */
export const OPENAI_FAST_SERVICE_TIER = 'priority';

/** Applied-tier values that confirm the request was served on the fast tier. */
const CONFIRMED_FAST_TIERS = new Set(['priority', 'fast']);

/**
 * A user-set OpenAI base URL (proxy / local runner) counts as a custom
 * endpoint and is excluded from fast mode. The first-party ChatGPT
 * subscription backend does NOT count, even though it has its own URL.
 */
export function isCustomOpenAIEndpoint(baseURL: string | undefined): boolean {
  return baseURL !== undefined && baseURL !== CHATGPT_BACKEND_BASE_URL;
}

/** Options the provider threads into the query to enable fast mode. */
export interface FastTierOptions {
  controller: FastModeController;
  hasCustomEndpoint: boolean;
}

export class FastTierSession {
  /** Latched when the API rejected `service_tier`; fast stays off for the session. */
  private rejected = false;
  private warned = false;
  private turnFast = false;
  private appliedTier: string | undefined;
  private pendingNotice: string | undefined;

  constructor(private readonly opts: FastTierOptions | undefined) {}

  /** Snapshot the fast decision for a new turn. Returns whether this turn goes fast. */
  beginTurn(model: string): boolean {
    this.appliedTier = undefined;
    this.turnFast = !this.rejected && this.opts !== undefined &&
      snapshotFastDecision(this.opts.controller, model, this.opts.hasCustomEndpoint)?.effective === true;
    return this.turnFast;
  }

  /** Whether requests in the current turn should carry `service_tier`. */
  get active(): boolean {
    return this.turnFast && !this.rejected;
  }

  /**
   * Issue a create call, attaching `service_tier` while active. If the API
   * rejects the field (HTTP 400 naming service_tier/priority), latch fast off
   * for the session and retry once without it. Every other error propagates
   * untouched so the shared retry/clarify path sees the original.
   */
  async create<T>(body: Record<string, unknown>, call: (b: Record<string, unknown>) => Promise<T>): Promise<T> {
    if (!this.active) return call(body);
    try {
      return await call({ ...body, service_tier: OPENAI_FAST_SERVICE_TIER });
    } catch (err) {
      if (!isFastModeServiceTierError(err)) throw err;
      this.rejected = true;
      this.queueNotice(
        'Fast mode was turned off for this session because OpenAI rejected service_tier "priority"; retrying at standard speed.',
      );
      return call(body);
    }
  }

  /** Record the applied tier from a Responses-API stream event. */
  observeResponsesEvent(event: unknown): void {
    const ev = event as { type?: unknown; response?: Record<string, unknown> | null };
    if (ev.type === 'response.completed') this.recordApplied(extractResponsesServiceTier(ev.response));
  }

  /** Record the applied tier from a Chat Completions chunk. */
  observeChatChunk(chunk: unknown): void {
    this.recordApplied(extractChatCompletionsServiceTier(chunk as Record<string, unknown>));
  }

  /** True when this turn requested fast AND the response confirmed the fast tier. */
  confirmedFast(): boolean {
    return this.turnFast && this.appliedTier !== undefined && CONFIRMED_FAST_TIERS.has(this.appliedTier);
  }

  /** Yield any queued operator notice (tier downgrade or rejection latch). */
  *drainNotice(sessionId: string): Generator<ProviderEvent> {
    const text = this.pendingNotice;
    if (text === undefined) return;
    this.pendingNotice = undefined;
    yield { type: 'notice', text, kind: 'fast-tier', sessionId };
  }

  private recordApplied(tier: string | undefined): void {
    if (!this.active || tier === undefined) return;
    this.appliedTier = tier;
    if (this.warned || CONFIRMED_FAST_TIERS.has(tier)) return;
    const msg = makeFastModeMismatchWarning(true, tier);
    if (msg !== undefined) this.queueNotice(msg);
  }

  private queueNotice(text: string): void {
    if (this.warned) return;
    this.warned = true;
    this.pendingNotice = text;
  }
}
