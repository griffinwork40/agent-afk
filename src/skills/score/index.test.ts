/**
 * Tests for src/skills/score — Day 3 branch scorer for `afk farm`.
 *
 * Strategy:
 *   - Real fs (tmpdir fixtures) for tsconfig/package.json detection
 *   - Mocked spawn via the _spawn injection seam — synthetic test runs
 *     emit fake stderr + exit codes deterministically
 *   - Mocked _now / _nowIso for stable duration_ms and scoredAt assertions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';

import {
  scoreBranch,
  writeScore,
  rankBranches,
  SCORE_SCHEMA_VERSION,
  type BranchScore,
} from './index.js';

// ---------------------------------------------------------------------------
// Fake spawn — drives the test through scripted child-process responses.
// ---------------------------------------------------------------------------

type SpawnInvocation = { cmd: string; args: ReadonlyArray<string> | undefined; cwd: string };
type Scripted = {
  exitCode?: number | null;
  stderr?: string;
  stdout?: string;
  /** Emit an 'error' event before close, simulating ENOENT-style failures. */
  errorMsg?: string;
  /** If set, never emit close — simulates hang (used with timeout tests). */
  hang?: boolean;
};

interface FakeSpawnHandle {
  invocations: SpawnInvocation[];
  /** Map keyed by cmd substring → scripted response (first match wins). */
  scripts: Array<{ match: string; response: Scripted }>;
  fn: (cmd: string, argsOrOpts: unknown, maybeOpts?: unknown) => ChildProcess;
}

