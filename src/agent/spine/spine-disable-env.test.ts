/**
 * Tests for #3893 fixes:
 *   1. assertCredentialPresent skips for non-Anthropic models
 *   2. runArm injects AFK_DISABLE_SPINE_UPDATE=1 on both arms
 *
 * @module src/agent/spine/spine-disable-env.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ArmOptions, SpawnFn, FsWriteFn, ClockFn } from '../../../scripts/workspace-ab/run-arm.js';
import { runArm } from '../../../scripts/workspace-ab/run-arm.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeNoopFs(): FsWriteFn {
  return {
    mkdirSync: () => {},
    writeFileSync: () => {},
  };
}

function makeClock(ms = 1000): ClockFn {
  let t = ms;
  return { now: () => (t += 10) };
}

/** Captures the env passed to the spawned child process. */
function makeCaptureSpawn(): {
  capturedEnvs: NodeJS.ProcessEnv[];
  spawnFn: SpawnFn;
} {
  const capturedEnvs: NodeJS.ProcessEnv[] = [];
  const spawnFn: SpawnFn = (_cmd, _args, options) => {
    capturedEnvs.push({ ...(options.env ?? {}) });
    // Return a minimal fake child that exits 0 immediately.
    const stdout = { on: (_e: string, _cb: (chunk: Buffer) => void) => {} };
    const stderr = { on: (_e: string, _cb: (chunk: Buffer) => void) => {} };
    let closeHandler: ((code: number | null) => void) | null = null;
    setImmediate(() => closeHandler?.(0));
    return {
      stdout: stdout as unknown as NodeJS.ReadableStream,
      stderr: stderr as unknown as NodeJS.ReadableStream,
      on: (_event: 'close', cb: (code: number | null) => void) => {
        closeHandler = cb;
      },
    };
  };
  return { capturedEnvs, spawnFn };
}

const BASE_OPTS: Omit<ArmOptions, 'arm'> = {
  afkBin: '/fake/dist/cli/index.js',
  model: 'sonnet',
  maxTurns: 5,
  maxBudgetUsd: 1,
  prompt: 'hello',
  outputDir: '/tmp/ab-test-output',
  trialIndex: 0,
  trialOrder: 'control-first',
};

// ─── Fix 2: AFK_DISABLE_SPINE_UPDATE injected on both arms ────────────────────

describe('runArm — AFK_DISABLE_SPINE_UPDATE (fix #3893)', () => {
  beforeEach(() => {
    delete process.env['AFK_DISABLE_SPINE_UPDATE'];
  });
  afterEach(() => {
    delete process.env['AFK_DISABLE_SPINE_UPDATE'];
  });

  it('sets AFK_DISABLE_SPINE_UPDATE=1 for the control arm', async () => {
    const { capturedEnvs, spawnFn } = makeCaptureSpawn();
    await runArm(
      { ...BASE_OPTS, arm: 'control' },
      { spawnFn, fs: makeNoopFs(), clock: makeClock() },
    );
    expect(capturedEnvs).toHaveLength(1);
    expect(capturedEnvs[0]!['AFK_DISABLE_SPINE_UPDATE']).toBe('1');
  });

  it('sets AFK_DISABLE_SPINE_UPDATE=1 for the treatment arm', async () => {
    const { capturedEnvs, spawnFn } = makeCaptureSpawn();
    await runArm(
      { ...BASE_OPTS, arm: 'treatment' },
      { spawnFn, fs: makeNoopFs(), clock: makeClock() },
    );
    expect(capturedEnvs).toHaveLength(1);
    expect(capturedEnvs[0]!['AFK_DISABLE_SPINE_UPDATE']).toBe('1');
  });

  it('does not forward a pre-existing AFK_DISABLE_SPINE_UPDATE=0 from the parent', async () => {
    process.env['AFK_DISABLE_SPINE_UPDATE'] = '0';
    const { capturedEnvs, spawnFn } = makeCaptureSpawn();
    await runArm(
      { ...BASE_OPTS, arm: 'treatment' },
      { spawnFn, fs: makeNoopFs(), clock: makeClock() },
    );
    // The child must see '1', not the parent's '0'.
    expect(capturedEnvs[0]!['AFK_DISABLE_SPINE_UPDATE']).toBe('1');
  });

  it('control arm still sets AFK_WORKSPACE_DISABLED=1', async () => {
    const { capturedEnvs, spawnFn } = makeCaptureSpawn();
    await runArm(
      { ...BASE_OPTS, arm: 'control' },
      { spawnFn, fs: makeNoopFs(), clock: makeClock() },
    );
    expect(capturedEnvs[0]!['AFK_WORKSPACE_DISABLED']).toBe('1');
  });

  it('treatment arm does not set AFK_WORKSPACE_DISABLED', async () => {
    // Ensure not inherited from parent either.
    delete process.env['AFK_WORKSPACE_DISABLED'];
    const { capturedEnvs, spawnFn } = makeCaptureSpawn();
    await runArm(
      { ...BASE_OPTS, arm: 'treatment' },
      { spawnFn, fs: makeNoopFs(), clock: makeClock() },
    );
    expect(capturedEnvs[0]!['AFK_WORKSPACE_DISABLED']).toBeUndefined();
  });
});

// ─── Fix 1: providerForModel-gated credential check ───────────────────────────
// We test providerForModel's routing directly (it's the imported unit under test).

describe('providerForModel routing for credential-gate (fix #3893)', () => {
  it('routes "local" to anthropic-direct (local- prefix)', async () => {
    const { providerForModel } = await import('../providers/index.js');
    // 'local' alone doesn't start with 'local-'; check 'local-llm' which does
    expect(providerForModel('local-llm', {})).toBe('anthropic-direct');
  });

  it('routes "gpt-4o" to openai-compatible', async () => {
    const { providerForModel } = await import('../providers/index.js');
    expect(providerForModel('gpt-4o', {})).toBe('openai-compatible');
  });

  it('routes "sonnet" to anthropic-direct under default bindings', async () => {
    const { providerForModel } = await import('../providers/index.js');
    // sonnet is in CLAUDE_SHORT_ALIASES (MODEL_MAP keys)
    expect(providerForModel('sonnet', {})).toBe('anthropic-direct');
  });

  it('routes "grok-3" to xai', async () => {
    const { providerForModel } = await import('../providers/index.js');
    expect(providerForModel('grok-3', {})).toBe('xai');
  });
});
