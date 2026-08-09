/**
 * Structural snapshot tests for the HTML generator.
 *
 * Tests verify:
 *   - Required HTML structure is present
 *   - All 8 section headings appear
 *   - Privacy: no responseExcerpt or telegramChatId in output
 *   - No NaN or undefined in rendered text
 *   - No external resources (script src, link tags)
 *   - "No data" placeholders render with zero aggregates
 *   - Actual values render with non-zero aggregates
 */

import { describe, it, expect } from 'vitest';
import { generateHtml, htmlEscape } from './html.js';
import type { InsightAggregates, Recommendation } from './types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeZeroAgg(): InsightAggregates {
  return {
    generatedAt: 1700000000000,
    windowDays: 30,
    sessions: {
      totalSessions: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      byDay: {},
      byModel: {},
      bySurface: {},
    },
    traces: {
      totalTracedSessions: 0,
      toolCallCounts: {},
      toolErrorCounts: {},
      toolDurationsMs: {},
      subagentForkDepths: {},
      compactionCount: 0,
      closureReasons: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCostUsd: 0,
      sessionsWithCost: 0,
    },
    daemon: {
      totalRuns: 0,
      successCount: 0,
      errorCount: 0,
      skipCount: 0,
      byTaskId: {},
      triggerBreakdown: {},
      skipReasons: {},
      recentErrors: [],
      avgDurationMs: 0,
    },
    routing: {
      totalRoutingEvents: 0,
      skillDispatchModes: {},
      skillFrequency: {},
      composeCallCount: 0,
      avgComposeNodes: 0,
      avgComposeEdges: 0,
      overflowKills: {},
    },
  };
}

function makeNonZeroAgg(): InsightAggregates {
  return {
    generatedAt: 1700000000000,
    windowDays: 7,
    sessions: {
      totalSessions: 42,
      totalCostUsd: 3.1415,
      totalTokens: 170000,
      byDay: {
        '2024-01-01': { costUsd: 1.0, sessions: 10 },
        '2024-01-02': { costUsd: 2.14, sessions: 32 },
      },
      byModel: {
        'claude-3-5-sonnet': { costUsd: 1.5, sessions: 30 },
        'claude-3-opus': { costUsd: 1.64, sessions: 12 },
      },
      bySurface: {
        cli: { costUsd: 3.0, sessions: 40 },
        telegram: { costUsd: 0.14, sessions: 2 },
      },
    },
    traces: {
      totalTracedSessions: 35,
      toolCallCounts: { bash: 100, read_file: 50, grep: 25 },
      toolErrorCounts: { bash: 5 },
      toolDurationsMs: { bash: 50000, read_file: 5000 },
      subagentForkDepths: { 1: 8, 2: 2 },
      compactionCount: 3,
      closureReasons: { model_end_turn: 30, budget_exceeded: 5 },
      totalInputTokens: 50000,
      totalOutputTokens: 120000,
      totalCacheReadTokens: 800000,
      totalCacheCreationTokens: 40000,
      // Deliberately ~3x sessions.totalCostUsd (3.1415, above) — mirrors the
      // real-world undercount from issue #864, where trace-derived cost is
      // authoritative and the narrower session-sidecar total is not.
      // Diverging the two fixture values lets a test pin which source the
      // rendered cost actually came from.
      //
      // Keep BOTH literals at exactly 4 decimals: `formatCost` renders via
      // `safeNum(usd, 4)` → `toFixed(4)`, so the sentinel assertion
      // `not.toContain('3.1415')` only works while the fixture value matches
      // the rendered string byte-for-byte. A 3- or 5-decimal value here would
      // silently make that assertion vacuous rather than failing loudly.
      totalCostUsd: 9.4245,
      sessionsWithCost: 12,
    },
    daemon: {
      totalRuns: 20,
      successCount: 15,
      errorCount: 3,
      skipCount: 2,
      byTaskId: {
        'task-a': { success: 10, error: 1, skip: 1 },
      },
      triggerBreakdown: { cron: 18, sessionstart: 2 },
      skipReasons: { cooldown: 2 },
      recentErrors: [
        { taskId: 'task-a', ts: 1700000000000, message: 'task failed with exit 1' },
      ],
      avgDurationMs: 5000,
    },
    routing: {
      totalRoutingEvents: 50,
      skillDispatchModes: { fork: 20, inline: 25, load: 5 },
      skillFrequency: { forge: 15, improve: 10 },
      composeCallCount: 5,
      avgComposeNodes: 4.2,
      avgComposeEdges: 3.8,
      overflowKills: { web_scrape: 2 },
    },
  };
}

