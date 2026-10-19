/**
 * Self-contained HTML renderer for /export html.
 *
 * Produces a single file with inline CSS — no external assets, no network.
 * All transcript content is HTML-escaped to prevent XSS from tool output.
 * Secrets are redacted via redactSecrets before any content is embedded.
 *
 * Pure function — no I/O.
 *
 * @module cli/slash/commands/export.render-html
 */

import { redactSecrets } from '../../../agent/redact-secrets.js';
import { formatCost, formatDuration } from '../../format-utils.js';
import type { TurnRecord, SessionStats } from '../types.js';

// ---------------------------------------------------------------------------
// XSS guard — escape ALL user/tool content before embedding in HTML
// ---------------------------------------------------------------------------

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ts(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace;
  background:#0d1117;color:#e6edf3;line-height:1.6;padding:2rem}
a{color:#58a6ff}
.container{max-width:900px;margin:0 auto}
h1{font-size:1.6rem;font-weight:700;margin-bottom:.5rem;color:#f0f6fc}
h2{font-size:1.1rem;font-weight:600;margin:2rem 0 .75rem;color:#8b949e;
  text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #21262d;padding-bottom:.4rem}
.meta-table{border-collapse:collapse;margin-bottom:1.5rem;font-size:.9rem}
.meta-table td{padding:.25rem .75rem;border:1px solid #21262d}
.meta-table td:first-child{color:#8b949e;white-space:nowrap}
.warning{background:#161b22;border:1px solid #f0883e55;border-left:3px solid #f0883e;
  padding:.6rem 1rem;border-radius:4px;font-size:.85rem;color:#f0883e;margin-bottom:1.5rem}
.turn{background:#161b22;border:1px solid #21262d;border-radius:8px;
  margin-bottom:1.25rem;overflow:hidden}
.turn-header{background:#1c2128;padding:.5rem 1rem;font-size:.8rem;
  color:#8b949e;display:flex;gap:1rem;align-items:center}
.turn-header strong{color:#e6edf3;font-size:.85rem}
.turn-body{padding:1rem}
.role-label{font-size:.75rem;font-weight:600;text-transform:uppercase;
  letter-spacing:.07em;margin-bottom:.35rem}
.role-user{color:#58a6ff}
.role-assistant{color:#3fb950}
.role-tools{color:#d29922}
.prose{white-space:pre-wrap;font-size:.9rem;color:#e6edf3;
  background:#0d1117;padding:.75rem;border-radius:4px;overflow-x:auto}
details{margin:.4rem 0}
details summary{cursor:pointer;font-size:.82rem;padding:.35rem .5rem;
  background:#1c2128;border-radius:4px;color:#d29922;user-select:none}
details summary:hover{background:#21262d}
details[open] summary{border-radius:4px 4px 0 0}
.tool-body{background:#0d1117;border:1px solid #21262d;
  border-top:none;border-radius:0 0 4px 4px;padding:.6rem}
.tool-section-label{font-size:.72rem;font-weight:600;color:#8b949e;
  text-transform:uppercase;margin-bottom:.25rem;margin-top:.4rem}
.tool-section-label:first-child{margin-top:0}
pre{white-space:pre-wrap;word-break:break-all;font-size:.8rem;
  color:#e6edf3;font-family:monospace}
.tool-error summary{color:#f85149}
.summary-table{border-collapse:collapse;font-size:.88rem;width:auto}
.summary-table th,.summary-table td{padding:.3rem .8rem;border:1px solid #21262d;text-align:left}
.summary-table th{background:#1c2128;color:#8b949e;font-weight:600}
.footer{margin-top:2rem;font-size:.78rem;color:#484f58;text-align:center}
`;

const HTML_RESULT_LIMIT = 8000;

function renderToolHtml(toolName: string, input: string, result: string | undefined, isError: boolean): string {
  const safeInput = escapeHtml(redactSecrets(input));
  // Invariant: slice the raw string BEFORE escapeHtml so we never cut mid-entity
  // (e.g. splitting "&amp;" would produce a broken entity in the output).
  let safeResult = '';
  if (result !== undefined) {
    const raw = redactSecrets(result);
    const omitted = raw.length > HTML_RESULT_LIMIT ? raw.length - HTML_RESULT_LIMIT : 0;
    const truncated = omitted > 0 ? `${raw.slice(0, HTML_RESULT_LIMIT)}\n[truncated — ${omitted} chars omitted]` : raw;
    safeResult = escapeHtml(truncated);
  }
  const statusIcon = isError ? '❌' : '✅';
  const errorClass = isError ? ' tool-error' : '';
  return [
    `<details class="tool-call${errorClass}">`,
    `<summary><code>${escapeHtml(toolName)}</code> ${statusIcon}</summary>`,
    `<div class="tool-body">`,
    `<div class="tool-section-label">Args</div>`,
    `<pre>${safeInput}</pre>`,
    safeResult ? `<div class="tool-section-label">Result</div><pre>${safeResult}</pre>` : '',
    `</div>`,
    `</details>`,
  ].join('\n');
}

function renderTurnHtml(turn: TurnRecord, index: number): string {
  const meta: string[] = [];
  if (turn.durationMs) meta.push(formatDuration(turn.durationMs));
  if (turn.costUsd) meta.push(formatCost(turn.costUsd));
  const metaStr = meta.length ? ` &nbsp;·&nbsp; ${escapeHtml(meta.join(' · '))}` : '';

  const toolsHtml = (turn.toolEvents ?? []).length > 0
    ? [
        `<div class="role-label role-tools">Tool calls</div>`,
        ...(turn.toolEvents ?? []).map(ev =>
          renderToolHtml(ev.toolName, ev.input, ev.result, ev.isError ?? false),
        ),
      ].join('\n')
    : '';

  return [
    `<div class="turn">`,
    `<div class="turn-header"><strong>Turn ${index + 1}</strong>${metaStr}</div>`,
    `<div class="turn-body">`,
    `<div class="role-label role-user">User</div>`,
    `<div class="prose">${escapeHtml(redactSecrets(turn.user))}</div>`,
    toolsHtml,
    `<div class="role-label role-assistant" style="margin-top:.75rem">Assistant</div>`,
    `<div class="prose">${escapeHtml(redactSecrets(turn.assistant))}</div>`,
    `</div>`,
    `</div>`,
  ].join('\n');
}

function buildToolSummaryHtml(turns: readonly TurnRecord[]): string {
  const byTool = new Map<string, { calls: number; errors: number }>();
  let total = 0;
  let errors = 0;
  for (const turn of turns) {
    for (const ev of turn.toolEvents ?? []) {
      total++;
      if (ev.isError) errors++;
      const e = byTool.get(ev.toolName) ?? { calls: 0, errors: 0 };
      e.calls++;
      if (ev.isError) e.errors++;
      byTool.set(ev.toolName, e);
    }
  }
  if (byTool.size === 0) return `<p style="font-size:.88rem;color:#8b949e">No tool calls this session.</p>`;

  const sorted = [...byTool.entries()].sort((a, b) => b[1].calls - a[1].calls);
  const rows = sorted.map(([name, e]) =>
    `<tr><td><code>${escapeHtml(name)}</code></td><td>${e.calls}</td><td>${e.errors}</td></tr>`,
  );
  return [
    `<p style="font-size:.88rem;margin-bottom:.75rem">`,
    `Total: <strong>${total}</strong> call${total === 1 ? '' : 's'} · `,
    `<strong>${errors}</strong> error${errors === 1 ? '' : 's'}`,
    `</p>`,
    `<table class="summary-table">`,
    `<thead><tr><th>Tool</th><th>Calls</th><th>Errors</th></tr></thead>`,
    `<tbody>${rows.join('')}</tbody>`,
    `</table>`,
  ].join('');
}

// ---------------------------------------------------------------------------
// main export
// ---------------------------------------------------------------------------

export function renderSessionHtml(stats: SessionStats): string {
  const { turns, model, sessionStartTime, totalCostUsd, totalDurationMs, unpricedTurns } = stats;
  const sessionLabel = stats.name ? escapeHtml(stats.name) : 'Session Export';
  const turnsHtml = turns.map((t, i) => renderTurnHtml(t, i)).join('\n');
  const toolSummaryHtml = buildToolSummaryHtml(turns);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AFK Export · ${sessionLabel}</title>
<style>${CSS}</style>
</head>
<body>
<div class="container">
<h1>AFK Session Export</h1>
<table class="meta-table">
<tr><td>Model</td><td><code>${escapeHtml(String(model))}</code></td></tr>
<tr><td>Started</td><td>${escapeHtml(ts(sessionStartTime))}</td></tr>
<tr><td>Duration</td><td>${escapeHtml(formatDuration(totalDurationMs))}</td></tr>
<tr><td>Cost</td><td>${escapeHtml(formatCost(totalCostUsd))}${unpricedTurns > 0 ? ` <span style="color:#8b949e;font-size:.85em">(+${unpricedTurns} unpriced turn${unpricedTurns === 1 ? '' : 's'})</span>` : ''}</td></tr>
<tr><td>Turns</td><td>${turns.length}</td></tr>
${stats.name ? `<tr><td>Session</td><td>${escapeHtml(stats.name)}</td></tr>` : ''}
</table>
<div class="warning">⚠ This file may contain code, file paths, and command output. Review before sharing.</div>
<h2>Transcript</h2>
${turnsHtml}
<h2>Tool Summary</h2>
${toolSummaryHtml}
<div class="footer">Exported by AFK &middot; ${escapeHtml(new Date().toISOString())}</div>
</div>
</body>
</html>`;
}
