/**
 * HTML report generator — produces a fully self-contained HTML document
 * from `InsightAggregates` and `Recommendation[]`.
 *
 * Invariants:
 *   - No external stylesheets or scripts (`<link>` or `<script src="http...">`).
 *   - All dynamic values pass through `htmlEscape()`.
 *   - "No data" placeholders render per-section when aggregates are zeroed.
 *   - `NaN` and `undefined` MUST NOT appear as rendered text.
 *   - `responseExcerpt`, `telegramChatId`, prompt content NEVER in output.
 *
 * @module insights/html
 */

import type { InsightAggregates, Recommendation, InsightsOptions } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape HTML special characters to prevent injection / rendering artifacts. */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Safe number formatting — returns '0' instead of 'NaN' or 'undefined'. */
function safeNum(n: number | undefined | null, decimals = 0): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '0';
  return n.toFixed(decimals);
}

/** Format cost in USD. */
function formatCost(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd) || usd === 0) return '$0.00';
  return `$${safeNum(usd, 4)}`;
}

/** Format a percentage from a fraction (0–1). */
function formatPct(fraction: number | undefined): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return '0%';
  return `${safeNum(fraction * 100, 1)}%`;
}

/** Format a large integer with commas. */
function formatInt(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

/** Render a "no data" box. */
function noData(label: string): string {
  return `<p class="no-data">No ${htmlEscape(label)} data in this window.</p>`;
}

// ---------------------------------------------------------------------------
// SVG bar chart helper
// ---------------------------------------------------------------------------

function barChart(
  entries: Array<{ label: string; value: number }>,
  maxWidth = 300,
  color = '#4f8ef7',
): string {
  if (entries.length === 0) return '';
  const maxVal = Math.max(...entries.map((e) => e.value), 0.0001);
  const rows = entries
    .slice(0, 20) // cap at 20 bars
    .map((e) => {
      const barW = Math.round((e.value / maxVal) * maxWidth);
      const label = htmlEscape(e.label.slice(0, 40));
      const valStr = htmlEscape(e.value % 1 === 0 ? formatInt(e.value) : safeNum(e.value, 2));
      return `<tr>
        <td class="bar-label">${label}</td>
        <td><svg width="${maxWidth}" height="18"><rect x="0" y="2" width="${barW}" height="14" fill="${color}" rx="2"/></svg></td>
        <td class="bar-val">${valStr}</td>
      </tr>`;
    })
    .join('\n');
  return `<table class="bar-chart">${rows}</table>`;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderSessions(agg: InsightAggregates): string {
  const s = agg.sessions;
  const t = agg.traces;
  const hasData = s.totalSessions > 0;

  // Tokens are sourced from witness trace closure events (authoritative
  // input/output/cache split). The session sidecar only stores a single
  // combined `totalTokens`, so it cannot back a per-direction breakdown.
  const tokenCards =
    `<div class="metric-card"><div class="metric-val">${htmlEscape(formatInt(t.totalInputTokens))}</div><div class="metric-label">Input Tokens</div></div>
        <div class="metric-card"><div class="metric-val">${htmlEscape(formatInt(t.totalOutputTokens))}</div><div class="metric-label">Output Tokens</div></div>
        <div class="metric-card"><div class="metric-val">${htmlEscape(formatInt(t.totalCacheReadTokens))}</div><div class="metric-label">Cache Read Tokens</div></div>
        <div class="metric-card"><div class="metric-val">${htmlEscape(formatInt(t.totalCacheCreationTokens))}</div><div class="metric-label">Cache Creation Tokens</div></div>`;

  // Honest cost context — cost is sparse when local (zero-cost) models dominate.
  const costNote =
    hasData && t.sessionsWithCost < t.totalTracedSessions
      ? `<p style="color:#8a93a3;font-size:13px;margin-top:10px">Cost is recorded only for paid-API sessions — ${htmlEscape(safeNum(t.sessionsWithCost))} of ${htmlEscape(safeNum(t.totalTracedSessions))} traced sessions had a non-zero cost. Sessions on local models report $0.</p>`
      : '';

  const topContent = hasData
    ? `<div class="metrics-grid">
        <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(s.totalSessions))}</div><div class="metric-label">Sessions</div></div>
        <div class="metric-card"><div class="metric-val">${htmlEscape(formatCost(s.totalCostUsd))}</div><div class="metric-label">Total Cost</div></div>
        ${tokenCards}
      </div>${costNote}`
    : noData('session');

  const modelEntries = Object.entries(s.byModel).map(([k, v]) => ({ label: k, value: v.costUsd }));
  const surfaceEntries = Object.entries(s.bySurface).map(([k, v]) => ({ label: k, value: v.sessions }));
  const dayEntries = Object.entries(s.byDay)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => ({ label: k, value: v.costUsd }));

  return `
  <section id="sessions">
    <h2>Sessions</h2>
    ${topContent}
    ${hasData && modelEntries.length > 0 ? `<h3>Cost by Model</h3>${barChart(modelEntries.sort((a, b) => b.value - a.value))}` : ''}
    ${hasData && surfaceEntries.length > 0 ? `<h3>Sessions by Surface</h3>${barChart(surfaceEntries.sort((a, b) => b.value - a.value), 300, '#6dbf67')}` : ''}
    ${hasData && dayEntries.length > 0 ? `<h3>Cost by Day</h3>${barChart(dayEntries, 300, '#f7a14f')}` : ''}
  </section>`;
}

function renderCost(agg: InsightAggregates): string {
  const s = agg.sessions;
  const hasData = s.totalCostUsd > 0;

  const avgCostPerSession =
    s.totalSessions > 0 ? s.totalCostUsd / s.totalSessions : 0;

  return `
  <section id="cost">
    <h2>Cost</h2>
    ${hasData
      ? `<div class="metrics-grid">
          <div class="metric-card"><div class="metric-val">${htmlEscape(formatCost(s.totalCostUsd))}</div><div class="metric-label">Total Cost (${htmlEscape(safeNum(agg.windowDays))}d)</div></div>
          <div class="metric-card"><div class="metric-val">${htmlEscape(formatCost(avgCostPerSession))}</div><div class="metric-label">Avg Cost/Session</div></div>
        </div>`
      : noData('cost')}
  </section>`;
}

function renderToolUsage(agg: InsightAggregates): string {
  const t = agg.traces;
  const hasData = Object.keys(t.toolCallCounts).length > 0;

  if (!hasData) {
    return `<section id="tool-usage"><h2>Tool Usage</h2>${noData('tool call')}</section>`;
  }

  const callEntries = Object.entries(t.toolCallCounts)
    .map(([name, count]) => ({ label: name, value: count }))
    .sort((a, b) => b.value - a.value);

  const errorRateEntries = Object.entries(t.toolCallCounts)
    .filter(([, count]) => count >= 5)
    .map(([name, count]) => {
      const errCount = t.toolErrorCounts[name] ?? 0;
      return { label: name, value: errCount / count };
    })
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);

  return `
  <section id="tool-usage">
    <h2>Tool Usage</h2>
    <h3>Call Counts</h3>
    ${barChart(callEntries)}
    ${errorRateEntries.length > 0 ? `<h3>Error Rates (≥5 calls)</h3>${barChart(errorRateEntries.map((e) => ({ label: e.label, value: Math.round(e.value * 100) })), 300, '#e05252')}` : ''}
    <p class="caption">Compaction events: ${htmlEscape(safeNum(t.compactionCount))}</p>
  </section>`;
}

