import { contextLimitFor } from '../../../model-limits.js';
import { contextWindowTokensUsed } from '../../shared/auto-compact.js';
import {
  contextGuardFraction,
  contextPressure,
  projectedContextTokens,
  traceContextPressure,
} from '../../shared/context-pressure.js';
import type { TurnDriverContext } from './turn-driver.js';

/** Max output tokens reserved for the bounded synthesis pass during wind-down. */
export const WIND_DOWN_MAX_OUTPUT_TOKENS = 4096;

/**
 * Return the route label used by {@link contextGuardFraction} for a turn's auth source.
 *
 * chatgpt-oauth maps to the Codex subscription path whose effective provider-route
 * limit is sourced from the model catalog (client metadata). API-key paths use the
 * static contextLimitFor() table. The same operational threshold fraction
 * (AFK_CONTEXT_GUARD_PCT, default 95) applies to both; only the limit differs.
 */
function routeLabel(
  ctx: TurnDriverContext,
): 'codex-subscription' | 'openai-api' {
  return ctx.opts.auth.source === 'chatgpt-oauth' ? 'codex-subscription' : 'openai-api';
}

/** Full results are journaled before this bounded, tools-stripped synthesis view. */
export function windDownForContextPressure(ctx: TurnDriverContext, appendedAt: number): boolean {
  const subscriptionPath = ctx.opts.auth.source === 'chatgpt-oauth';
  const limit = contextLimitFor(ctx.currentModel, subscriptionPath);
  const fraction = contextGuardFraction(routeLabel(ctx));
  if (fraction === null) return false;
  const appended = ctx.priorTurns.slice(appendedAt);
  const bytes = Buffer.byteLength(JSON.stringify(appended));
  const last = contextWindowTokensUsed(ctx.lastUsage ?? {});
  if (!contextPressure(last, bytes, limit, fraction)) return false;
  traceContextPressure(ctx.traceWriter, projectedContextTokens(last, bytes), limit, fraction);
  // Invariant: synthesis must fit even when ONE tool result crosses the window.
  // Keep complete tool-call envelopes; bound only their result text. Full outputs
  // have already been persisted by dispatchAndAppend's journal commit point.
  // The available budget is computed relative to the operational threshold (not
  // the raw limit) so the truncation target matches the guard's trip point.
  const results = appended.filter(m => m.role === 'tool');
  const envelopeBytes = Buffer.byteLength(JSON.stringify(appended.filter(m => m.role !== 'tool')));
  const availableBytes = Math.max(0, Math.floor((limit * fraction - last) * 3) - envelopeBytes - WIND_DOWN_MAX_OUTPUT_TOKENS * 3);
  const each = Math.floor(availableBytes / Math.max(1, results.length));
  for (const message of results) {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    if (Buffer.byteLength(text) > each) {
      // Unicode-safe byte bound: worst-case UTF-8 is four bytes per code point.
      const count = Math.floor(Math.max(0, each - 100) / 4);
      const idx = ctx.priorTurns.indexOf(message);
      if (idx !== -1) {
        ctx.priorTurns[idx] = { ...message, content: text.slice(0, count) + '\n[Context pressure: result truncated for final synthesis; full output is journaled.]' };
      }
    }
  }
  return true;
}

export function canSynthesizeUnderPressure(ctx: TurnDriverContext, appendedAt: number): boolean {
  const subscriptionPath = ctx.opts.auth.source === 'chatgpt-oauth';
  const limit = contextLimitFor(ctx.currentModel, subscriptionPath);
  const appendedBytes = Buffer.byteLength(JSON.stringify(ctx.priorTurns.slice(appendedAt)));
  return projectedContextTokens(contextWindowTokensUsed(ctx.lastUsage ?? {}), appendedBytes) + WIND_DOWN_MAX_OUTPUT_TOKENS < limit;
}
