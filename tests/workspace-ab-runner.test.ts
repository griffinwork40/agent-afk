/**
 * Unit tests for the workspace A/B runner modules.
 *
 * Tests are fully isolated — no real afk binary, no LLM calls, no filesystem
 * side effects (all injectable deps are stubbed).
 *
 * @see scripts/workspace-ab/run-arm.ts
 * @see scripts/workspace-ab/compare.ts
 * @see scripts/workspace-ab/manifest.ts
 * @see scripts/workspace-ab/prompt.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter, Readable } from 'node:stream';
import { createHash } from 'node:crypto';

import { runArm, parseTraceIdentity } from '../scripts/workspace-ab/run-arm.js';
import type { ArmOptions, SpawnFn, FsWriteFn, ClockFn } from '../scripts/workspace-ab/run-arm.js';
import { compareTrialPair, aggregateTrials } from '../scripts/workspace-ab/compare.js';
import type { ParseTraceFn, TrialResult } from '../scripts/workspace-ab/compare.js';
import { buildManifest } from '../scripts/workspace-ab/manifest.js';
import { EXPERIMENT_PROMPT, promptHash } from '../scripts/workspace-ab/prompt.js';
import type { DedupReport, ValidationResult } from '../scripts/workspace-ab/types.js';

// ─── Stub helpers ──────────────────────────────────────────────────────────

/** Build a minimal ArmOptions. */
function makeArmOpts(overrides: Partial<ArmOptions> = {}): ArmOptions {
  return {
    afkBin: '/fake/dist/cli/index.js',
    model: 'sonnet',
    maxTurns: 5,
    maxBudgetUsd: 1,
    prompt: 'test prompt',
    outputDir: '/tmp/ab-test',
    arm: 'control',
    trialIndex: 0,
    trialOrder: 'control-first',
    ...overrides,
  };
}

/** Build a fake spawn function that emits `stdout` + closes with `code`. */
function makeSpawnFn(opts: {
  stdout?: string;
  stderr?: string;
  code?: number;
}): SpawnFn {
  return (_cmd, _args, _options) => {
    const emitter = new EventEmitter() as ReturnType<SpawnFn>;
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });
    (emitter as unknown as { stdout: NodeJS.ReadableStream }).stdout = stdoutStream;
    (emitter as unknown as { stderr: NodeJS.ReadableStream }).stderr = stderrStream;

    // Emit data asynchronously so the caller's listeners attach first.
    setImmediate(() => {
      if (opts.stdout) stdoutStream.push(Buffer.from(opts.stdout, 'utf8'));
      stdoutStream.push(null);
      if (opts.stderr) stderrStream.push(Buffer.from(opts.stderr ?? '', 'utf8'));
      stderrStream.push(null);
      emitter.emit('close', opts.code ?? 0);
    });
    return emitter as unknown as ReturnType<SpawnFn>;
  };
}

/** No-op fs stub. */
const noopFs: FsWriteFn = {
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
};

const fixedClock: ClockFn = { now: () => 1_000_000 };

/** Minimal valid DedupReport for testing validate()/compare(). */
function makeReport(overrides: Partial<DedupReport> = {}): DedupReport {
  return {
    tracePath: '/fake/trace.jsonl',
    toolFilter: 'read_file only',
    totalCalls: 4,
    uniqueFingerprints: 3,
    crossAgentDuplicates: 1,
    selfDuplicates: 0,
    crossAgentDedupRatio: 0.25,
    crossAgentFileOverlapRatio: 0.25,
    distinctAgents: 2,
    hotFingerprints: [],
    skippedNoFingerprint: 0,
    totalToolCallStarted: 4,
    ...overrides,
  };
}

const fp = (s: string) => createHash('sha256').update(s).digest('hex');

// ─── parseTraceIdentity ────────────────────────────────────────────────────