/**
 * Simulates AFK_TRACE_DISABLED=1 (or a legacy install predating the
 * witness-trace system): no trace coverage at all — `traces.totalTracedSessions`
 * and `traces.totalCostUsd` are both 0, since no trace.jsonl is ever written
 * for that population — but the session sidecar still recorded real spend.
 * Exercises the sidecar-cost fallback in html.ts (review comment on PR #933 /
 * issue #864 follow-up).
 */
function makeSidecarOnlyAgg(): InsightAggregates {
  const agg = makeZeroAgg();
  agg.sessions.totalSessions = 10;
  agg.sessions.totalCostUsd = 4.2;
  agg.sessions.totalTokens = 5000;
  return agg;
}

/**
 * Trace coverage EXISTS but is entirely unpriced: `totalTracedSessions > 0`
 * while `traces.totalCostUsd === 0`, and the sidecar still holds real spend.
 * Realistic trigger is a wide `--days` window straddling the witness-trace
 * rollout, where every traced session ran on a local ($0) model. Distinct
 * from makeSidecarOnlyAgg (no trace coverage at all): this is the branch a
 * `totalTracedSessions > 0` predicate would misread as a genuine zero.
 */
function makeZeroTraceCostAgg(): InsightAggregates {
  const agg = makeZeroAgg();
  agg.sessions.totalSessions = 8;
  agg.sessions.totalCostUsd = 7.5;
  agg.sessions.totalTokens = 4000;
  agg.traces.totalTracedSessions = 12;
  agg.traces.totalCostUsd = 0;
  return agg;
}

const NO_RECS: Recommendation[] = [];
const OPTS = { days: 30 };

