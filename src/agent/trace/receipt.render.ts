/**
 * Markdown renderer for run receipts.
 *
 * Extracted from `receipt.ts` to keep that file within the 350-code-line
 * ceiling. Owns `formatDuration` and `renderReceiptMarkdown`. Pure — no I/O.
 *
 * @module agent/trace/receipt.render
 */

import type { RunReceipt } from './receipt.js';
import type { OutcomesV1 } from '../outcomes/outcomes-v1.schema.js';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}

/** Render a {@link RunReceipt} as human-readable Markdown. Pure — no I/O. */
export function renderReceiptMarkdown(r: RunReceipt): string {
  const lines: string[] = [];
  lines.push(`# Run receipt — ${r.witnessLabel}`);
  lines.push('');
  lines.push(
    `**Status:** ${r.status} · **Review required:** ${r.humanReviewRequired ? '⚠️ YES' : '✓ no'}`,
  );
  const metaParts: string[] = [];
  if (r.sessionId !== undefined) metaParts.push(`**Session:** ${r.sessionId}`);
  if (r.endedAt !== undefined) metaParts.push(`**Ended:** ${r.endedAt}`);
  if (r.durationMs !== undefined) metaParts.push(`**Duration:** ${formatDuration(r.durationMs)}`);
  if (metaParts.length > 0) lines.push(metaParts.join(' · '));
  lines.push(`**Trace:** \`${r.tracePath}\``);
  lines.push('');

  if (r.humanReviewRequired) {
    lines.push('## Why review is required');
    for (const reason of r.humanReviewReasons) lines.push(`- ${reason}`);
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Tool calls | ${r.toolCalls.total} |`);
  lines.push(`| Errored | ${r.toolCalls.errored} (${r.toolCalls.erroredNotable} notable) |`);
  if (r.toolCalls.refused > 0) {
    const rate =
      r.toolCalls.total > 0
        ? ((r.toolCalls.refused / r.toolCalls.total) * 100).toFixed(1)
        : '0.0';
    lines.push(`| Refused (denylisted) | ${r.toolCalls.refused} (${rate}% of calls) |`);
  }
  if (r.toolCalls.circuitBreakerHits > 0)
    lines.push(`| Circuit-breaker hits | ${r.toolCalls.circuitBreakerHits} |`);
  if (r.cost.turnCount !== undefined) lines.push(`| Turns | ${r.cost.turnCount} |`);
  if (r.cost.totalCostUsd !== undefined) {
    // Total = root + every subagent (#3879); root and subagent shown beside it.
    lines.push(`| Cost (USD, total) | ${r.cost.totalCostUsd.toFixed(4)} |`);
    if (r.cost.rootCostUsd !== undefined)
      lines.push(`| Cost (USD, root) | ${r.cost.rootCostUsd.toFixed(4)} |`);
    else if (r.cost.costSource === 'closures-incomplete')
      lines.push('| Cost (USD, root) | unknown (process exited before the root closed) |');
    if (r.cost.subagentCostUsd !== undefined)
      lines.push(`| Cost (USD, subagents) | ${r.cost.subagentCostUsd.toFixed(4)} |`);
  } else if (r.cost.finalCostUsd !== undefined)
    lines.push(`| Cost (USD) | ${r.cost.finalCostUsd.toFixed(4)} |`);
  if (r.subagents.started > 0)
    lines.push(
      `| Subagents | ${r.subagents.started} started · ${r.subagents.succeeded} ok · ` +
        `${r.subagents.failed} failed · ${r.subagents.cancelled} cancelled |`,
    );
  if (r.closureReason !== undefined) lines.push(`| Closure | ${r.closureReason} |`);
  lines.push('');

  const toolNames = Object.keys(r.toolCalls.byTool).sort();
  if (toolNames.length > 0) {
    lines.push('## Tool calls by name');
    lines.push('');
    lines.push('| Tool | Calls | Errored |');
    lines.push('| --- | --- | --- |');
    for (const name of toolNames) {
      const b = r.toolCalls.byTool[name];
      if (b === undefined) continue;
      lines.push(`| ${name} | ${b.total} | ${b.errored} |`);
    }
    lines.push('');
  }

  if (r.failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    lines.push('| Tool | Class | Duration | When | Exempt |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const f of r.failures) {
      lines.push(
        `| ${f.name} | ${f.failureClass ?? 'unclassified'} | ${f.durationMs}ms | ${f.ts} | ` +
          `${f.exempt ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
  } else {
    lines.push('No tool failures recorded.');
    lines.push('');
  }

  if (r.journalSummary !== undefined) {
    const js = r.journalSummary;
    lines.push('## Conversation summary');
    lines.push('');
    if (js.textRedacted) {
      lines.push('_Text fields redacted (AFK_RUN_RECEIPT_TEXT_DISABLED=1)._');
      lines.push('');
    }
    if (js.firstUserMessage !== undefined) {
      lines.push('**Request:**');
      lines.push('');
      lines.push(`> ${js.firstUserMessage.replace(/\n/g, '\n> ')}`);
      lines.push('');
    }
    if (js.lastAssistantMessage !== undefined) {
      lines.push('**Result:**');
      lines.push('');
      lines.push(`> ${js.lastAssistantMessage.replace(/\n/g, '\n> ')}`);
      lines.push('');
    }
    if (js.toolNames.length > 0) {
      lines.push(`**Tools used (${js.toolUseCount} calls):** ${js.toolNames.join(', ')}`);
      lines.push('');
    }
    lines.push(`**Messages:** ${js.messageCount}`);
    lines.push('');
  }

  if (r.outcomes) renderOutcomes(r.outcomes, lines);

  lines.push('## Limitations');
  lines.push('');
  for (const lim of r.limitations) lines.push(`- ${lim}`);
  lines.push('');
  lines.push('---');
  lines.push(
    `_Generated ${r.generatedAt} by the AFK run-receipt writer ` +
      `(read-only; no agent behavior was modified)._`,
  );
  lines.push('');
  return lines.join('\n');
}

/** Short "what changed in the world" section (receipt v3). */
function renderOutcomes(o: OutcomesV1, lines: string[]): void {
  lines.push('## Outcomes');
  lines.push('');
  if (o.commits.length > 0) {
    lines.push(`**Commits (${o.commits.length}):**`);
    for (const c of o.commits) lines.push(`- \`${c.sha.slice(0, 7)}\` ${c.subject}`);
    lines.push('');
  }
  if (o.prs.length > 0) {
    lines.push(`**PRs (${o.prs.length}):**`);
    for (const p of o.prs) lines.push(`- ${p.url} (${p.action})`);
    lines.push('');
  }
  const files = `${o.filesChanged.length}${o.filesChangedTruncated ? '+' : ''}`;
  lines.push(
    `**Files changed:** ${files} · **Schedules:** ${o.schedules.length} · ` +
      `**Services:** ${o.services.length} · **Terminal state:** ${o.terminalState ?? 'none'}`,
  );
  lines.push('');
}
