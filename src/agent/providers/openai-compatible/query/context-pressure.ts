import { contextLimitFor } from '../../../model-limits.js';
import { contextWindowTokensUsed } from '../../shared/auto-compact.js';
import { contextPressure, projectedContextTokens, traceContextPressure } from '../../shared/context-pressure.js';
import type { TurnDriverContext } from './turn-driver.js';

/** Full results are journaled before this bounded, tools-stripped synthesis view. */
export function windDownForContextPressure(ctx: TurnDriverContext, appendedAt: number): boolean {
  const limit = contextLimitFor(ctx.currentModel, ctx.opts.auth.source === 'chatgpt-oauth');
  const appended = ctx.priorTurns.slice(appendedAt);
  const bytes = Buffer.byteLength(JSON.stringify(appended));
  const last = contextWindowTokensUsed(ctx.lastUsage ?? {});
  if (!contextPressure(last, bytes, limit)) return false;
  traceContextPressure(ctx.traceWriter, projectedContextTokens(last, bytes), limit);
  // Invariant: synthesis must fit even when ONE tool result crosses the window.
  // Keep complete tool-call envelopes; bound only their result text. Full outputs
  // have already been persisted by dispatchAndAppend's journal commit point.
  const results = appended.filter(m => m.role === 'tool' || m.role === 'user');
  const envelopeBytes = Buffer.byteLength(JSON.stringify(appended.filter(m => m.role !== 'tool' && m.role !== 'user')));
  const availableBytes = Math.max(0, Math.floor((limit * 0.85 - last) * 3) - envelopeBytes - 4096);
  const each = Math.floor(availableBytes / Math.max(1, results.length));
  for (const message of results) {
    const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    if (Buffer.byteLength(text) > each) {
      // Unicode-safe byte bound: worst-case UTF-8 is four bytes per code point.
      const count = Math.floor(Math.max(0, each - 100) / 4);
      message.content = text.slice(0, count) + '\n[Context pressure: result truncated for final synthesis; full output is journaled.]';
    }
  }
  return true;
}

export function canSynthesizeUnderPressure(ctx: TurnDriverContext, appendedAt: number): boolean {
  const limit = contextLimitFor(ctx.currentModel, ctx.opts.auth.source === 'chatgpt-oauth');
  const appendedBytes = Buffer.byteLength(JSON.stringify(ctx.priorTurns.slice(appendedAt)));
  return projectedContextTokens(contextWindowTokensUsed(ctx.lastUsage ?? {}), appendedBytes) + 8192 < limit;
}