function makeFakeSpawn(scripts: FakeSpawnHandle['scripts'] = []): FakeSpawnHandle {
  const invocations: SpawnInvocation[] = [];
  const handle: FakeSpawnHandle = {
    invocations,
    scripts,
    fn: (cmd, argsOrOpts, maybeOpts) => {
      // Both signatures: spawn(cmd, opts) and spawn(cmd, args, opts).
      let args: ReadonlyArray<string> | undefined;
      let opts: { cwd?: string };
      if (Array.isArray(argsOrOpts)) {
        args = argsOrOpts as string[];
        opts = (maybeOpts ?? {}) as { cwd?: string };
      } else {
        args = undefined;
        opts = (argsOrOpts ?? {}) as { cwd?: string };
      }
      invocations.push({ cmd, args, cwd: opts.cwd ?? '' });

      const script = scripts.find((s) => cmd.includes(s.match))?.response ?? { exitCode: 0 };

      const child = new EventEmitter() as ChildProcess & { kill: (sig?: string) => boolean };
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      (child as unknown as { stdout: EventEmitter }).stdout = stdout;
      (child as unknown as { stderr: EventEmitter }).stderr = stderr;
      child.kill = () => {
        // Simulate forceful kill: emit close with null code on next tick.
        setImmediate(() => child.emit('close', null));
        return true;
      };

      if (script.hang) return child;

      // Schedule async emission so the consumer can attach listeners first.
      setImmediate(() => {
        if (script.errorMsg) {
          child.emit('error', new Error(script.errorMsg));
          return;
        }
        if (script.stderr) stderr.emit('data', script.stderr);
        if (script.stdout) stdout.emit('data', script.stdout);
        child.emit('close', script.exitCode ?? 0);
      });

      return child;
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let fixtureRoot: string;

beforeEach(async () => {
  fixtureRoot = await fs.mkdtemp(join(tmpdir(), 'afk-score-test-'));
});

afterEach(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

async function writePkg(scripts: Record<string, string> = { test: 'vitest run' }): Promise<void> {
  await fs.writeFile(
    join(fixtureRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts }, null, 2),
  );
}

async function writePnpmLock(): Promise<void> {
  await fs.writeFile(join(fixtureRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
}

async function writeTsconfig(): Promise<void> {
  await fs.writeFile(join(fixtureRoot, 'tsconfig.json'), '{}');
}

// ---------------------------------------------------------------------------
// scoreBranch
// ---------------------------------------------------------------------------

describe('scoreBranch', () => {
  it('returns pass=1, fail=0 when tests succeed', async () => {
    await writePkg();
    await writePnpmLock();
    const fake = makeFakeSpawn([
      { match: 'pnpm test', response: { exitCode: 0 } },
      { match: 'git', response: { stdout: ' 1 file changed, 5 insertions(+), 2 deletions(-)' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc123',
      _spawn: fake.fn,
      _now: () => 1000,
      _nowIso: () => '2026-05-17T00:00:00.000Z',
    });
    expect(result.pass).toBe(1);
    expect(result.fail).toBe(0);
    expect(result.testCmd).toBe('pnpm test');
    expect(result.loc_delta).toBe(3);
    expect(result.lint_ok).toBe(null); // no tsconfig
    expect(result.error).toBeUndefined();
  });

  it('returns pass=0, fail=1 when tests fail', async () => {
    await writePkg();
    const fake = makeFakeSpawn([
      { match: 'npm test', response: { exitCode: 1, stderr: '3 failed' } },
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.pass).toBe(0);
    expect(result.fail).toBe(1);
    expect(result.testCmd).toBe('npm test'); // no pnpm-lock → npm
  });

  it('records error when no test command is found', async () => {
    await writePkg({ build: 'tsc' }); // no test script
    const fake = makeFakeSpawn([
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.pass).toBe(0);
    expect(result.fail).toBe(0);
    expect(result.error).toMatch(/no test command found/);
    expect(result.testCmd).toBeUndefined();
  });

  it('handles missing package.json gracefully', async () => {
    const fake = makeFakeSpawn([
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.error).toMatch(/no test command found/);
  });

  it('respects explicit testCmd override', async () => {
    await writePkg(); // would auto-detect npm test
    const fake = makeFakeSpawn([
      { match: 'custom-runner', response: { exitCode: 0 } },
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      testCmd: 'custom-runner --ci',
      _spawn: fake.fn,
    });
    expect(result.testCmd).toBe('custom-runner --ci');
    expect(result.pass).toBe(1);
  });

  it('runs tsc when tsconfig.json is present', async () => {
    await writePkg();
    await writeTsconfig();
    const fake = makeFakeSpawn([
      { match: 'npm test', response: { exitCode: 0 } },
      { match: 'tsc', response: { exitCode: 0 } },
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.lint_ok).toBe(true);
    expect(fake.invocations.some((i) => i.cmd.includes('tsc'))).toBe(true);
  });

  it('records lint_ok=false when tsc fails', async () => {
    await writePkg();
    await writeTsconfig();
    const fake = makeFakeSpawn([
      { match: 'npm test', response: { exitCode: 0 } },
      { match: 'tsc', response: { exitCode: 2 } },
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.lint_ok).toBe(false);
  });

  it('records lint_ok=null when tsconfig is absent (non-TS project)', async () => {
    await writePkg();
    const fake = makeFakeSpawn([
      { match: 'npm test', response: { exitCode: 0 } },
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.lint_ok).toBe(null);
    // tsc should NOT have been invoked
    expect(fake.invocations.some((i) => i.cmd.includes('tsc'))).toBe(false);
  });

  it('parses loc_delta from git --shortstat output', async () => {
    await writePkg();
    const fake = makeFakeSpawn([
      { match: 'npm test', response: { exitCode: 0 } },
      { match: 'git', response: { stdout: ' 4 files changed, 100 insertions(+), 30 deletions(-)' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.loc_delta).toBe(70);
  });

  it('handles single-side diffs (insertions only)', async () => {
    await writePkg();
    const fake = makeFakeSpawn([
      { match: 'npm test', response: { exitCode: 0 } },
      { match: 'git', response: { stdout: ' 1 file changed, 5 insertions(+)' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.loc_delta).toBe(5);
  });

  it('returns 0 loc_delta when git produces no output', async () => {
    await writePkg();
    const fake = makeFakeSpawn([
      { match: 'npm test', response: { exitCode: 0 } },
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.loc_delta).toBe(0);
  });

  it('records timeout error when tests hang', async () => {
    await writePkg();
    const fake = makeFakeSpawn([
      { match: 'npm test', response: { hang: true } },
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      timeoutMs: 50,
      _spawn: fake.fn,
    });
    expect(result.fail).toBe(1);
    expect(result.pass).toBe(0);
    expect(result.error).toMatch(/timed out after 50ms/);
  });

  it('records crash error when spawn emits error event', async () => {
    await writePkg();
    const fake = makeFakeSpawn([
      { match: 'npm test', response: { errorMsg: 'ENOENT: command not found' } },
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.fail).toBe(1);
    expect(result.error).toMatch(/test runner crashed/);
  });

  it('emits the schema version', async () => {
    await writePkg();
    const fake = makeFakeSpawn([
      { match: 'npm test', response: { exitCode: 0 } },
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.schemaVersion).toBe(SCORE_SCHEMA_VERSION);
  });

  it('prefers pnpm when pnpm-lock.yaml exists', async () => {
    await writePkg();
    await writePnpmLock();
    const fake = makeFakeSpawn([
      { match: 'pnpm test', response: { exitCode: 0 } },
      { match: 'git', response: { stdout: '' } },
    ]);
    const result = await scoreBranch({
      branchPath: fixtureRoot,
      baseSha: 'abc',
      _spawn: fake.fn,
    });
    expect(result.testCmd).toBe('pnpm test');
  });
});

// ---------------------------------------------------------------------------
// writeScore
// ---------------------------------------------------------------------------

describe('writeScore', () => {
  it('writes score.json under <farmDir>/scores/branch-<n>.json', async () => {
    const score: BranchScore = {
      schemaVersion: SCORE_SCHEMA_VERSION,
      pass: 1,
      fail: 0,
      loc_delta: 5,
      lint_ok: true,
      duration_ms: 1234,
      branchPath: '/x/y/z',
      baseSha: 'deadbeef',
      scoredAt: '2026-05-17T00:00:00.000Z',
    };
    const path = await writeScore(fixtureRoot, 3, score);
    expect(path).toBe(join(fixtureRoot, 'scores', 'branch-3.json'));
    const raw = await fs.readFile(path, 'utf8');
    expect(JSON.parse(raw)).toEqual(score);
  });

  it('creates the scores directory if missing', async () => {
    const score: BranchScore = {
      schemaVersion: SCORE_SCHEMA_VERSION,
      pass: 0,
      fail: 1,
      loc_delta: 0,
      lint_ok: null,
      duration_ms: 0,
      branchPath: '/x',
      baseSha: 'a',
      scoredAt: '2026-05-17T00:00:00.000Z',
    };
    await writeScore(join(fixtureRoot, 'nested'), 1, score);
    const stat = await fs.stat(join(fixtureRoot, 'nested', 'scores'));
    expect(stat.isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rankBranches
// ---------------------------------------------------------------------------

function mkScore(partial: Partial<BranchScore>): BranchScore {
  return {
    schemaVersion: SCORE_SCHEMA_VERSION,
    pass: 0,
    fail: 0,
    loc_delta: 0,
    lint_ok: null,
    duration_ms: 0,
    branchPath: '/x',
    baseSha: 'a',
    scoredAt: '2026-05-17T00:00:00.000Z',
    ...partial,
  };
}

describe('rankBranches', () => {
  it('ranks passing branches above failing ones', () => {
    const result = rankBranches([
      { index: 1, score: mkScore({ pass: 0, fail: 1 }) },
      { index: 2, score: mkScore({ pass: 1, fail: 0 }) },
      { index: 3, score: mkScore({ pass: 0, fail: 1 }) },
    ]);
    expect(result[0]).toBe(2);
  });

  it('breaks ties by lint_ok (true > false > null)', () => {
    const result = rankBranches([
      { index: 1, score: mkScore({ pass: 1, fail: 0, lint_ok: null }) },
      { index: 2, score: mkScore({ pass: 1, fail: 0, lint_ok: true }) },
      { index: 3, score: mkScore({ pass: 1, fail: 0, lint_ok: false }) },
    ]);
    expect(result).toEqual([2, 3, 1]);
  });

  it('breaks ties by loc_delta ascending (fewer lines preferred)', () => {
    const result = rankBranches([
      { index: 1, score: mkScore({ pass: 1, fail: 0, lint_ok: true, loc_delta: 100 }) },
      { index: 2, score: mkScore({ pass: 1, fail: 0, lint_ok: true, loc_delta: 10 }) },
      { index: 3, score: mkScore({ pass: 1, fail: 0, lint_ok: true, loc_delta: 50 }) },
    ]);
    expect(result).toEqual([2, 3, 1]);
  });

  it('places null-score branches at the end, sorted by index', () => {
    const result = rankBranches([
      { index: 1, score: null },
      { index: 2, score: mkScore({ pass: 1, fail: 0 }) },
      { index: 3, score: null },
      { index: 4, score: mkScore({ pass: 0, fail: 1 }) },
    ]);
    expect(result).toEqual([2, 4, 1, 3]);
  });

  it('is stable across equal scores (falls back to index asc)', () => {
    const result = rankBranches([
      { index: 5, score: mkScore({ pass: 1, fail: 0 }) },
      { index: 2, score: mkScore({ pass: 1, fail: 0 }) },
      { index: 3, score: mkScore({ pass: 1, fail: 0 }) },
    ]);
    expect(result).toEqual([2, 3, 5]);
  });

  it('handles empty input', () => {
    expect(rankBranches([])).toEqual([]);
  });

  it('handles all-fail case (still produces a ranking)', () => {
    const result = rankBranches([
      { index: 1, score: mkScore({ pass: 0, fail: 1, lint_ok: false, loc_delta: 50 }) },
      { index: 2, score: mkScore({ pass: 0, fail: 1, lint_ok: true, loc_delta: 30 }) },
      { index: 3, score: mkScore({ pass: 0, fail: 1, lint_ok: false, loc_delta: 10 }) },
    ]);
    // All have pass=0, fail=1 → tie on rate.
    // Then lint_ok: 2 (true) wins, then 1 and 3 tie on lint_ok (both false),
    // tie-break by loc_delta asc → 3 (10) before 1 (50).
    expect(result).toEqual([2, 3, 1]);
  });
});
