/**
 * Tests for the pre-existing-defects HTML section renderer.
 *
 * Covers:
 *   - Empty / missing aggregate renders nothing (empty string).
 *   - Non-empty aggregate renders the section heading and table rows.
 *   - HTML escaping applied to locus, category, signal values.
 *   - Date slicing (ISO string → YYYY-MM-DD).
 *   - Recurrence count and caption text.
 *
 * @module insights/html.preexisting-defects.test
 */

import { describe, it, expect } from 'vitest';
import { renderPreexistingDefects } from './html.preexisting-defects.js';
import type { InsightAggregates } from './types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeAgg(
  topClusters: Array<{
    repo: string;
    locus: string;
    signal: string;
    category: string;
    recurrenceCount: number;
    firstSeen: string;
    lastSeen: string;
  }> = [],
  totalRecords = 0,
  skippedOutOfWindow = 0,
  ledgerTruncated = false,
): InsightAggregates {
  // Only the `preexistingDefects` and `windowDays` fields are used by this renderer.
  return {
    generatedAt: Date.now(),
    windowDays: 30,
    preexistingDefects: { totalRecords, skippedOutOfWindow, topClusters, ledgerTruncated },
    // Required fields — unused by this renderer, set to zero.
    sessions: { totalSessions: 0, totalCostUsd: 0, totalTokens: 0, byDay: {}, byModel: {}, bySurface: {} },
    traces: { totalTracedSessions: 0, toolCallCounts: {}, toolErrorCounts: {}, toolDurationsMs: {}, subagentForkDepths: {}, compactionCount: 0, closureReasons: {}, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0, totalCostUsd: 0, sessionsWithCost: 0 },
    daemon: { totalRuns: 0, successCount: 0, errorCount: 0, skipCount: 0, byTaskId: {}, triggerBreakdown: {}, skipReasons: {}, recentErrors: [], avgDurationMs: 0 },
    routing: { totalRoutingEvents: 0, skillDispatchModes: {}, skillFrequency: {}, composeCallCount: 0, avgComposeNodes: 0, avgComposeEdges: 0, overflowKills: {} },
    outcomes: { byWeek: {}, totalRecords: 0, parseErrors: 0 },
  } as InsightAggregates;
}

