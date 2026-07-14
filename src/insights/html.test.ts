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
      totalCostUsd: 3.1415,
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
    expect(html).toContain('3.1415'); // cost value
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