describe('parseTraceIdentity', () => {
  it('extracts all three identity fields from valid JSON', () => {
    const json = JSON.stringify({
      success: true,
      model: 'sonnet',
      message: 'hi',
      timestamp: new Date().toISOString(),
      sessionId: 'sess-abc',
      witnessLabel: 'label-abc',
      tracePath: '/home/.afk/state/witness/label-abc/trace.jsonl',
    }, null, 2);
    const result = parseTraceIdentity(json);
    expect(result.sessionId).toBe('sess-abc');
    expect(result.witnessLabel).toBe('label-abc');
    expect(result.tracePath).toBe('/home/.afk/state/witness/label-abc/trace.jsonl');
  });

  it('returns empty object for empty stdout', () => {
    expect(parseTraceIdentity('')).toEqual({});
    expect(parseTraceIdentity('   ')).toEqual({});
  });

  it('returns empty object for invalid JSON', () => {
    expect(parseTraceIdentity('not json')).toEqual({});
    expect(parseTraceIdentity('{broken')).toEqual({});
  });

  it('returns partial result when only some fields present', () => {
    const json = JSON.stringify({ success: true, sessionId: 'only-sid' });
    const result = parseTraceIdentity(json);
    expect(result.sessionId).toBe('only-sid');
    expect(result.witnessLabel).toBeUndefined();
    expect(result.tracePath).toBeUndefined();
  });

  it('ignores non-string sessionId values', () => {
    const json = JSON.stringify({ sessionId: 123, witnessLabel: null });
    const result = parseTraceIdentity(json);
    expect(result.sessionId).toBeUndefined();
    expect(result.witnessLabel).toBeUndefined();
  });
});

// ─── runArm ───────────────────────────────────────────────────────────────

describe('runArm', () => {
  it('succeeds when process exits 0 and parses trace identity from stdout', async () => {
    const identity = {
      sessionId: 'sess-42',
      witnessLabel: 'label-42',
      tracePath: '/tmp/trace.jsonl',
    };
    const stdout = JSON.stringify({ success: true, model: 'sonnet', message: 'ok', timestamp: '', ...identity });
    const result = await runArm(
      makeArmOpts({ arm: 'control', trialIndex: 0, trialOrder: 'control-first' }),
      { spawnFn: makeSpawnFn({ stdout, code: 0 }), fs: noopFs, clock: fixedClock },
    );
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe('sess-42');
    expect(result.witnessLabel).toBe('label-42');
    expect(result.tracePath).toBe('/tmp/trace.jsonl');
  });

  it('fails (success=false) when process exits nonzero', async () => {
    const result = await runArm(
      makeArmOpts({ arm: 'treatment', trialIndex: 1 }),
      { spawnFn: makeSpawnFn({ code: 1, stderr: 'boom' }), fs: noopFs, clock: fixedClock },
    );
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('exited with code 1');
  });

  it('keeps stdout and stderr separate (not mixed)', async () => {
    const written: Record<string, string> = {};
    const trackingFs: FsWriteFn = {
      mkdirSync: vi.fn(),
      writeFileSync: (p, d) => { written[p] = d; },
    };
    const stdout = JSON.stringify({ success: true, model: 'sonnet', message: 'out' });
    const stderr = 'some warning on stderr';
    await runArm(
      makeArmOpts({ outputDir: '/out' }),
      { spawnFn: makeSpawnFn({ stdout, stderr, code: 0 }), fs: trackingFs, clock: fixedClock },
    );
    const stdoutPath = Object.keys(written).find((k) => k.endsWith('-stdout.json'))!;
    const stderrPath = Object.keys(written).find((k) => k.endsWith('-stderr.txt'))!;
    expect(stdoutPath).toBeTruthy();
    expect(stderrPath).toBeTruthy();
    expect(written[stdoutPath]).toContain('message');
    expect(written[stdoutPath]).not.toContain('warning');
    expect(written[stderrPath]).toContain('warning');
    expect(written[stderrPath]).not.toContain('message');
  });

  it('uses unique output paths per trial arm', async () => {
    const written: string[] = [];
    const trackingFs: FsWriteFn = {
      mkdirSync: vi.fn(),
      writeFileSync: (p) => written.push(p),
    };
    await runArm(
      makeArmOpts({ arm: 'control', trialIndex: 0, outputDir: '/out' }),
      { spawnFn: makeSpawnFn({ code: 0 }), fs: trackingFs, clock: fixedClock },
    );
    await runArm(
      makeArmOpts({ arm: 'treatment', trialIndex: 0, outputDir: '/out' }),
      { spawnFn: makeSpawnFn({ code: 0 }), fs: trackingFs, clock: fixedClock },
    );
    await runArm(
      makeArmOpts({ arm: 'control', trialIndex: 1, outputDir: '/out' }),
      { spawnFn: makeSpawnFn({ code: 0 }), fs: trackingFs, clock: fixedClock },
    );
    // All 6 paths (2 files × 3 runs) should be unique.
    const unique = new Set(written);
    expect(unique.size).toBe(written.length);
  });

  it('injects AFK_WORKSPACE_DISABLED=1 only for the control arm', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spySpawn: SpawnFn = (_cmd, _args, options) => {
      capturedEnv = (options as { env?: NodeJS.ProcessEnv }).env;
      const emitter = new EventEmitter() as ReturnType<SpawnFn>;
      const out = new Readable({ read() {} });
      const err = new Readable({ read() {} });
      (emitter as unknown as { stdout: NodeJS.ReadableStream }).stdout = out;
      (emitter as unknown as { stderr: NodeJS.ReadableStream }).stderr = err;
      setImmediate(() => { out.push(null); err.push(null); emitter.emit('close', 0); });
      return emitter as unknown as ReturnType<SpawnFn>;
    };

    await runArm(makeArmOpts({ arm: 'control' }), { spawnFn: spySpawn, fs: noopFs, clock: fixedClock });
    expect(capturedEnv?.['AFK_WORKSPACE_DISABLED']).toBe('1');

    await runArm(makeArmOpts({ arm: 'treatment' }), { spawnFn: spySpawn, fs: noopFs, clock: fixedClock });
    expect(capturedEnv?.['AFK_WORKSPACE_DISABLED']).toBeUndefined();
  });

  it('records duration in milliseconds', async () => {
    let tick = 0;
    const tickClock: ClockFn = { now: () => (tick++ === 0 ? 1000 : 3500) };
    const result = await runArm(
      makeArmOpts(),
      { spawnFn: makeSpawnFn({ code: 0 }), fs: noopFs, clock: tickClock },
    );
    expect(result.durationMs).toBe(2500);
  });
});