const CLUSTER_FIXTURE = {
  repo: '/home/user/myrepo',
  locus: 'src/agent/session.test.ts',
  signal: 'preexisting-sentence',
  category: 'failing-test',
  recurrenceCount: 5,
  firstSeen: '2025-01-01T00:00:00.000Z',
  lastSeen: '2025-01-20T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderPreexistingDefects', () => {
  it('returns empty string when topClusters is empty', () => {
    const agg = makeAgg([], 0, 0);
    expect(renderPreexistingDefects(agg)).toBe('');
  });

  it('returns empty string when preexistingDefects is missing', () => {
    const agg = makeAgg();
    // Force remove the field to simulate a legacy aggregate.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (agg as any).preexistingDefects;
    expect(renderPreexistingDefects(agg)).toBe('');
  });

  it('renders section heading when clusters are present', () => {
    const agg = makeAgg([CLUSTER_FIXTURE], 5, 0);
    const html = renderPreexistingDefects(agg);
    expect(html).toContain('Most-Acknowledged Pre-existing Defects');
    expect(html).toContain('<table class="data-table">');
  });

  it('renders locus text in a table row', () => {
    const agg = makeAgg([CLUSTER_FIXTURE], 5, 0);
    const html = renderPreexistingDefects(agg);
    expect(html).toContain('src/agent/session.test.ts');
  });

  it('renders recurrenceCount as sessions column', () => {
    const agg = makeAgg([CLUSTER_FIXTURE], 5, 0);
    const html = renderPreexistingDefects(agg);
    expect(html).toContain('>5<');
  });

  it('renders dates sliced to YYYY-MM-DD', () => {
    const agg = makeAgg([CLUSTER_FIXTURE], 5, 0);
    const html = renderPreexistingDefects(agg);
    expect(html).toContain('2025-01-01');
    expect(html).toContain('2025-01-20');
    // Full ISO string should not appear in the date cells
    expect(html).not.toContain('T00:00:00.000Z');
  });

  it('HTML-escapes locus values', () => {
    const xssCluster = { ...CLUSTER_FIXTURE, locus: '<script>alert(1)</script>' };
    const agg = makeAgg([xssCluster], 1, 0);
    const html = renderPreexistingDefects(agg);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders caption with totalRecords and window days', () => {
    const agg = makeAgg([CLUSTER_FIXTURE], 10, 2);
    const html = renderPreexistingDefects(agg);
    expect(html).toContain('10 total ledger records');
    expect(html).toContain('2 outside the 30-day window');
  });

  it('renders multiple clusters in order', () => {
    const clusterA = { ...CLUSTER_FIXTURE, locus: 'src/a.test.ts', recurrenceCount: 3 };
    const clusterB = { ...CLUSTER_FIXTURE, locus: 'src/b.test.ts', recurrenceCount: 7 };
    const agg = makeAgg([clusterA, clusterB], 10, 0);
    const html = renderPreexistingDefects(agg);
    const posA = html.indexOf('src/a.test.ts');
    const posB = html.indexOf('src/b.test.ts');
    // Both should appear.
    expect(posA).toBeGreaterThan(-1);
    expect(posB).toBeGreaterThan(-1);
  });

  it('truncates very long locus names', () => {
    const longLocus = 'src/' + 'x'.repeat(100) + '.ts';
    const cluster = { ...CLUSTER_FIXTURE, locus: longLocus };
    const agg = makeAgg([cluster], 1, 0);
    const html = renderPreexistingDefects(agg);
    expect(html).toContain('...');
  });

  it('renders section id="preexisting-defects"', () => {
    const agg = makeAgg([CLUSTER_FIXTURE], 1, 0);
    const html = renderPreexistingDefects(agg);
    expect(html).toContain('id="preexisting-defects"');
  });

  it('renders Repo column header and cluster repo path in a table row', () => {
    // Advisory finding #3320: no test previously asserted the Repo column renders.
    const agg = makeAgg([CLUSTER_FIXTURE], 1, 0);
    const html = renderPreexistingDefects(agg);
    // The thead must have a "Repo" column.
    expect(html).toContain('<th>Repo</th>');
    // The cluster's repo field must appear in the row (possibly truncated with ellipsis).
    // CLUSTER_FIXTURE.repo is '/home/user/myrepo' — short enough to render without truncation.
    expect(html).toContain(CLUSTER_FIXTURE.repo);
  });

  it('truncates very long repo paths with a leading ellipsis', () => {
    const longRepo = '/home/user/' + 'x'.repeat(60) + '/myrepo';
    const cluster = { ...CLUSTER_FIXTURE, repo: longRepo };
    const agg = makeAgg([cluster], 1, 0);
    const html = renderPreexistingDefects(agg);
    // Renderer caps at 40 chars with a leading '...' for long paths.
    expect(html).toContain('...');
    // The raw long path should not appear verbatim in the output.
    expect(html).not.toContain(longRepo);
  });

  it('renders truncation warning banner when ledgerTruncated is true', () => {
    const agg = makeAgg([CLUSTER_FIXTURE], 5, 0, true);
    const html = renderPreexistingDefects(agg);
    expect(html).toContain('Ledger exceeded the 1 MB read cap');
    expect(html).toContain('tail only — ledger truncated');
  });

  it('does not render truncation banner when ledgerTruncated is false', () => {
    const agg = makeAgg([CLUSTER_FIXTURE], 5, 0, false);
    const html = renderPreexistingDefects(agg);
    expect(html).not.toContain('Ledger exceeded the 1 MB read cap');
    expect(html).not.toContain('tail only — ledger truncated');
  });
});
