/**
 * Integration tests for the `afk insights` CLI command.
 *
 * Strategy: test the exported function directly (same pattern as trace.test.ts
 * and bg.test.ts) rather than spawning Commander, which avoids process-exit
 * complexity. We verify the output HTML file, the aggregation window, and the
 * --no-open flag behavior via mocking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Test temp directory
// ---------------------------------------------------------------------------

let tmpRoot: string;
let outputPath: string;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `afk-insights-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpRoot, { recursive: true });
  outputPath = join(tmpRoot, 'test-insights.html');
  vi.mocked(openInBrowser).mockClear();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Import the module under test (after tmpRoot setup)
// ---------------------------------------------------------------------------

import { aggregateAll } from '../../insights/aggregators/index.js';
import { evaluateRecommendations } from '../../insights/recommendations.js';
import { generateHtml } from '../../insights/html.js';
import { openInBrowser } from '../../insights/open.js';
import type { InsightsOptions } from '../../insights/types.js';

// Mock the open module at the module level so the imported `openInBrowser`
// binding that `runInsights` actually calls is the mock. (The previous test
// spied on a throwaway `{ openInBrowser }` object literal, which never bound
// to the real call site — so the assertion passed regardless of behavior.)
vi.mock('../../insights/open.js', () => ({ openInBrowser: vi.fn() }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runInsights(
  opts: InsightsOptions & { outputPath: string; open?: boolean },
): Promise<string> {
  const { outputPath: outPath, open = true, ...insightsOpts } = opts;

  mkdirSync(join(tmpRoot, 'state', 'sessions'), { recursive: true });

  const aggregates = await aggregateAll(insightsOpts);
  const recommendations = evaluateRecommendations(aggregates);
  const html = generateHtml(aggregates, recommendations, insightsOpts);

  writeFileSync(outPath, html, 'utf-8');

  if (open) {
    openInBrowser(outPath);
  }

  return html;
}

function writeSession(afkHome: string, name: string, data: Record<string, unknown>): void {
  const dir = join(afkHome, 'state', 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data), 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('insights command (integration)', () => {
  it('writes a valid HTML file to output path', async () => {
    await runInsights({ days: 30, afkHome: tmpRoot, outputPath, open: false });

    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toContain('<html');
    expect(content).toContain('</html>');
  });

  it('HTML output contains all 8 section headings', async () => {
    await runInsights({ days: 30, afkHome: tmpRoot, outputPath, open: false });

    const content = readFileSync(outputPath, 'utf-8');
    const headings = ['Sessions', 'Cost', 'Tool Usage', 'Daemon Tasks', 'Traces', 'Routing', 'Recommendations', 'About'];
    for (const h of headings) {
      expect(content).toContain(`<h2>${h}</h2>`);
    }
  });

  it('empty AFK_HOME (no data sources): exits without throw, writes valid HTML', async () => {
    // tmpRoot has no sessions/traces/telemetry — aggregators should return zeros
    await expect(
      runInsights({ days: 7, afkHome: tmpRoot, outputPath, open: false }),
    ).resolves.toContain('<html');

    expect(existsSync(outputPath)).toBe(true);
  });

  it('--days 7: sessions outside 7d window excluded', async () => {
    // Write an old session (40 days ago)
    const oldTs = Date.now() - 40 * 24 * 60 * 60 * 1000;
    writeSession(tmpRoot, 'old-session', {
      sessionId: 'old-1',
      model: 'claude-3-opus',
      source: 'cli',
      startedAt: oldTs,
      totalCostUsd: 99.99,
      usage: { input_tokens: 1000000, output_tokens: 2000000 },
    });

    // Write a recent session (1 day ago)
    writeSession(tmpRoot, 'new-session', {
      sessionId: 'new-1',
      model: 'claude-3-5-sonnet',
      source: 'cli',
      startedAt: Date.now() - 1 * 24 * 60 * 60 * 1000,
      totalCostUsd: 0.05,
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const aggregates = await aggregateAll({ days: 7, afkHome: tmpRoot });

    // Old session ($99.99 cost) must be excluded
    expect(aggregates.sessions.totalSessions).toBe(1);
    expect(aggregates.sessions.totalCostUsd).toBeCloseTo(0.05);
    expect(aggregates.sessions.totalCostUsd).toBeLessThan(1);
  });

  it('--no-open: openInBrowser is NOT called', async () => {
    await runInsights({ days: 30, afkHome: tmpRoot, outputPath, open: false });

    // openInBrowser is module-mocked, so the spy binds the real call site the
    // pipeline invokes — this assertion can actually fail if the guard breaks.
    expect(vi.mocked(openInBrowser)).not.toHaveBeenCalled();
    expect(existsSync(outputPath)).toBe(true);
  });

  it('default (open): openInBrowser IS called with the report path', async () => {
    await runInsights({ days: 30, afkHome: tmpRoot, outputPath, open: true });

    expect(vi.mocked(openInBrowser)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openInBrowser)).toHaveBeenCalledWith(outputPath);
    expect(existsSync(outputPath)).toBe(true);
  });

  it('HTML output does not contain NaN or undefined', async () => {
    await runInsights({ days: 30, afkHome: tmpRoot, outputPath, open: false });

    const content = readFileSync(outputPath, 'utf-8');
    expect(content).not.toContain('NaN');
    expect(content).not.toContain('>undefined<');
    expect(content).not.toContain('>null<');
  });

  it('recommendations section renders when all healthy', async () => {
    await runInsights({ days: 30, afkHome: tmpRoot, outputPath, open: false });

    const content = readFileSync(outputPath, 'utf-8');
    // With no data, all-clear should show
    expect(content).toContain('all-clear');
  });

  it('HTML is self-contained: no external script or link tags', async () => {
    await runInsights({ days: 30, afkHome: tmpRoot, outputPath, open: false });

    const content = readFileSync(outputPath, 'utf-8');
    expect(content).not.toMatch(/<script\s+src=/i);
    expect(content).not.toMatch(/<link\s/i);
  });
});
