/** Deterministic storage checks only: fixtures are NOT experiment observations. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { getWorkspaceExperimentDir } from '../src/paths.js';
import { buildManifest, writeManifest } from '../scripts/workspace-ab/manifest.js';
import type { TrialResult } from '../scripts/workspace-ab/compare.js';

const scratch: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-ab-storage-'));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function failedTrial(): TrialResult {
  const arm = (name: 'control' | 'treatment') => ({
    arm: name, trialIndex: 0, trialOrder: 'control-first', exitCode: 1,
    success: false, durationMs: 0, stdoutPath: 'stdout.json', stderrPath: 'stderr.txt',
  });
  const invalid = { valid: false, failures: [{ rule: 'no-closure' as const, message: 'fixture failure' }] };
  return {
    trialIndex: 0, control: arm('control'), treatment: arm('treatment'),
    validation: { control: invalid, treatment: invalid }, metrics: {}, usable: false,
  };
}

describe('workspace experiment storage', () => {
  it('honors AFK_HOME and AFK_STATE_DIR and has no mkdir side effect', () => {
    const home = tempDir();
    vi.stubEnv('AFK_HOME', home);
    vi.stubEnv('AFK_STATE_DIR', '');
    expect(getWorkspaceExperimentDir('run-1')).toBe(join(home, 'state', 'experiments', 'workspace-ab', 'run-1'));
    const state = tempDir();
    vi.stubEnv('AFK_STATE_DIR', state);
    expect(getWorkspaceExperimentDir('run-2')).toBe(join(state, 'experiments', 'workspace-ab', 'run-2'));
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(state)).toEqual([]);
  });

  it.each(['', '.', '..', '../escape', '/absolute', 'a/b', 'a\\b', 'a.b', 'x'.repeat(161)])(
    'rejects unsafe run id %j', (id) => expect(() => getWorkspaceExperimentDir(id)).toThrow('Invalid workspace experiment run id'),
  );

  it('writes the specified layout, retains failure records and full source SHA', () => {
    const dir = tempDir();
    const manifest = buildManifest({ startedAt: '2026-10-29T00:00:00Z', model: 'fixture', promptHash: 'fixture', trialCount: 1, trials: [failedTrial()] });
    expect(manifest.gitSha).toBe(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    const result = writeManifest(manifest, dir);
    expect(result).toEqual({ manifestPath: join(dir, 'manifest.json'), markdownPath: join(dir, 'report.md') });
    expect(readdirSync(dir).sort()).toEqual(['comparison.json', 'control', 'manifest.json', 'report.md', 'treatment']);
    expect(JSON.parse(readFileSync(result.manifestPath, 'utf8'))).toEqual(manifest);
    for (const arm of ['control', 'treatment']) {
      const record = JSON.parse(readFileSync(join(dir, arm, 'trial-0.json'), 'utf8'));
      expect(record.arm).toBe(arm);
      expect(record.validationPassed).toBe(false);
      expect(record.validationFailures).toEqual(['fixture failure']);
      expect(record.dedupMetrics).toBeUndefined();
    }
    const comparison = JSON.parse(readFileSync(join(dir, 'comparison.json'), 'utf8'));
    expect(comparison.summary.validTrials).toBe(0);
    expect(comparison.summary.dedupRatioDelta).toBeNull();
    expect(readFileSync(result.markdownPath, 'utf8')).toContain('(0 valid)');
    expect(() => writeManifest(manifest, dir)).toThrow('Refusing to replace existing experiment manifest');
    expect(JSON.parse(readFileSync(result.manifestPath, 'utf8'))).toEqual(manifest);
  });

  it('fails closed when zero-exit arms produce invalid traces (no model calls)', () => {
    const dir = tempDir();
    const trace = join(dir, 'empty-trace.jsonl');
    writeFileSync(trace, '');
    const binary = join(dir, 'fixture.cjs');
    writeFileSync(binary, `console.log(JSON.stringify({tracePath: ${JSON.stringify(trace)}, sessionId: 'fixture'}));`);
    const outputDir = join(dir, 'results');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-workspace-ab-test.ts',
      '--model', 'gpt-fixture', '--trials', '5', '--afk-bin', binary, '--output-dir', outputDir],
    { encoding: 'utf8', timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('only 0 of 5 trials are valid');
    const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8'));
    expect(manifest.trials).toHaveLength(10);
    expect(manifest.summary.validTrials).toBe(0);
    const retained = readFileSync(join(outputDir, 'manifest.json'), 'utf8');
    const repeated = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-workspace-ab-test.ts',
      '--model', 'gpt-fixture', '--trials', '5', '--afk-bin', binary, '--output-dir', outputDir],
    { encoding: 'utf8', timeout: 30_000 });
    expect(repeated.status).toBe(1);
    expect(repeated.stderr).toContain('EEXIST');
    expect(readFileSync(join(outputDir, 'manifest.json'), 'utf8')).toBe(retained);
  }, 35_000);
});
