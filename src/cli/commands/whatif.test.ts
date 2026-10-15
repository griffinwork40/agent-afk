/**
 * Tests for src/cli/commands/whatif.ts — registerWhatifCommand.
 * Also covers the confirmSpec helper from whatif.confirm.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Mocks — declared before import of the module under test
// ---------------------------------------------------------------------------

vi.mock('../config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    apiKey: 'sk-test-123',
    model: 'claude-sonnet-4-5',
  }),
}));

vi.mock('../../paths.js', () => ({
  getAfkHome: vi.fn().mockReturnValue('/fake/afk-home'),
  getSkillsDir: vi.fn().mockReturnValue('/fake/afk-home/skills'),
  getPluginsDir: vi.fn().mockReturnValue('/fake/afk-home/plugins'),
}));

vi.mock('../../whatif/run.js', () => ({
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
    costUsd: 0.01,
    runDir: '/tmp/whatif-run-test',
    limits: [],
    headline: 'No change predicted.',
  }),
}));

vi.mock('../../whatif/report.js', () => ({
  renderTerminal: vi.fn().mockReturnValue(['Headline: No change.']),
  renderMarkdown: vi.fn().mockReturnValue('# Report\n'),
  buildHeadline: vi.fn().mockReturnValue('No change.'),
  standardLimits: vi.fn().mockReturnValue([]),
}));

vi.mock('../../whatif/surface.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../whatif/surface.js')>();
  return {
    ...actual,
    resolveSpec: vi.fn().mockResolvedValue({
      title: 'Append note',
      changes: [{ kind: 'append', target: 'user-afk-md', text: 'Always ask.' }],
    }),
    buildWhatifDeps: vi.fn().mockReturnValue({
      runner: {},
      complete: vi.fn(),
      makeJudge: vi.fn(),
      makeCrossCheckJudge: vi.fn(),
    }),
    readDirNames: vi.fn().mockReturnValue([]),
    // buildWhatifRunOptions: use real implementation so forwarding is verified.
  };
});

vi.mock('../../whatif/operators/index.js', () => ({
  describeChange: vi.fn().mockReturnValue('Append to AFK.md'),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn(),
    text: '',
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import { registerWhatifCommand } from './whatif.js';
import { confirmSpec } from './whatif.confirm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent process.exit in tests
  registerWhatifCommand(program);
  return program;
}

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe('registerWhatifCommand', () => {
  it('registers a whatif command', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'whatif');
    expect(cmd).toBeDefined();
  });

  it('whatif command has expected options', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'whatif')!;
    const optNames = cmd.options.map((o) => o.long);
    expect(optNames).toContain('--append');
    expect(optNames).toContain('--verify');
    expect(optNames).toContain('--model');
    expect(optNames).toContain('--max-usd');
    expect(optNames).toContain('--judge');
    expect(optNames).toContain('--yes');
    expect(optNames).toContain('--json');
    // #2599: --no-baseline-sample must be registered so Commander accepts it
    expect(optNames).toContain('--no-baseline-sample');
  });

  it('does not reject --no-baseline-sample (regression: #2599)', () => {
    const program = buildProgram();
    // Commander.exitOverride() converts unknown-option errors into thrown errors.
    // If --no-baseline-sample is unregistered this parse call throws.
    expect(() =>
      program.parse(['node', 'afk', 'whatif', '--append', 'x', '--no-baseline-sample', '--yes']),
    ).not.toThrow();
  });

  it('whatif command description includes predict', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'whatif')!;
    expect(cmd.description().toLowerCase()).toMatch(/predict|behaviour/);
  });
});

// ---------------------------------------------------------------------------
// --predict collector → buildArgvFromOpts bridge (#2861)
// ---------------------------------------------------------------------------

describe('registerWhatifCommand — --predict collector', () => {
  it('accumulates two --predict values and forwards both to runWhatif as operatorPredictions', async () => {
    const program = buildProgram();
    await program.parseAsync([
      'node', 'afk', 'whatif',
      '--append', 'Always ask first.',
      '--predict', 'agent asks a clarifying question',
      '--predict', 'response is concise',
      '--yes',
    ]);
    const calls = vi.mocked(runWhatif).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const opts = calls[calls.length - 1]![0];
    expect(opts.operatorPredictions).toBeDefined();
    expect(opts.operatorPredictions).toHaveLength(2);
    expect(opts.operatorPredictions![0]!.behavior).toBe('agent asks a clarifying question');
    expect(opts.operatorPredictions![1]!.behavior).toBe('response is concise');
  });
});

// ---------------------------------------------------------------------------
// Budget error handling
// ---------------------------------------------------------------------------

describe('registerWhatifCommand — budget error', () => {
  it('exports are present (smoke test)', () => {
    // registerWhatifCommand is importable and runs without error
    const program = new Command();
    program.exitOverride();
    expect(() => registerWhatifCommand(program)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// confirmSpec — regression: fix(#2609) resolve-before-close
// ---------------------------------------------------------------------------

describe('confirmSpec', () => {
  /**
   * Helper: returns a fake stdin PassThrough that emits `input` after a tick
   * so readline has time to attach its listeners before data arrives.
   */
  function fakeStdin(input: string): PassThrough {
    const pt = new PassThrough();
    setImmediate(() => pt.end(input));
    return pt;
  }

  it('returns true when the user answers y', async () => {
    const result = await confirmSpec([], 'Proceed?', fakeStdin('y\n'));
    expect(result).toBe(true);
  });

  it('returns true when the user answers Y (case-insensitive)', async () => {
    const result = await confirmSpec([], 'Proceed?', fakeStdin('Y\n'));
    expect(result).toBe(true);
  });

  it('returns false when the user answers n', async () => {
    const result = await confirmSpec([], 'Proceed?', fakeStdin('n\n'));
    expect(result).toBe(false);
  });

  it('returns false when the user answers N', async () => {
    const result = await confirmSpec([], 'Proceed?', fakeStdin('N\n'));
    expect(result).toBe(false);
  });

  it('returns false when stdin closes without input (Ctrl-D / EOF)', async () => {
    const pt = new PassThrough();
    setImmediate(() => pt.end()); // close without writing a line
    const result = await confirmSpec([], 'Proceed?', pt);
    expect(result).toBe(false);
  });

  it('accepts a custom question parameter', async () => {
    // Just verifies the signature — the return value still depends on input.
    const result = await confirmSpec(['info line'], 'Continue anyway?', fakeStdin('y\n'));
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MDE-error handling — issue #2610
// ---------------------------------------------------------------------------

import { runWhatif } from '../../whatif/run.js';

/**
 * Build a minimal WhatifMdeError-shaped error without importing the real class
 * (which has heavy transitive dependencies).
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

describe('registerWhatifCommand — MDE error (#2610)', () => {
  /**
   * Intercept process.exit by setting process.exitCode instead of throwing,
   * so the MDE-error path's `process.exit(2)` is captured without propagating
   * into Commander's outer try-catch (which would re-call handleCommandError
   * and overwrite the exit code with 1).
   */
  let originalExit: typeof process.exit;
  let exitCodeCaptured: number | undefined;
  let stderrLines: string[];
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitCodeCaptured = undefined;
    stderrLines = [];
    originalExit = process.exit;
    // Use a no-throw stub: record the first exit code but do not throw,
    // so the MDE exit(2) does not cascade into the outer handleCommandError.
    process.exit = ((code?: number) => {
      exitCodeCaptured ??= code ?? 0;
      // Throwing a special sentinel that propagates up but is distinguishable.
      throw new Error(`__EXIT__:${code ?? 0}`);
    }) as typeof process.exit;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.exit = originalExit;
    stderrSpy.mockRestore();
  });

  /** Run parseAsync and swallow any __EXIT__ sentinel; other errors re-throw. */
  async function parseAndCatch(program: Command, args: string[]): Promise<void> {
    try {
      await program.parseAsync(args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.startsWith('__EXIT__:')) throw err;
    }
  }

  it('--yes --force exits 2 without prompting for a non-measured headroom MDE error', async () => {
    vi.mocked(runWhatif).mockRejectedValueOnce(makeMdeErr({ measured: false, kind: 'headroom' }));
    const program = buildProgram();
    await parseAndCatch(program, ['node', 'afk', 'whatif', '--append', 'x', '--verify', '--yes', '--force']);
    // First exit code emitted by the MDE handler must be 2.
    expect(exitCodeCaptured).toBe(2);
    // Must not have prompted ("Proceed anyway?" should be absent from stderr)
    expect(stderrLines.join('')).not.toContain('Proceed anyway?');
  });

  it('--yes exits 2 without prompting for a non-measured MDE error', async () => {
    vi.mocked(runWhatif).mockRejectedValueOnce(makeMdeErr({ measured: false, kind: 'mde' }));
    const program = buildProgram();
    await parseAndCatch(program, ['node', 'afk', 'whatif', '--append', 'x', '--verify', '--yes']);
    expect(exitCodeCaptured).toBe(2);
    expect(stderrLines.join('')).not.toContain('Proceed anyway?');
  });

  it('exits 2 without prompting for a measured refusal (non-interactive)', async () => {
    vi.mocked(runWhatif).mockRejectedValueOnce(makeMdeErr({ measured: true, kind: 'headroom' }));
    const program = buildProgram();
    await parseAndCatch(program, ['node', 'afk', 'whatif', '--append', 'x', '--verify']);
    expect(exitCodeCaptured).toBe(2);
    expect(stderrLines.join('')).not.toContain('Proceed anyway?');
  });

  it('includes --no-baseline-sample advice in the error message for a measured refusal', async () => {
    vi.mocked(runWhatif).mockRejectedValueOnce(
      makeMdeErr({ measured: true, kind: 'headroom', msg: 'Prediction p1 headroom 5pp < MDE 15pp' }),
    );
    const program = buildProgram();
    await parseAndCatch(program, ['node', 'afk', 'whatif', '--append', 'x', '--verify']);
    expect(stderrLines.join('')).toContain('--no-baseline-sample');
  });

  it('never retries with force=true for a measured refusal (non-interactive)', async () => {
    const measuredErr = makeMdeErr({ measured: true, kind: 'headroom' });
    vi.mocked(runWhatif).mockRejectedValueOnce(measuredErr);
    const program = buildProgram();
    await parseAndCatch(program, ['node', 'afk', 'whatif', '--append', 'x', '--verify']);
    // runWhatif should have been called exactly once — no retry.
    expect(vi.mocked(runWhatif)).toHaveBeenCalledTimes(1);
  });
});