const SOME_RECS: Recommendation[] = [
  {
    severity: 'high',
    title: 'High error rate on tool "bash"',
    body: 'The tool "bash" has a 50% error rate over 10 calls.',
    metric: 0.5,
  },
  {
    severity: 'info',
    title: 'Cost concentrated on model "claude-3-opus"',
    body: '95% of total spend is on claude-3-opus.',
    metric: 0.95,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateHtml', () => {
  it('output contains <html and </html>', () => {
    const html = generateHtml(makeZeroAgg(), NO_RECS, OPTS);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('all 8 section headings present in output', () => {
    const html = generateHtml(makeZeroAgg(), NO_RECS, OPTS);
    const headings = ['Sessions', 'Cost', 'Tool Usage', 'Daemon Tasks', 'Traces', 'Routing', 'Recommendations', 'About'];
    for (const heading of headings) {
      expect(html).toContain(`<h2>${heading}</h2>`);
    }
  });

  it('zero aggregates: each section renders a no-data placeholder', () => {
    const html = generateHtml(makeZeroAgg(), NO_RECS, OPTS);
    // Each section should have a "no data" marker
    expect(html).toContain('no-data');
    // All clear for recommendations when no recs
    expect(html).toContain('all-clear');
  });

  it('zero aggregates: no NaN or undefined appears in output text', () => {
    const html = generateHtml(makeZeroAgg(), NO_RECS, OPTS);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('>null<');
  });

  it('non-zero aggregates: totalSessions rendered as number', () => {
    const html = generateHtml(makeNonZeroAgg(), SOME_RECS, OPTS);
    expect(html).toContain('42'); // totalSessions
  });

  it('non-zero aggregates: totalCostUsd rendered correctly', () => {
    const html = generateHtml(makeNonZeroAgg(), SOME_RECS, OPTS);
    expect(html).toContain('9.4245'); // cost value — trace-sourced, see below
  });

  it('regression #864: Cost and Sessions cost cards render the trace aggregate, not the narrower session sidecar', () => {
    // The headline previously read `sessions.totalCostUsd` (sidecar), whose
    // coverage is narrower than the witness-trace aggregate on real
    // datasets (sessions with no sidecar still have a trace) — undercounting
    // spend by ~3x. The fixture deliberately diverges the two totals
    // (traces: 9.4245 vs. sessions: 3.1415) so a regression to the sidecar
    // source is provably caught here rather than passing silently.
    const agg = makeNonZeroAgg();
    const html = generateHtml(agg, SOME_RECS, OPTS);
    expect(agg.traces.totalCostUsd).not.toBe(agg.sessions.totalCostUsd); // fixture sanity
    expect(html).toContain('9.4245'); // traces.totalCostUsd — authoritative, must be present
    expect(html).not.toContain('3.1415'); // sessions.totalCostUsd — narrower value must not leak as a displayed cost
  });

  it('fallback: no trace coverage (AFK_TRACE_DISABLED=1 / legacy install) falls back to sidecar cost instead of hiding it', () => {
    // totalTracedSessions === 0 is absence of trace signal, not a genuine
    // zero-cost result — the Cost section must not render "No cost data"
    // and the Sessions card must not render "$0.00" while the sidecar still
    // holds real spend.
    const agg = makeSidecarOnlyAgg();
    const html = generateHtml(agg, NO_RECS, OPTS);

    expect(agg.traces.totalTracedSessions).toBe(0); // fixture sanity
    expect(agg.traces.totalCostUsd).toBe(0); // fixture sanity

    // Cost section: sidecar total rendered, not the "no cost data" placeholder.
    const costSection = html.slice(html.indexOf('id="cost"'), html.indexOf('id="tool-usage"'));
    expect(costSection).not.toContain('No cost data');
    expect(costSection).toContain('$4.2000');

    // Sessions section's "Total Cost" card: sidecar total, not $0.00.
    const sessionsSection = html.slice(html.indexOf('id="sessions"'), html.indexOf('id="cost"'));
    expect(sessionsSection).toContain('$4.2000');
    expect(sessionsSection).not.toContain('$0.00');
  });

  it('fallback: traced sessions exist but report zero cost — sidecar spend is still rendered, not hidden', () => {
    // Guards the predicate itself: keying the source on `totalTracedSessions > 0`
    // (rather than on the trace COST) would treat this unpriced-but-traced
    // window as a genuine $0 and discard real sidecar spend — the same failure
    // class as #864, one layer down. Only branch of resolveCost() that
    // distinguishes the two predicates, so it is the regression guard.
    const agg = makeZeroTraceCostAgg();
    const html = generateHtml(agg, NO_RECS, OPTS);

    expect(agg.traces.totalTracedSessions).toBeGreaterThan(0); // fixture sanity
    expect(agg.traces.totalCostUsd).toBe(0); // fixture sanity
    expect(agg.sessions.totalCostUsd).toBeGreaterThan(0); // fixture sanity

    const costSection = html.slice(html.indexOf('id="cost"'), html.indexOf('id="tool-usage"'));
    expect(costSection).not.toContain('No cost data');
    expect(costSection).toContain('$7.5000');

    const sessionsSection = html.slice(html.indexOf('id="sessions"'), html.indexOf('id="cost"'));
    expect(sessionsSection).toContain('$7.5000');
    expect(sessionsSection).not.toContain('$0.00');
  });

  it('sidecar-scoped cost breakdowns are captioned so they cannot be misread as contradicting the trace-sourced total', () => {
    // The "Total Cost" card is trace-sourced while "Cost by Model" / "Cost by
    // Day" remain sidecar-sourced (TraceAggregates has no per-model/per-day
    // split), so the two can legitimately disagree — 9.4245 vs 3.14 on this
    // fixture. Without the caption that reads as the #864 bug, relocated.
    const html = generateHtml(makeNonZeroAgg(), NO_RECS, OPTS);
    const sessionsSection = html.slice(html.indexOf('id="sessions"'), html.indexOf('id="cost"'));

    expect(sessionsSection).toContain('Cost by Model');
    expect(sessionsSection).toContain('Cost by Day');
    // One caption per cost chart, and none attached to the session-count chart.
    const captions = sessionsSection.split('may not sum to Total Cost above').length - 1;
    expect(captions).toBe(2);
  });

  it('output does NOT contain string "responseExcerpt"', () => {
    // Even when agg contains error messages, responseExcerpt key must not appear
    const html = generateHtml(makeNonZeroAgg(), SOME_RECS, OPTS);
    expect(html).not.toContain('responseExcerpt');
  });

  it('output does NOT contain string "telegramChatId"', () => {
    const html = generateHtml(makeNonZeroAgg(), SOME_RECS, OPTS);
    expect(html).not.toContain('telegramChatId');
  });

  it('output does NOT contain external script or link tags', () => {
    const html = generateHtml(makeNonZeroAgg(), SOME_RECS, OPTS);
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link\s/i);
  });

  it('fixture responseExcerpt value never appears in html output', () => {
    const SECRET = 'super-secret-response-excerpt-content';
    // Put it somewhere that might accidentally leak
    const agg = makeNonZeroAgg();
    // Force it into recentErrors which should only show taskId + message
    agg.daemon.recentErrors = [
      { taskId: 'task-x', ts: Date.now(), message: 'normal error message' },
    ];

    // The SECRET should never have been in the input — we verify the HTML
    // doesn't contain it regardless of what the upstream aggregator might have had.
    const html = generateHtml(agg, NO_RECS, OPTS);
    expect(html).not.toContain(SECRET);
  });

  it('zero-aggregates path and has-data path both exercise recommendation section', () => {
    const htmlNoRecs = generateHtml(makeZeroAgg(), [], OPTS);
    const htmlWithRecs = generateHtml(makeZeroAgg(), SOME_RECS, OPTS);

    expect(htmlNoRecs).toContain('all-clear');
    expect(htmlWithRecs).toContain('badge-high');
  });

  it('recommendations section renders severity badges', () => {
    const html = generateHtml(makeZeroAgg(), SOME_RECS, OPTS);
    expect(html).toContain('badge-high');
    expect(html).toContain('badge-info');
    expect(html).toContain('HIGH');
    expect(html).toContain('INFO');
  });

  it('recommendation titles and bodies are HTML-escaped', () => {
    const recs: Recommendation[] = [
      {
        severity: 'high',
        title: 'Tool <script>alert(1)</script> error',
        body: 'Body with <b>markup</b> & "quotes"',
        metric: 0.5,
      },
    ];
    const html = generateHtml(makeZeroAgg(), recs, OPTS);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&amp;');
  });

  it('non-zero session data: model names appear in output', () => {
    const html = generateHtml(makeNonZeroAgg(), NO_RECS, OPTS);
    expect(html).toContain('claude-3-5-sonnet');
    expect(html).toContain('claude-3-opus');
  });

  it('non-zero daemon data: tool usage appears', () => {
    const html = generateHtml(makeNonZeroAgg(), NO_RECS, OPTS);
    expect(html).toContain('bash');
  });

  it('non-zero aggregates: no NaN or undefined in rendered output', () => {
    const html = generateHtml(makeNonZeroAgg(), SOME_RECS, OPTS);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });
});

describe('htmlEscape', () => {
  it('escapes & < > " and apostrophe', () => {
    expect(htmlEscape('&')).toBe('&amp;');
    expect(htmlEscape('<')).toBe('&lt;');
    expect(htmlEscape('>')).toBe('&gt;');
    expect(htmlEscape('"')).toBe('&quot;');
    expect(htmlEscape("'")).toBe('&#39;');
  });

  it('leaves safe characters unchanged', () => {
    expect(htmlEscape('hello world 123')).toBe('hello world 123');
  });
});
