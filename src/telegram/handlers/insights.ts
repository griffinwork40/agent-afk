/**
 * Telegram `/insights` command — send a short text summary of the operator's
 * usage analytics and recommendations.
 *
 * Reuses `aggregateAll` + `evaluateRecommendations` from `src/insights/` with
 * no new aggregation logic. Renders a plain-text / Telegram HTML summary (no
 * browser, no HTML file) by extracting the recommendation list and a handful
 * of top-level metrics from the existing pure-function pipeline.
 *
 * Privacy invariants from `src/insights/types.ts` are preserved: no chat IDs,
 * no prompt content, no file paths appear in the output.
 *
 * @module telegram/handlers/insights
 */

import type { Context } from 'telegraf';
import { aggregateAll } from '../../insights/index.js';
import { evaluateRecommendations } from '../../insights/index.js';
import { escapeHtml, splitLongMessage } from '../formatter.js';

// ---------------------------------------------------------------------------
// Severity emoji
// ---------------------------------------------------------------------------

const SEVERITY_EMOJI: Record<string, string> = {
  high: '🔴',
  medium: '🟡',
  info: '🔵',
};

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

/**
 * Handle the Telegram `/insights [days]` command.
 *
 * Optional argument: number of lookback days (default 30, max 90).
 * Sends one or more Telegram HTML messages with top-level metrics and the
 * full recommendation list (or "All clear" when there are none).
 */
export async function handleInsights(ctx: Context): Promise<void> {
  // Parse optional days argument from "/insights [N]"
  const text: string =
    typeof ctx.message === 'object' &&
    ctx.message !== null &&
    'text' in ctx.message &&
    typeof (ctx.message as { text?: unknown }).text === 'string'
      ? (ctx.message as { text: string }).text
      : '';

  const afterCmd = text.replace(/^\/insights(?:@\S+)?/, '').trim();
  const rawDays = parseInt(afterCmd, 10);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(rawDays, 90) : 30;

  await ctx.reply('⏳ Aggregating insights…');

  let agg;
  try {
    agg = await aggregateAll({ days });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(
      `❌ Failed to aggregate insights: <code>${escapeHtml(msg)}</code>`,
      { parse_mode: 'HTML' },
    );
    return;
  }

  const recs = evaluateRecommendations(agg);

  // ---------------------------------------------------------------------------
  // Header: top-level metrics
  // ---------------------------------------------------------------------------
  const lines: string[] = [
    `<b>📊 AFK Insights — last ${days} day${days !== 1 ? 's' : ''}</b>`,
    '',
    `Sessions: <b>${agg.sessions.totalSessions}</b>`,
    `Cost: <b>$${agg.sessions.totalCostUsd.toFixed(2)}</b>`,
    `Tokens: <b>${agg.sessions.totalTokens.toLocaleString()}</b>`,
    `Daemon runs: <b>${agg.daemon.totalRuns}</b>`,
  ];

  // ---------------------------------------------------------------------------
  // Recommendations
  // ---------------------------------------------------------------------------
  if (recs.length === 0) {
    lines.push('', '✅ <b>All clear</b> — no recommendations.');
  } else {
    lines.push('', `<b>Recommendations (${recs.length}):</b>`);
    for (const rec of recs) {
      const emoji = SEVERITY_EMOJI[rec.severity] ?? '⚪';
      lines.push(
        '',
        `${emoji} <b>${escapeHtml(rec.title)}</b>`,
        escapeHtml(rec.body),
      );
    }
  }

  const fullText = lines.join('\n');
  for (const chunk of splitLongMessage(fullText)) {
    await ctx.reply(chunk, { parse_mode: 'HTML' });
  }
}