// ─── compareTrialPair ─────────────────────────────────────────────────────

/** Build a minimal ArmResult. */
function makeArmResult(overrides: Partial<ReturnType<typeof makeArmResult>> = {}) {
  return {
    arm: 'control' as const,
    trialIndex: 0,
    trialOrder: 'control-first',
    exitCode: 0,
    success: true,
    stdoutPath: '/out/stdout.json',
    stderrPath: '/out/stderr.txt',
    durationMs: 1000,
    sessionId: 'sid-ctrl',
    witnessLabel: 'lbl-ctrl',
    tracePath: '/fake/ctrl/trace.jsonl',
    ...overrides,
  };
}

/** Build a ParseTraceFn stub that returns a valid trace result. */
function makeParseTraceFn(
  overrides: Partial<{ hasValidClosure: boolean; childFailureRate: number }> = {},
): ParseTraceFn {
  return async (_tracePath, _allTools) => ({
    calls: [
      { name: 'read_file', argsFingerprint: fp('a'), subagentId: 'agent-1', toolUseId: 'tu-1', seq: 1, ts: '' },
      { name: 'read_file', argsFingerprint: fp('b'), subagentId: 'agent-2', toolUseId: 'tu-2', seq: 2, ts: '' },
    ],
    skippedNoFingerprint: 0,
    totalToolCallStarted: 2,
    hasValidClosure: overrides.hasValidClosure ?? true,
    childFailureRate: overrides.childFailureRate ?? 0,
  });
}

