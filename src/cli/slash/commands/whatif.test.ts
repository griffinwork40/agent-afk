/**
 * Tests for the /whatif slash command.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SlashContext, SessionStats } from '../types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../whatif/run.js', () => ({
  runWhatif: vi.fn().mockResolvedValue({
    spec: { title: 'Test', changes: [] },
    structural: {
      baseline: { model: 'm', system: '', tools: [], firstUserMessage: '' },
      candidate: { model: 'm', system: '', tools: [], firstUserMessage: '' },
      systemDiff: '',
      toolsAdded: [],
      toolsRemoved: [],
      toolsChanged: [],
      userMessageDiff: '',
      tokens: { baseline: 100, candidate: 100 },
      modelChanged: false,
    },
    predictions: [],
    verify: undefined,
    costUsd: 0.01,
    runDir: '/tmp/whatif-run-abc',
    limits: [],
    headline: 'No significant behavioural change predicted.',
  }),
}));

vi.mock('../../../whatif/report.js', () => ({
  renderTerminal: vi.fn().mockReturnValue(['Headline: No change.']),
  renderMarkdown: vi.fn().mockReturnValue('# Report\n'),
  buildHeadline: vi.fn().mockReturnValue('No change.'),
  standardLimits: vi.fn().mockReturnValue([]),
}));

vi.mock('../../config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({ apiKey: 'sk-test-key', model: 'claude-sonnet-4-5' }),
}));

vi.mock('../../../paths.js', () => ({
  getAfkHome: vi.fn().mockReturnValue('/fake/afk-home'),
  getSkillsDir: vi.fn().mockReturnValue('/fake/afk-home/skills'),
  getPluginsDir: vi.fn().mockReturnValue('/fake/afk-home/plugins'),
}));

vi.mock('../../../whatif/surface.js', () => ({
  resolveSpec: vi.fn().mockResolvedValue({
    title: 'Append note to AFK.md',
    changes: [{ kind: 'append', target: 'user-afk-md', text: 'Always ask.' }],
  }),
  buildWhatifDeps: vi.fn().mockReturnValue({
    runner: {},
    complete: vi.fn(),
    makeJudge: vi.fn(),
    makeCrossCheckJudge: vi.fn(),
    onProgress: undefined,
    signal: undefined,
  }),
  readDirNames: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../whatif/operators/index.js', () => ({
  describeChange: vi.fn().mockReturnValue('Append to AFK.md'),
}));

// Import under test AFTER mocks are declared.
import { whatifCmd } from './whatif.js';
import { runWhatif } from '../../../whatif/run.js';

// ---------------------------------------------------------------------------
// Helper: fake SlashContext
// ---------------------------------------------------------------------------

function makeCtx(): { ctx: SlashContext; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const stats: SessionStats = {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
  };
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats,
    out: {
      line: (t = '') => lines.push(t),
      raw: (t) => lines.push(t),
      success: (t) => lines.push(`SUCCESS:${t}`),
      info: (t) => lines.push(`INFO:${t}`),
      warn: (t) => lines.push(`WARN:${t}`),
      error: (t) => { errors.push(t); lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    setSoftStopHandler: vi.fn(),
  };
  return { ctx, lines, errors };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/whatif slash command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has correct name and summary', () => {
    expect(whatifCmd.name).toBe('/whatif');
    expect(whatifCmd.summary).toBeTruthy();
    expect(typeof whatifCmd.summary).toBe('string');
  });

  it('shows usage when called with no args', async () => {
    const { ctx, lines } = makeCtx();
    await whatifCmd.handler(ctx, '');
    expect(lines.some((l) => l.includes('USAGE') || l.includes('afk whatif'))).toBe(true);
  });

  it('shows usage when called with --help', async () => {
    const { ctx, lines } = makeCtx();
    await whatifCmd.handler(ctx, '--help');
    expect(lines.some((l) => l.includes('USAGE') || l.includes('afk whatif'))).toBe(true);
  });

  it('runs whatif for a flag-based change with --yes', async () => {
    const { ctx, lines } = makeCtx();
    await whatifCmd.handler(ctx, '--append "Always ask." --yes');
    expect(runWhatif).toHaveBeenCalled();
    expect(lines.some((l) => l.includes('report.md') || l.includes('report'))).toBe(true);
  });

  it('prints compiled spec and asks for --yes when text is given without --yes', async () => {
    const { resolveSpec } = await import('../../../whatif/surface.js');
    vi.mocked(resolveSpec).mockResolvedValueOnce({
      title: 'Turn off auto-routing',
      changes: [{ kind: 'append', target: 'user-afk-md', text: 'No routing.' }],
    });

    const { ctx, lines } = makeCtx();
    // Plain text input WITHOUT --yes — handler should print spec and prompt re-run
    await whatifCmd.handler(ctx, '"turn off auto-routing"');
    expect(runWhatif).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('--yes'))).toBe(true);
  });

  it('emits error when no API key is configured', async () => {
    const { loadConfig } = await import('../../config.js');
    vi.mocked(loadConfig).mockReturnValueOnce({ model: 'sonnet' } as ReturnType<typeof loadConfig>);

    const { ctx, errors } = makeCtx();
    await whatifCmd.handler(ctx, '--append "x" --yes');
    expect(errors.some((e) => e.includes('API key'))).toBe(true);
    expect(runWhatif).not.toHaveBeenCalled();
  });

  it('emits error on bad flag', async () => {
    const { ctx, errors } = makeCtx();
    await whatifCmd.handler(ctx, '--not-a-flag');
    expect(errors.length).toBeGreaterThan(0);
    expect(runWhatif).not.toHaveBeenCalled();
  });

  it('handles budget error gracefully', async () => {
    const budgetErr = Object.assign(new Error('budget'), {
      estimateUsd: 8,
      maxUsd: 5,
    });
    vi.mocked(runWhatif).mockRejectedValueOnce(budgetErr);

    const { ctx, errors } = makeCtx();
    await whatifCmd.handler(ctx, '--append "x" --yes');
    expect(errors.some((e) => e.includes('budget') || e.includes('USD') || e.includes('usd') || e.includes('max'))).toBe(true);
  });

  it('emits JSON output when --json is passed', async () => {
    const { ctx, lines } = makeCtx();
    await whatifCmd.handler(ctx, '--append "Always ask." --yes --json');
    const jsonLine = lines.find((l) => {
      try { JSON.parse(l); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
  });

  it('registers setSoftStopHandler for cancellation', async () => {
    const { ctx } = makeCtx();
    await whatifCmd.handler(ctx, '--append "x" --yes');
    expect(ctx.setSoftStopHandler).toHaveBeenCalled();
  });

  it('returns continue', async () => {
    const { ctx } = makeCtx();
    const result = await whatifCmd.handler(ctx, '--append "Always ask." --yes');
    expect(result).toBe('continue');
  });
});
