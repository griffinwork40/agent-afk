import { contextLimitFor } from '../../../model-limits.js';
import { contextWindowTokensUsed } from '../../shared/auto-compact.js';
import {
  contextGuardFraction,
  contextPressure,
  projectedContextTokens,
  traceContextPressure,
} from '../../shared/context-pressure.js';
import type { TurnDriverContext } from './turn-driver.js';
import type { OpenAIMessage } from '../messages.js';
import { boundPressureArguments } from './context-pressure.arguments.js';
import { truncate } from '../../../../utils/truncate.js';

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

/** Full results are journaled before this bounded synthesis view (tools stay advertised; nothing is dispatched). */
export function windDownForContextPressure(ctx: TurnDriverContext, appendedAt: number, turns: OpenAIMessage[] = ctx.priorTurns): boolean {
  const subscriptionPath = ctx.opts.auth.source === 'chatgpt-oauth';
  const limit = contextLimitFor(ctx.currentModel, subscriptionPath);
  const fraction = contextGuardFraction(routeLabel(ctx));
  if (fraction === null) return false;
  let appended = turns.slice(appendedAt);
  const bytes = Buffer.byteLength(JSON.stringify(appended));
  const last = contextWindowTokensUsed(ctx.lastUsage ?? {});
  if (!contextPressure(last, bytes, limit, fraction)) return false;
  traceContextPressure(ctx.traceWriter, projectedContextTokens(last, bytes), limit, fraction);
  // Invariant: synthesis must fit even when ONE tool result crosses the window.
  // Preserve call ids and names for result pairing. Bound arguments only if the
  // non-tool envelope alone exceeds the budget, using valid JSON summaries.
  // Tools remain advertised for prefix-cache stability, but never execute in
  // synthesis. Full calls/results were persisted at dispatchAndAppend's commit.
  // The available budget is computed relative to the operational threshold (not
  // the raw limit) so the truncation target matches the guard's trip point.
  const budget = Math.max(0, Math.floor((limit * fraction - last) * 3) - WIND_DOWN_MAX_OUTPUT_TOKENS * 3);
  boundPressureArguments(turns, appendedAt, budget);
  appended = turns.slice(appendedAt);
  const results = appended.filter(m => m.role === 'tool');
  const envelopeBytes = Buffer.byteLength(JSON.stringify(appended.filter(m => m.role !== 'tool')));
  const availableBytes = Math.max(0, Math.floor((limit * fraction - last) * 3) - envelopeBytes - WIND_DOWN_MAX_OUTPUT_TOKENS * 3);
  const each = Math.floor(availableBytes / Math.max(1, results.length));
  for (const message of results) {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    if (Buffer.byteLength(text) > each) {
      // Unicode-safe byte bound: worst-case UTF-8 is four bytes per code point.
      const count = Math.floor(Math.max(0, each - 100) / 4);
      const idx = turns.indexOf(message);
      if (idx !== -1) {
        turns[idx] = { ...message, content: (count > 0 ? truncate(text, count) : '') + '\n[Context pressure: result truncated for final synthesis; full output is journaled.]' };
      }
    }
  }
  return true;
}

export function canSynthesizeUnderPressure(ctx: TurnDriverContext, appendedAt: number, turns: OpenAIMessage[] = ctx.priorTurns): boolean {
  const subscriptionPath = ctx.opts.auth.source === 'chatgpt-oauth';
  const limit = contextLimitFor(ctx.currentModel, subscriptionPath);
  const appendedBytes = Buffer.byteLength(JSON.stringify(turns.slice(appendedAt)));
  return projectedContextTokens(contextWindowTokensUsed(ctx.lastUsage ?? {}), appendedBytes) + WIND_DOWN_MAX_OUTPUT_TOKENS < limit;
}