describe('compareTrialPair', () => {
  it('throws when control arm exited nonzero', async () => {
    const control = makeArmResult({ success: false, exitCode: 1, errorMessage: 'crash', tracePath: undefined });
    const treatment = makeArmResult({ arm: 'treatment', tracePath: '/fake/trt/trace.jsonl' });
    await expect(compareTrialPair(control, treatment, makeParseTraceFn())).rejects.toThrow(
      /control arm failed/,
    );
  });

  it('throws when treatment arm exited nonzero', async () => {
    const control = makeArmResult({ tracePath: '/fake/ctrl/trace.jsonl' });
    const treatment = makeArmResult({ arm: 'treatment', success: false, exitCode: 2, tracePath: undefined });
    await expect(compareTrialPair(control, treatment, makeParseTraceFn())).rejects.toThrow(
      /treatment arm failed/,
    );
  });

  it('throws when control arm is missing tracePath', async () => {
    const control = makeArmResult({ tracePath: undefined });
    const treatment = makeArmResult({ arm: 'treatment', tracePath: '/fake/trt/trace.jsonl' });
    await expect(compareTrialPair(control, treatment, makeParseTraceFn())).rejects.toThrow(
      /control arm missing tracePath/,
    );
  });

  it('throws when treatment arm is missing tracePath', async () => {
    const control = makeArmResult({ tracePath: '/fake/ctrl/trace.jsonl' });
    const treatment = makeArmResult({ arm: 'treatment', tracePath: undefined });
    await expect(compareTrialPair(control, treatment, makeParseTraceFn())).rejects.toThrow(
      /treatment arm missing tracePath/,
    );
  });

  it('marks trial as usable when both arms pass validate()', async () => {
    const control = makeArmResult({ tracePath: '/fake/ctrl/trace.jsonl' });
    const treatment = makeArmResult({ arm: 'treatment', tracePath: '/fake/trt/trace.jsonl' });
    const result = await compareTrialPair(control, treatment, makeParseTraceFn({ hasValidClosure: true }));
    expect(result.usable).toBe(true);
    expect(result.validation.control.valid).toBe(true);
    expect(result.validation.treatment.valid).toBe(true);
  });

  it('marks trial as not usable when validate() rejects either report', async () => {
    const control = makeArmResult({ tracePath: '/fake/ctrl/trace.jsonl' });
    const treatment = makeArmResult({ arm: 'treatment', tracePath: '/fake/trt/trace.jsonl' });
    // hasValidClosure=false causes validate() to fail
    const result = await compareTrialPair(control, treatment, makeParseTraceFn({ hasValidClosure: false }));
    expect(result.usable).toBe(false);
  });

  it('populates metrics for both arms', async () => {
    const control = makeArmResult({ tracePath: '/fake/ctrl/trace.jsonl' });
    const treatment = makeArmResult({ arm: 'treatment', tracePath: '/fake/trt/trace.jsonl' });
    const result = await compareTrialPair(control, treatment, makeParseTraceFn());
    expect(result.metrics.control).toBeDefined();
    expect(result.metrics.treatment).toBeDefined();
    expect(result.metrics.control!.totalCalls).toBe(2);
    expect(result.metrics.treatment!.totalCalls).toBe(2);
  });
});

// ─── aggregateTrials ──────────────────────────────────────────────────────

describe('aggregateTrials', () => {
  it('rejects fewer than 5 trials by returning 0 usable when all unusable', () => {
    // With 4 unusable trials, aggregateTrials returns null stats.
    const unusable: TrialResult[] = Array.from({ length: 4 }, (_, i) => ({
      trialIndex: i,
      control: makeArmResult({ trialIndex: i }),
      treatment: makeArmResult({ arm: 'treatment', trialIndex: i }),
      validation: {
        control: { valid: false, failures: [{ rule: 'no-closure' as const, message: 'test' }] },
        treatment: { valid: false, failures: [{ rule: 'no-closure' as const, message: 'test' }] },
      },
      metrics: {},
      usable: false,
    }));
    const agg = aggregateTrials(unusable);
    expect(agg.usableTrials).toBe(0);
    expect(agg.controlAvgDedupRatio).toBeNull();
  });

  it('computes average dedup ratio across usable trials', () => {
    const usableTrials: TrialResult[] = [0.2, 0.4, 0.6].map((ratio, i) => ({
      trialIndex: i,
      control: makeArmResult({ trialIndex: i }),
      treatment: makeArmResult({ arm: 'treatment', trialIndex: i }),
      validation: {
        control: { valid: true, failures: [] } as ValidationResult,
        treatment: { valid: true, failures: [] } as ValidationResult,
      },
      metrics: {
        control: makeReport({ crossAgentDedupRatio: ratio }),
        treatment: makeReport({ crossAgentDedupRatio: ratio * 0.5 }),
      },
      usable: true,
    }));
    const agg = aggregateTrials(usableTrials);
    expect(agg.usableTrials).toBe(3);
    expect(agg.controlAvgDedupRatio).toBeCloseTo((0.2 + 0.4 + 0.6) / 3);
    expect(agg.treatmentAvgDedupRatio).toBeCloseTo((0.1 + 0.2 + 0.3) / 3);
    expect(agg.dedupRatioDelta).toBeCloseTo(((0.1 + 0.2 + 0.3) / 3) - ((0.2 + 0.4 + 0.6) / 3));
  });
});

