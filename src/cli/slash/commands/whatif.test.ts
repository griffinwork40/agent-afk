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

vi.mock('../../../whatif/surface.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../whatif/surface.js')>();
  return {
    ...actual,
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
    // buildWhatifRunOptions: use real implementation so forwarding is verified.
  };
});

vi.mock('../../../whatif/operators/index.js', () => ({
  describeChange: vi.fn().mockReturnValue('Append to AFK.md'),
}));

// Import under test AFTER mocks are declared.
import { whatifCmd, makeProgressThrottle } from './whatif.js';
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

  it('forwards --force to runWhatif so the MDE gate can be bypassed', async () => {
    const { ctx } = makeCtx();
    await whatifCmd.handler(ctx, '--append "Always ask." --verify --yes --force');
    expect(vi.mocked(runWhatif).mock.calls[0]?.[0]).toMatchObject({ force: true });
  });

  it('passes force: false when --force is absent', async () => {
    const { ctx } = makeCtx();
    await whatifCmd.handler(ctx, '--append "Always ask." --verify --yes');
    expect(vi.mocked(runWhatif).mock.calls[0]?.[0]).toMatchObject({ force: false });
  });

  it('runs whatif for a flag-based change with --yes', async () => {
    const { ctx, lines } = makeCtx();
    await whatifCmd.handler(ctx, '--append "Always ask." --yes');
    expect(runWhatif).toHaveBeenCalled();
    expect(lines.some((l) => l.includes('report.md') || l.includes('report'))).toBe(true);
  });

  it('forwards --no-baseline-sample to runWhatif (regression: #2599)', async () => {
    const { ctx } = makeCtx();
    await whatifCmd.handler(ctx, '--append "Always ask." --no-baseline-sample --yes');
    expect(vi.mocked(runWhatif).mock.calls[0]?.[0]).toMatchObject({ noBaselineSample: true });
  });

  it('does not set noBaselineSample when flag is absent', async () => {
    const { ctx } = makeCtx();
    await whatifCmd.handler(ctx, '--append "Always ask." --yes');
    // noBaselineSample should be absent (not spread in) when flag not given
    expect(vi.mocked(runWhatif).mock.calls[0]?.[0]).not.toMatchObject({ noBaselineSample: true });
  });

  it('forwards --predict operatorPredictions to runWhatif (regression: #3255)', async () => {
    const { ctx } = makeCtx();
    await whatifCmd.handler(
      ctx,
      '--append "Always ask." --predict "should greet the user" --yes',
    );
    const firstCallOpts = vi.mocked(runWhatif).mock.calls[0]?.[0];
    expect(firstCallOpts).toMatchObject({
      operatorPredictions: [
        expect.objectContaining({ behavior: 'should greet the user' }),
      ],
    });
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

  // -------------------------------------------------------------------------
  // MDE error handling — issue #2610
  // -------------------------------------------------------------------------

  /**
   * Build a minimal WhatifMdeError-shaped error without importing run.ts.
   */
  function makeMdeErr(opts: { measured?: boolean; kind?: 'mde' | 'headroom'; msg?: string }) {
    const err = new Error(opts.msg ?? 'whatif: run is underpowered — headroom too small');
    err.name = 'WhatifMdeError';
    Object.assign(err, {
      episodesPerArm: 6,
      kind: opts.kind ?? 'mde',
      measured: opts.measured ?? false,
    });
    return err;
  }

  it('emits error for a headroom MDE refusal with --yes --force (never prompts)', async () => {
    vi.mocked(runWhatif).mockRejectedValueOnce(makeMdeErr({ measured: false, kind: 'headroom' }));
    const { ctx, errors } = makeCtx();
    await whatifCmd.handler(ctx, '--append "x" --verify --yes --force');
    // Must have emitted an error (not silently passed)
    expect(errors.length).toBeGreaterThan(0);
    // runWhatif called exactly once — no retry with force
    expect(vi.mocked(runWhatif)).toHaveBeenCalledTimes(1);
  });

  it('emits error for a measured refusal with --no-baseline-sample advice', async () => {
    vi.mocked(runWhatif).mockRejectedValueOnce(
      makeMdeErr({
        measured: true,
        kind: 'headroom',
        msg: 'Prediction p1 headroom 5pp < MDE 15pp',
      }),
    );
    const { ctx, errors } = makeCtx();
    await whatifCmd.handler(ctx, '--append "x" --verify --yes');
    expect(errors.some((e) => e.includes('--no-baseline-sample'))).toBe(true);
  });

  it('never retries with force for a measured refusal', async () => {
    vi.mocked(runWhatif).mockRejectedValueOnce(makeMdeErr({ measured: true, kind: 'headroom' }));
    const { ctx } = makeCtx();
    await whatifCmd.handler(ctx, '--append "x" --verify --yes');
    expect(vi.mocked(runWhatif)).toHaveBeenCalledTimes(1);
  });

  it('emits error message for non-measured MDE refusal without --yes (non-interactive slash)', async () => {
    vi.mocked(runWhatif).mockRejectedValueOnce(makeMdeErr({ measured: false, kind: 'mde' }));
    const { ctx, errors } = makeCtx();
    // No --yes, no TTY in slash context — should refuse (non-interactive path)
    await whatifCmd.handler(ctx, '--append "x" --verify');
    expect(errors.length).toBeGreaterThan(0);
    expect(vi.mocked(runWhatif)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// makeProgressThrottle — preflight milestone lines always print
// ---------------------------------------------------------------------------

describe('makeProgressThrottle', () => {
  function makeInfoCtx() {
    const infoLines: string[] = [];
    const ctx = {
      out: {
        info: (t: string) => infoLines.push(t),
        line: () => undefined,
        raw: () => undefined,
        success: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      ui: { clearScreen: () => undefined, repaintStatusLine: () => undefined },
      setSoftStopHandler: () => undefined,
      session: {} as never,
      stats: {} as never,
    };
    return { ctx: ctx as never, infoLines };
  }

  it('prints the first message of a new stage regardless of done', () => {
    const { ctx, infoLines } = makeInfoCtx();
    const throttle = makeProgressThrottle(ctx);
    throttle('preflight', 'Checking cost…', 10);
    expect(infoLines).toHaveLength(1);
    expect(infoLines[0]).toContain('Checking cost');
  });

  it('prints consecutive preflight messages with no done counter (milestone lines)', () => {
    const { ctx, infoLines } = makeInfoCtx();
    const throttle = makeProgressThrottle(ctx);
    // First message initialises the stage.
    throttle('preflight', 'Cost estimate: $0.04', undefined);
    // Second preflight message, no done counter — must not be silently dropped.
    throttle('preflight', 'Headroom warning: only 12% left', undefined);
    expect(infoLines).toHaveLength(2);
    expect(infoLines[1]).toContain('Headroom warning');
  });

  it('throttles per-episode messages with a done counter (every 10th)', () => {
    const { ctx, infoLines } = makeInfoCtx();
    const throttle = makeProgressThrottle(ctx);
    // First episodes call initialises the stage (stage-change path always prints).
    throttle('episodes', 'episode 1/30', 1);
    const afterFirst = infoLines.length; // = 1
    // Episodes 2–10: episodeCount increments to 1–9 inside the branch → none are % 10 → suppressed.
    for (let i = 2; i <= 10; i++) throttle('episodes', `episode ${i}/30`, i);
    expect(infoLines).toHaveLength(afterFirst); // none printed
    // Episode 11: episodeCount reaches 10 → prints.
    throttle('episodes', 'episode 11/30', 11);
    expect(infoLines).toHaveLength(afterFirst + 1);
    expect(infoLines[afterFirst]).toContain('episode 11/30');
  });
});
