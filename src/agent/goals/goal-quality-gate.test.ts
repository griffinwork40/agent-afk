/**
 * Tests for goal-quality-gate.ts — Phase 2a shell-check quality gates.
 *
 * All tests use an injected `spawnFn` stub so no real child processes are
 * forked. The stub returns canned `SpawnResult` values (stdout/stderr as
 * plain strings — no Buffer dependency needed in tests).
 */

import { describe, expect, it } from 'vitest';
import {
  parseChecksEnv,
  runGoalQualityGates,
  MAX_OUTPUT_BYTES,
  CHECKS_SEPARATOR,
  type SpawnFn,
} from './goal-quality-gate.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function alwaysPassFn(stdout = ''): SpawnFn {
  return (_command, _opts) => ({ status: 0, stdout, stderr: '' });
}

function alwaysFailFn(stderr = 'error', exitCode = 1): SpawnFn {
  return (_command, _opts) => ({ status: exitCode, stdout: '', stderr });
}

function timeoutFn(): SpawnFn {
  return (_command, _opts) => ({
    status: null,
    stdout: '',
    stderr: '',
    error: new Error('spawnSync ETIMEDOUT'),
  });
}

/** Build a stub that returns different results keyed by command string. */
function perCommandFn(
  responses: Record<string, { status: number; stdout?: string; stderr?: string }>,
): SpawnFn {
  return (command, _opts) => {
    const r = responses[command];
    if (!r) return { status: 0, stdout: '', stderr: '' };
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

// ── parseChecksEnv ────────────────────────────────────────────────────────────

describe('parseChecksEnv', () => {
  it('returns [] for undefined', () => {
    expect(parseChecksEnv(undefined)).toEqual([]);
  });

  it('returns [] for empty string', () => {
    expect(parseChecksEnv('')).toEqual([]);
  });

  it('returns [] for whitespace-only string', () => {
    expect(parseChecksEnv('   ')).toEqual([]);
  });

  it('splits on colon separator', () => {
    expect(parseChecksEnv('pnpm test:pnpm lint')).toEqual(['pnpm test', 'pnpm lint']);
  });

  it('trims whitespace around each command', () => {
    expect(parseChecksEnv(' pnpm test : pnpm lint ')).toEqual(['pnpm test', 'pnpm lint']);
  });

  it('filters out empty segments from consecutive separators', () => {
    expect(parseChecksEnv('pnpm test::pnpm lint')).toEqual(['pnpm test', 'pnpm lint']);
  });

  it('handles a single command with no separator', () => {
    expect(parseChecksEnv('pnpm test')).toEqual(['pnpm test']);
  });

  it('uses the CHECKS_SEPARATOR constant (colon)', () => {
    expect(CHECKS_SEPARATOR).toBe(':');
  });
});

// ── runGoalQualityGates — empty checks ───────────────────────────────────────

describe('runGoalQualityGates — no checks configured', () => {
  it('returns passed=true with empty results when checks is []', async () => {
    const report = await runGoalQualityGates([], { spawnFn: alwaysPassFn() });
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(0);
    expect(report.completedAt).toBeTruthy();
  });

  it('sets commitSha to null when git fails', async () => {
    const report = await runGoalQualityGates([], {
      spawnFn: alwaysFailFn('not a repo', 128),
      cwd: '/fake',
    });
    expect(report.commitSha).toBeNull();
  });
});

// ── runGoalQualityGates — single passing command ─────────────────────────────

describe('runGoalQualityGates — single passing command', () => {
  it('returns passed=true when exit code is 0', async () => {
    const report = await runGoalQualityGates(['pnpm test'], {
      spawnFn: alwaysPassFn('all tests passed'),
      cwd: '/fake',
    });
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]!.command).toBe('pnpm test');
    expect(report.results[0]!.status).toBe('passed');
    expect(report.results[0]!.exitCode).toBe(0);
    expect(report.results[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stdout in output', async () => {
    const report = await runGoalQualityGates(['pnpm test'], {
      spawnFn: alwaysPassFn('Test suite passed'),
      cwd: '/fake',
    });
    expect(report.results[0]!.output).toContain('Test suite passed');
  });
});

// ── runGoalQualityGates — single failing command ──────────────────────────────

describe('runGoalQualityGates — single failing command', () => {
  it('returns passed=false when exit code is non-zero', async () => {
    const report = await runGoalQualityGates(['pnpm test'], {
      spawnFn: alwaysFailFn('3 tests failed', 1),
      cwd: '/fake',
    });
    expect(report.passed).toBe(false);
    expect(report.results[0]!.status).toBe('failed');
    expect(report.results[0]!.exitCode).toBe(1);
  });

  it('captures stderr in output', async () => {
    const report = await runGoalQualityGates(['pnpm test'], {
      spawnFn: alwaysFailFn('3 tests failed'),
      cwd: '/fake',
    });
    expect(report.results[0]!.output).toContain('3 tests failed');
  });
});

// ── runGoalQualityGates — multiple commands ───────────────────────────────────

describe('runGoalQualityGates — multiple commands', () => {
  it('runs all commands and reports each result', async () => {
    const spawnFn = perCommandFn({
      'pnpm test': { status: 0, stdout: 'ok' },
      'pnpm lint': { status: 0, stdout: 'lint ok' },
    });
    const report = await runGoalQualityGates(['pnpm test', 'pnpm lint'], {
      spawnFn,
      cwd: '/fake',
    });
    expect(report.passed).toBe(true);
    expect(report.results).toHaveLength(2);
    expect(report.results[0]!.command).toBe('pnpm test');
    expect(report.results[1]!.command).toBe('pnpm lint');
  });

  it('returns passed=false if any command fails', async () => {
    const spawnFn = perCommandFn({
      'pnpm test': { status: 0, stdout: 'ok' },
      'pnpm lint': { status: 1, stderr: 'lint error' },
    });
    const report = await runGoalQualityGates(['pnpm test', 'pnpm lint'], {
      spawnFn,
      cwd: '/fake',
    });
    expect(report.passed).toBe(false);
    expect(report.results[0]!.status).toBe('passed');
    expect(report.results[1]!.status).toBe('failed');
  });

  it('continues running subsequent commands even after a failure', async () => {
    const spawnFn = perCommandFn({
      'pnpm test': { status: 1, stderr: 'fail' },
      'pnpm lint': { status: 0, stdout: 'lint ok' },
    });
    const report = await runGoalQualityGates(['pnpm test', 'pnpm lint'], {
      spawnFn,
      cwd: '/fake',
    });
    expect(report.results).toHaveLength(2);
    expect(report.results[1]!.status).toBe('passed');
  });
});

// ── runGoalQualityGates — timeout ─────────────────────────────────────────────

describe('runGoalQualityGates — timeout', () => {
  it('records failed status with null exitCode on ETIMEDOUT', async () => {
    const report = await runGoalQualityGates(['pnpm test'], {
      spawnFn: timeoutFn(),
      cwd: '/fake',
      timeoutMs: 100,
    });
    expect(report.passed).toBe(false);
    expect(report.results[0]!.status).toBe('failed');
    expect(report.results[0]!.exitCode).toBeNull();
    expect(report.results[0]!.output).toContain('timed out');
  });
});

// ── runGoalQualityGates — output truncation ───────────────────────────────────

describe('runGoalQualityGates — output truncation', () => {
  it('truncates combined output exceeding MAX_OUTPUT_BYTES', async () => {
    const bigOutput = 'x'.repeat(MAX_OUTPUT_BYTES + 100);
    const spawnFn: SpawnFn = () => ({ status: 0, stdout: bigOutput, stderr: '' });
    const report = await runGoalQualityGates(['pnpm test'], { spawnFn, cwd: '/fake' });
    expect(report.results[0]!.output).toContain('truncated');
    expect(report.results[0]!.output.length).toBeLessThan(MAX_OUTPUT_BYTES + 200);
  });

  it('does not truncate output within MAX_OUTPUT_BYTES', async () => {
    const smallOutput = 'all good';
    const spawnFn: SpawnFn = () => ({ status: 0, stdout: smallOutput, stderr: '' });
    const report = await runGoalQualityGates(['pnpm test'], { spawnFn, cwd: '/fake' });
    expect(report.results[0]!.output).toBe(smallOutput);
  });
});

// ── runGoalQualityGates — commitSha ───────────────────────────────────────────

describe('runGoalQualityGates — commitSha', () => {
  it('populates commitSha when git rev-parse succeeds', async () => {
    const fakeSha = 'abc1234def5678901234567890123456789012345';
    let callCount = 0;
    // Contract: first call is git rev-parse HEAD; subsequent calls are the checks.
    const spawnFn: SpawnFn = (_command) => {
      callCount++;
      if (callCount === 1) {
        // git rev-parse HEAD
        return { status: 0, stdout: fakeSha + '\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const report = await runGoalQualityGates(['pnpm test'], { spawnFn, cwd: '/fake' });
    expect(report.commitSha).toBe(fakeSha);
  });

  it('sets commitSha to null when git fails', async () => {
    const spawnFn: SpawnFn = () => ({ status: 128, stdout: '', stderr: 'not a git repo' });
    const report = await runGoalQualityGates(['pnpm test'], { spawnFn, cwd: '/fake' });
    expect(report.commitSha).toBeNull();
  });
});

// ── runGoalQualityGates — spawn throws ───────────────────────────────────────

describe('runGoalQualityGates — spawn throws', () => {
  it('records failed result when spawnFn throws', async () => {
    const spawnFn: SpawnFn = () => {
      throw new Error('spawn failed: ENOENT');
    };
    const report = await runGoalQualityGates(['pnpm test'], { spawnFn, cwd: '/fake' });
    expect(report.passed).toBe(false);
    expect(report.results[0]!.status).toBe('failed');
    expect(report.results[0]!.exitCode).toBeNull();
    expect(report.results[0]!.output).toContain('spawn failed');
  });
});