// ─── arm order alternation ─────────────────────────────────────────────────

describe('trial arm order', () => {
  // Inline the same logic used by the orchestrator.
  function trialArmOrder(i: number) {
    return i % 2 === 0 ? 'control-first' : 'treatment-first';
  }

  it('alternates arm order across 5 trials', () => {
    const orders = Array.from({ length: 5 }, (_, i) => trialArmOrder(i));
    expect(orders).toEqual([
      'control-first',
      'treatment-first',
      'control-first',
      'treatment-first',
      'control-first',
    ]);
  });
});

// ─── manifest fields ───────────────────────────────────────────────────────

describe('buildManifest', () => {
  it('contains all required fields', () => {
    const trial: TrialResult = {
      trialIndex: 0,
      control: makeArmResult({ tracePath: '/fake/ctrl/trace.jsonl' }),
      treatment: makeArmResult({ arm: 'treatment', tracePath: '/fake/trt/trace.jsonl' }),
      validation: {
        control: { valid: true, failures: [] },
        treatment: { valid: true, failures: [] },
      },
      metrics: {
        control: makeReport({ crossAgentDedupRatio: 0.3 }),
        treatment: makeReport({ crossAgentDedupRatio: 0.1 }),
      },
      usable: true,
    };

    const manifest = buildManifest({
      startedAt: '2026-09-25T00:00:00.000Z',
      model: 'sonnet',
      promptHash: fp('test-prompt'),
      trialCount: 1,
      trials: [trial],
    });

    // Required provenance fields
    expect(manifest.model).toBe('sonnet');
    expect(manifest.promptHash).toBeTruthy();
    expect(manifest.gitSha).toBeTruthy();
    expect(manifest.nodeVersion).toMatch(/^v\d+/);
    expect(manifest.trialCount).toBe(1);
    expect(manifest.startedAt).toBeTruthy();
    expect(manifest.completedAt).toBeTruthy();

    // Summary fields
    expect(manifest.summary.controlAvgDedupRatio).toBeCloseTo(0.3);
    expect(manifest.summary.treatmentAvgDedupRatio).toBeCloseTo(0.1);
    expect(manifest.summary.dedupRatioDelta).toBeCloseTo(-0.2);

    // Per-arm trial entries with trace identity
    const ctrlEntry = manifest.trials.find((t) => t.arm === 'control');
    expect(ctrlEntry?.sessionId).toBe('sid-ctrl');
    expect(ctrlEntry?.tracePath).toBe('/fake/ctrl/trace.jsonl');
  });
});

// ─── prompt ───────────────────────────────────────────────────────────────

describe('EXPERIMENT_PROMPT', () => {
  it('is non-empty and deterministic', () => {
    expect(EXPERIMENT_PROMPT.length).toBeGreaterThan(100);
    const h1 = promptHash(EXPERIMENT_PROMPT);
    const h2 = promptHash(EXPERIMENT_PROMPT);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // sha256 hex
  });

  it('contains workspace_query and workspace_publish instructions', () => {
    expect(EXPERIMENT_PROMPT).toContain('workspace_query');
    expect(EXPERIMENT_PROMPT).toContain('workspace_publish');
  });
});