function renderDaemonTasks(agg: InsightAggregates): string {
  const d = agg.daemon;
  const hasData = d.totalRuns > 0;

  if (!hasData) {
    return `<section id="daemon-tasks"><h2>Daemon Tasks</h2>${noData('daemon task')}</section>`;
  }

  const successRate = d.totalRuns > 0 ? d.successCount / d.totalRuns : 0;
  const errorRate = d.totalRuns > 0 ? d.errorCount / d.totalRuns : 0;
  const skipRate = d.totalRuns > 0 ? d.skipCount / d.totalRuns : 0;

  const triggerEntries = Object.entries(d.triggerBreakdown)
    .map(([k, v]) => ({ label: k, value: v }))
    .sort((a, b) => b.value - a.value);

  const skipReasonEntries = Object.entries(d.skipReasons)
    .map(([k, v]) => ({ label: k, value: v }))
    .sort((a, b) => b.value - a.value);

  const recentErrorRows = d.recentErrors
    .map((e) => `<tr><td>${htmlEscape(e.taskId)}</td><td>${htmlEscape(e.message.slice(0, 100))}</td></tr>`)
    .join('\n');

  return `
  <section id="daemon-tasks">
    <h2>Daemon Tasks</h2>
    <div class="metrics-grid">
      <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(d.totalRuns))}</div><div class="metric-label">Total Runs</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(formatPct(successRate))}</div><div class="metric-label">Success Rate</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(formatPct(errorRate))}</div><div class="metric-label">Error Rate</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(formatPct(skipRate))}</div><div class="metric-label">Skip Rate</div></div>
      <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(d.avgDurationMs, 0))}ms</div><div class="metric-label">Avg Duration</div></div>
    </div>
    ${triggerEntries.length > 0 ? `<h3>Trigger Breakdown</h3>${barChart(triggerEntries, 300, '#9b59b6')}` : ''}
    ${skipReasonEntries.length > 0 ? `<h3>Skip Reasons</h3>${barChart(skipReasonEntries, 300, '#e67e22')}` : ''}
    ${d.recentErrors.length > 0 ? `<h3>Recent Errors (up to 5)</h3><table class="data-table"><thead><tr><th>Task</th><th>Message</th></tr></thead><tbody>${recentErrorRows}</tbody></table>` : ''}
  </section>`;
}

