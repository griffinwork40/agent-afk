/**
 * Tests for src/cli/commands/whatif.ts — registerWhatifCommand.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

vi.mock('../../whatif/surface.js', () => ({
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
}));

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
  });

  it('whatif command description includes predict', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'whatif')!;
    expect(cmd.description().toLowerCase()).toMatch(/predict|behaviour/);
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
// keptSandboxes CLI output (#2478)
// ---------------------------------------------------------------------------

describe('registerWhatifCommand — keptSandboxes stdout', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('prints sandbox paths when report.keptSandboxes is set', async () => {
    const { runWhatif } = await import('../../whatif/run.js');
    vi.mocked(runWhatif).mockResolvedValueOnce({
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
      keptSandboxes: {
        baseline: '/tmp/afk-abc123/home',
        candidate: '/tmp/afk-xyz789/home',
      },
    });

    const program = buildProgram();
    try {
      // from:'node' means argv[0]=node, argv[1]=script, argv[2]=subcommand
      await program.parseAsync(['node', 'afk', 'whatif', '--append', 'test note', '--yes']);
    } catch {
      // commander exitOverride may throw on process.exit; that's fine
    }

    const written = stdoutSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(written).toContain('/tmp/afk-abc123/home');
    expect(written).toContain('/tmp/afk-xyz789/home');
    expect(written).toContain('sandboxes.json');
  });

  it('does not print sandbox paths when report.keptSandboxes is absent', async () => {
    const program = buildProgram();
    try {
      await program.parseAsync(['node', 'afk', 'whatif', '--append', 'test note', '--yes']);
    } catch {
      // commander exitOverride may throw on process.exit; that's fine
    }

    const written = stdoutSpy.mock.calls.map((args) => String(args[0])).join('');
    expect(written).not.toContain('Sandboxes kept');
    expect(written).not.toContain('sandboxes.json');
  });
});
