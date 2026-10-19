/**
 * Markdown renderer for /export md.
 *
 * Produces a self-contained markdown file with:
 *   - Session header (model, start time, cost, duration)
 *   - Per-turn user/assistant exchanges
 *   - Collapsible tool-call blocks (args + result)
 *   - Trace summary section (total tool calls, errors)
 *   - Secret-redaction via redactSecrets
 *
 * Pure function — no I/O.
 *
 * @module cli/slash/commands/export.render-md
 */

import { redactSecrets } from '../../../agent/redact-secrets.js';
import { formatCost, formatDuration } from '../../format-utils.js';
import type { TurnRecord, SessionStats } from '../types.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ts(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

function toolSummary(turns: readonly TurnRecord[]): {
  totalCalls: number;
  errorCalls: number;
  byTool: Map<string, { calls: number; errors: number }>;
} {
  let totalCalls = 0;
  let errorCalls = 0;
  const byTool = new Map<string, { calls: number; errors: number }>();
  for (const turn of turns) {
    for (const ev of turn.toolEvents ?? []) {
      totalCalls++;
      if (ev.isError) errorCalls++;
      const entry = byTool.get(ev.toolName) ?? { calls: 0, errors: 0 };
      entry.calls++;
      if (ev.isError) entry.errors++;
      byTool.set(ev.toolName, entry);
    }
  }
  return { totalCalls, errorCalls, byTool };
}

// Invariant: CommonMark fenced code blocks require the closing fence to be at
// least as long as the opening fence, and the content must not contain a line
// that is ONLY backticks of that length or longer. We compute the minimum safe
// fence length (longest backtick-only run in the content + 1, minimum 3) so
// tool output containing ``` never breaks the fence.
function safeFence(content: string): string {
  let max = 2;
  for (const m of content.matchAll(/^(`+)$/gm)) {
    if (m[1]!.length > max) max = m[1]!.length;
  }
  return '`'.repeat(max + 1);
}

const MD_RESULT_LIMIT = 4000;

function renderToolBlock(toolName: string, input: string, result: string | undefined, isError: boolean): string {
  const safeInput = redactSecrets(input);
  const rawResult = result !== undefined ? redactSecrets(result) : '';
  const status = isError ? '❌ error' : '✅ ok';
  const inputFence = safeFence(safeInput);
  const lines: string[] = [
    `<details>`,
    `<summary><code>${toolName}</code> — ${status}</summary>`,
    ``,
    `**Args**`,
    ``,
    `${inputFence}json`,
    safeInput,
    inputFence,
  ];
  if (rawResult) {
    const omitted = rawResult.length > MD_RESULT_LIMIT ? rawResult.length - MD_RESULT_LIMIT : 0;
    const safeResult = omitted > 0
      ? `${rawResult.slice(0, MD_RESULT_LIMIT)}\n[truncated — ${omitted} chars omitted]`
      : rawResult;
    const resultFence = safeFence(safeResult);
    lines.push('', '**Result**', '', resultFence, safeResult, resultFence);
  }
  lines.push('', '</details>');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// main export
// ---------------------------------------------------------------------------

export function renderSessionMarkdown(stats: SessionStats): string {
  const { turns, model, sessionStartTime, totalCostUsd, totalDurationMs, unpricedTurns } = stats;
  const lines: string[] = [];

  // Header
  lines.push(`# AFK Session Export`);
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|---|---|`);
  // Invariant: pipe characters in the model name would break the GFM table cell;
  // escape them so the table renders correctly for models with org/name separators.
  const safeModel = String(model).replace(/\|/g, '\\|');
  const costCell = unpricedTurns > 0
    ? `${formatCost(totalCostUsd)} *(+${unpricedTurns} unpriced turn${unpricedTurns === 1 ? '' : 's'})*`
    : formatCost(totalCostUsd);
  lines.push(`| Model | \`${safeModel}\` |`);
  lines.push(`| Started | ${ts(sessionStartTime)} |`);
  lines.push(`| Duration | ${formatDuration(totalDurationMs)} |`);
  lines.push(`| Cost | ${costCell} |`);
  lines.push(`| Turns | ${turns.length} |`);
  if (stats.name) lines.push(`| Session | ${stats.name} |`);
  lines.push('');
  lines.push('> ⚠ This file may contain code, file paths, and command output. Review before sharing.');
  lines.push('');

  // Turns
  lines.push('---');
  lines.push('');
  lines.push('## Transcript');
  lines.push('');

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    const meta: string[] = [`Turn ${i + 1}`];
    if (turn.durationMs) meta.push(formatDuration(turn.durationMs));
    if (turn.costUsd) meta.push(formatCost(turn.costUsd));

    lines.push(`### ${meta.join(' · ')}`);
    lines.push('');
    lines.push('**User**');
    lines.push('');
    lines.push(redactSecrets(turn.user));
    lines.push('');

    if (turn.toolEvents && turn.toolEvents.length > 0) {
      lines.push('**Tool calls**');
      lines.push('');
      for (const ev of turn.toolEvents) {
        lines.push(renderToolBlock(ev.toolName, ev.input, ev.result, ev.isError ?? false));
        lines.push('');
      }
    }

    lines.push('**Assistant**');
    lines.push('');
    lines.push(redactSecrets(turn.assistant));
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Trace summary
  const { totalCalls, errorCalls, byTool } = toolSummary(turns);
  lines.push('## Tool Summary');
  lines.push('');
  lines.push(`Total tool calls: **${totalCalls}** (${errorCalls} error${errorCalls === 1 ? '' : 's'})`);
  lines.push('');

  if (byTool.size > 0) {
    lines.push('| Tool | Calls | Errors |');
    lines.push('|---|---|---|');
    const sorted = [...byTool.entries()].sort((a, b) => b[1].calls - a[1].calls);
    for (const [name, entry] of sorted) {
      lines.push(`| \`${name}\` | ${entry.calls} | ${entry.errors} |`);
    }
    lines.push('');
  }

  lines.push(`*Exported by AFK · ${new Date().toISOString()}*`);
  lines.push('');

  return lines.join('\n');
}