function renderTraces(agg: InsightAggregates): string {
  const t = agg.traces;
  const hasData = t.totalTracedSessions > 0;

  const closureEntries = Object.entries(t.closureReasons)
    .map(([k, v]) => ({ label: k, value: v }))
    .sort((a, b) => b.value - a.value);

  const forkDepthEntries = Object.entries(t.subagentForkDepths)
    .map(([k, v]) => ({ label: `depth ${k}`, value: v }))
    .sort((a, b) => parseInt(a.label.split(' ')[1]!) - parseInt(b.label.split(' ')[1]!));

  return `
  <section id="traces">
    <h2>Traces</h2>
    ${hasData
      ? `<div class="metrics-grid">
          <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(t.totalTracedSessions))}</div><div class="metric-label">Traced Sessions</div></div>
          <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(t.compactionCount))}</div><div class="metric-label">Compaction Events</div></div>
        </div>
        ${closureEntries.length > 0 ? `<h3>Closure Reasons</h3>${barChart(closureEntries, 300, '#e05252')}` : ''}
        ${forkDepthEntries.length > 0 ? `<h3>Subagent Fork Depths</h3>${barChart(forkDepthEntries, 300, '#4f8ef7')}` : ''}`
      : noData('trace')}
  </section>`;
}

function renderRouting(agg: InsightAggregates): string {
  const r = agg.routing;
  const hasData = r.totalRoutingEvents > 0;

  const modeEntries = Object.entries(r.skillDispatchModes)
    .map(([k, v]) => ({ label: k, value: v }))
    .sort((a, b) => b.value - a.value);

  const skillEntries = Object.entries(r.skillFrequency)
    .map(([k, v]) => ({ label: k, value: v }))
    .sort((a, b) => b.value - a.value);

  const overflowEntries = Object.entries(r.overflowKills)
    .map(([k, v]) => ({ label: k, value: v }))
    .sort((a, b) => b.value - a.value);

  return `
  <section id="routing">
    <h2>Routing</h2>
    ${hasData
      ? `<div class="metrics-grid">
          <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(r.totalRoutingEvents))}</div><div class="metric-label">Routing Events</div></div>
          <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(r.composeCallCount))}</div><div class="metric-label">Compose Calls</div></div>
          <div class="metric-card"><div class="metric-val">${htmlEscape(safeNum(r.avgComposeNodes, 1))}</div><div class="metric-label">Avg Compose Nodes</div></div>
        </div>
        ${modeEntries.length > 0 ? `<h3>Skill Dispatch Modes</h3>${barChart(modeEntries)}` : ''}
        ${skillEntries.length > 0 ? `<h3>Skill Frequency</h3>${barChart(skillEntries.slice(0, 15), 300, '#6dbf67')}` : ''}
        ${overflowEntries.length > 0 ? `<h3>Overflow Kills by Tool</h3>${barChart(overflowEntries, 300, '#e05252')}` : ''}`
      : noData('routing')}
  </section>`;
}

function renderRecommendations(recs: Recommendation[]): string {
  const hasData = recs.length > 0;

  if (!hasData) {
    return `
  <section id="recommendations">
    <h2>Recommendations</h2>
    <p class="all-clear">✓ All systems look healthy — no recommendations at this time.</p>
  </section>`;
  }

  const cards = recs
    .map((r) => {
      const badgeClass =
        r.severity === 'high' ? 'badge-high' : r.severity === 'medium' ? 'badge-medium' : 'badge-info';
      return `<div class="rec-card ${badgeClass}">
        <div class="rec-header">
          <span class="badge">${htmlEscape(r.severity.toUpperCase())}</span>
          <strong>${htmlEscape(r.title)}</strong>
        </div>
        <p>${htmlEscape(r.body)}</p>
      </div>`;
    })
    .join('\n');

  return `
  <section id="recommendations">
    <h2>Recommendations</h2>
    ${cards}
  </section>`;
}

