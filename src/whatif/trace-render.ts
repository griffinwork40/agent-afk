/**
 * Render an episode trace into the compact text the judge grades.
 *
 * Intercepted calls (episode-gate verdict `'recorded'`) render as
 * `[tool requested: X (not executed)]`. The judges are told how to read that
 * marker via `INTERCEPTED_INTENT_RULE` in `./observability.ts`, so the two
 * must stay in sync.
 *
 * @module whatif/trace-render
 */

import type { EpisodeTrace } from './types.js';

/** Truncate long input JSON to prevent judge overload. */
function truncInput(v: unknown, maxChars: number): string {
  const s = JSON.stringify(v) ?? '';
  return s.length <= maxChars ? s : s.slice(0, maxChars) + '…[truncated]';
}

/**
 * Render an episode trace into a compact text for the judge.
 * Shows assistant text then a compact tool-request list.
 */
export function renderTrace(trace: EpisodeTrace): string {
  const parts: string[] = [trace.text];
  for (const t of trace.tools) {
    if (t.verdict === 'recorded') {
      parts.push(`[tool requested: ${t.tool} (not executed)] ${truncInput(t.input, 200)}`);
    } else {
      parts.push(`[tool used: ${t.tool}]`);
    }
  }
  return parts.join('\n');
}
