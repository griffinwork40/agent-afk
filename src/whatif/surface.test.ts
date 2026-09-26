/**
 * Tests for resolveSpec and buildWhatifDeps in surface.ts.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { CompleteFn, ChangeSpec } from './types.js';
import type { ParsedWhatifArgs } from './args.js';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before the imports under test
// ---------------------------------------------------------------------------

vi.mock('./compile.js', () => ({
  compileChangeSpec: vi.fn(),
}));

vi.mock('./complete.js', () => ({
  createAnthropicComplete: vi.fn().mockReturnValue(() =>
    Promise.resolve({ text: '{}', costUsd: 0 }),
  ),
}));

vi.mock('./runner/afk-runner.js', () => ({
  createAfkRunner: vi.fn().mockReturnValue({ name: 'afk-runner', run: vi.fn(), snapshot: vi.fn() }),
}));

vi.mock('./judge/index.js', () => ({
  resolveJudge: vi.fn().mockResolvedValue({ name: 'claude', external: false, grade: vi.fn() }),
}));

vi.mock('./judge/jev-connect.js', () => ({
  connectJev: vi.fn(),
}));

vi.mock('./judge/claude.js', () => ({
  createClaudeJudge: vi.fn().mockReturnValue({ name: 'claude', external: false, grade: vi.fn() }),
}));

vi.mock('../agent/whatif-episode-gate.js', () => ({
  isWhatifEpisode: vi.fn().mockReturnValue(false),
}));

import { resolveSpec, buildWhatifDeps, readDirNames } from './surface.js';
import { compileChangeSpec } from './compile.js';
import { isWhatifEpisode } from '../agent/whatif-episode-gate.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeParsed(overrides: Partial<ParsedWhatifArgs> = {}): ParsedWhatifArgs {
  return {
    flagChanges: [],
    text: undefined,
    specFile: undefined,
    options: {
      agentModel: undefined,
      analystModel: undefined,
      verify: false,
      turns: 12,
      samples: 3,
      maxUsd: 5,
      judge: 'auto',
      concurrency: 4,
      maxTurns: 3,
      episodeTimeoutMs: 180_000,
      keepSandboxes: false,
    },
    yes: false,
    json: false,
    ...overrides,
  };
}

const fakeDeps = {
  complete: vi.fn() as unknown as CompleteFn,
  analystModel: 'claude-sonnet-4-5',
  realHome: '/fake/home',
  skills: ['mint', 'diagnose'],
  plugins: ['myplugin'],
};

// ---------------------------------------------------------------------------
// resolveSpec — flags only
// ---------------------------------------------------------------------------

describe('resolveSpec — flag changes', () => {
  it('assembles spec from flag changes without calling compiler', async () => {
    const parsed = makeParsed({
      flagChanges: [
        { kind: 'append', target: 'user-afk-md', text: 'Always ask.' },
      ],
    });

    const spec = await resolveSpec(parsed, fakeDeps);
    expect(spec.changes).toHaveLength(1);
    expect(spec.changes[0]).toMatchObject({ kind: 'append' });
    expect(compileChangeSpec).not.toHaveBeenCalled();
  });

  it('title is derived from describeChange', async () => {
    const parsed = makeParsed({
      flagChanges: [{ kind: 'model', model: 'haiku' }],
    });
    const spec = await resolveSpec(parsed, fakeDeps);
    expect(spec.title).toBeTruthy();
    expect(typeof spec.title).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// resolveSpec — spec file
// ---------------------------------------------------------------------------

describe('resolveSpec — spec file', () => {
  it('loads and returns a spec file', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = tmpdir();
    const file = join(dir, `whatif-test-${Date.now()}.json`);
    const spec: ChangeSpec = {
      title: 'Test spec from file',
      changes: [{ kind: 'disable-skill', name: 'diagnose' }],
    };
    writeFileSync(file, JSON.stringify(spec));

    const parsed = makeParsed({ specFile: file });
    const result = await resolveSpec(parsed, fakeDeps);
    expect(result.title).toBe('Test spec from file');
    expect(result.changes).toHaveLength(1);
  });

  it('throws on invalid JSON in spec file', async () => {
    const { writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const file = join(tmpdir(), `whatif-bad-${Date.now()}.json`);
    writeFileSync(file, 'not valid json {{{');

    const parsed = makeParsed({ specFile: file });
    await expect(resolveSpec(parsed, fakeDeps)).rejects.toThrow(/valid JSON/);
  });

  it('throws when spec file does not exist', async () => {
    const parsed = makeParsed({ specFile: '/no/such/file-xyz.json' });
    await expect(resolveSpec(parsed, fakeDeps)).rejects.toThrow(/cannot read spec/);
  });
});

// ---------------------------------------------------------------------------
// resolveSpec — plain text compilation
// ---------------------------------------------------------------------------

describe('resolveSpec — plain text', () => {
  afterEach(() => {
    vi.mocked(compileChangeSpec).mockReset();
  });

  it('calls compileChangeSpec with text and available skills/plugins', async () => {
    const compiled: ChangeSpec = {
      title: 'Disable auto-routing',
      changes: [{ kind: 'append', target: 'user-afk-md', text: 'No routing.' }],
    };
    vi.mocked(compileChangeSpec).mockResolvedValueOnce(compiled);

    const parsed = makeParsed({ text: 'turn off auto-routing' });
    const spec = await resolveSpec(parsed, fakeDeps);

    expect(compileChangeSpec).toHaveBeenCalledWith(
      'turn off auto-routing',
      fakeDeps.complete,
      fakeDeps.analystModel,
      { skills: fakeDeps.skills, plugins: fakeDeps.plugins },
    );
    expect(spec.title).toBe('Disable auto-routing');
  });

  it('throws when compiler returns UNRESOLVED spec', async () => {
    vi.mocked(compileChangeSpec).mockResolvedValueOnce({
      title: 'UNRESOLVED: cannot determine file contents',
      changes: [],
    });

    const parsed = makeParsed({ text: 'set my secret file to something' });
    await expect(resolveSpec(parsed, fakeDeps)).rejects.toThrow(/UNRESOLVED/);
  });

  it('merges flag changes before compiled changes', async () => {
    const compiled: ChangeSpec = {
      title: 'Disable auto-routing',
      changes: [{ kind: 'append', target: 'user-afk-md', text: 'No routing.' }],
    };
    vi.mocked(compileChangeSpec).mockResolvedValueOnce(compiled);

    const parsed = makeParsed({
      text: 'turn off auto-routing',
      flagChanges: [{ kind: 'model', model: 'haiku' }],
    });
    const spec = await resolveSpec(parsed, fakeDeps);

    expect(spec.changes[0]).toMatchObject({ kind: 'model' });
    expect(spec.changes[1]).toMatchObject({ kind: 'append' });
  });
});

// ---------------------------------------------------------------------------
// resolveSpec — error on no input
// ---------------------------------------------------------------------------

describe('resolveSpec — no input', () => {
  it('throws when no text, no specFile, no flagChanges', async () => {
    const parsed = makeParsed();
    await expect(resolveSpec(parsed, fakeDeps)).rejects.toThrow(/no change/);
  });
});

// ---------------------------------------------------------------------------
// buildWhatifDeps — recursion guard
// ---------------------------------------------------------------------------

describe('buildWhatifDeps — recursion guard', () => {
  it('throws when AFK_WHATIF_EPISODE is set', () => {
    vi.mocked(isWhatifEpisode).mockReturnValueOnce(true);
    expect(() =>
      buildWhatifDeps({ token: 'tok', analystModel: 'sonnet' }),
    ).toThrow(/recursion guard/);
  });

  it('does not throw when not in episode mode', () => {
    vi.mocked(isWhatifEpisode).mockReturnValueOnce(false);
    expect(() =>
      buildWhatifDeps({ token: 'tok', analystModel: 'sonnet' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// readDirNames
// ---------------------------------------------------------------------------

describe('readDirNames', () => {
  it('returns empty array for non-existent directory', () => {
    expect(readDirNames('/no/such/dir-xyz123')).toEqual([]);
  });

  it('returns subdirectory names for a real directory', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(tmpdir() + '/whatif-readdir-');
    mkdirSync(dir + '/skill-a');
    mkdirSync(dir + '/skill-b');
    const names = readDirNames(dir);
    expect(names).toContain('skill-a');
    expect(names).toContain('skill-b');
  });
});