function renderAbout(agg: InsightAggregates): string {
  const generatedDate = new Date(agg.generatedAt).toUTCString();
  return `
  <section id="about">
    <h2>About</h2>
    <p>Generated: ${htmlEscape(generatedDate)}</p>
    <p>Window: last ${htmlEscape(safeNum(agg.windowDays))} days</p>
    <p>Data sources: session sidecars, witness traces, forge-telemetry.jsonl, routing-decisions.jsonl</p>
    <p>All data is local — no data leaves your machine.</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a fully self-contained HTML report string.
 * Accepts aggregates, recommendations, and options as pure data — no I/O.
 */
export function generateHtml(
  aggregates: InsightAggregates,
  recommendations: Recommendation[],
  _options: InsightsOptions,
): string {
  const sections = [
    renderSessions(aggregates),
    renderCost(aggregates),
    renderToolUsage(aggregates),
    renderDaemonTasks(aggregates),
    renderTraces(aggregates),
    renderRouting(aggregates),
    renderRecommendations(recommendations),
    renderAbout(aggregates),
  ].join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AFK Insights — ${htmlEscape(new Date(aggregates.generatedAt).toLocaleDateString())}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #c9d1d9; line-height: 1.6; }
    nav { background: #161b22; border-bottom: 1px solid #30363d; padding: 12px 24px; position: sticky; top: 0; z-index: 100; }
    nav a { color: #58a6ff; text-decoration: none; margin-right: 16px; font-size: 0.875rem; }
    nav a:hover { text-decoration: underline; }
    main { max-width: 1100px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 1.75rem; color: #e6edf3; margin-bottom: 8px; }
    h2 { font-size: 1.25rem; color: #e6edf3; border-bottom: 1px solid #30363d; padding-bottom: 8px; margin: 32px 0 16px; }
    h3 { font-size: 1rem; color: #8b949e; margin: 16px 0 8px; }
    section { margin-bottom: 48px; }
    .metrics-grid { display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 16px; }
    .metric-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 20px; min-width: 140px; }
    .metric-val { font-size: 1.5rem; font-weight: 700; color: #58a6ff; }
    .metric-label { font-size: 0.8rem; color: #8b949e; margin-top: 4px; }
    .no-data { color: #8b949e; font-style: italic; padding: 16px; background: #161b22; border-radius: 6px; }
    .all-clear { color: #3fb950; padding: 16px; background: #161b22; border-radius: 6px; }
    .caption { font-size: 0.85rem; color: #8b949e; margin-top: 8px; }
    table.bar-chart { border-collapse: collapse; width: 100%; }
    table.bar-chart td { padding: 3px 8px; font-size: 0.85rem; vertical-align: middle; }
    .bar-label { width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c9d1d9; }
    .bar-val { color: #8b949e; text-align: right; width: 80px; }
    table.data-table { border-collapse: collapse; width: 100%; font-size: 0.875rem; }
    table.data-table th, table.data-table td { padding: 8px 12px; border: 1px solid #30363d; text-align: left; }
    table.data-table th { background: #161b22; color: #8b949e; font-weight: 600; }
    .rec-card { border-radius: 8px; padding: 16px; margin-bottom: 12px; border-left: 4px solid #8b949e; background: #161b22; }
    .badge-high { border-left-color: #f85149; }
    .badge-medium { border-left-color: #f0883e; }
    .badge-info { border-left-color: #58a6ff; }
    .rec-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .badge { font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 12px; background: #30363d; color: #c9d1d9; }
    .badge-high .badge { background: #f85149; color: #fff; }
    .badge-medium .badge { background: #f0883e; color: #fff; }
    .badge-info .badge { background: #58a6ff; color: #fff; }
    p { margin: 8px 0; }
  </style>
</head>
<body>
  <nav>
    <a href="#sessions">Sessions</a>
    <a href="#cost">Cost</a>
    <a href="#tool-usage">Tool Usage</a>
    <a href="#daemon-tasks">Daemon Tasks</a>
    <a href="#traces">Traces</a>
    <a href="#routing">Routing</a>
    <a href="#recommendations">Recommendations</a>
    <a href="#about">About</a>
  </nav>
  <main>
    <h1>AFK Insights</h1>
    <p style="color:#8b949e;margin-bottom:24px;">Local usage analytics — ${htmlEscape(safeNum(aggregates.windowDays))}-day window</p>
    ${sections}
  </main>
</body>
</html>`;
}
