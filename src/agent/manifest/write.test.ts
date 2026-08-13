/**
 * Unit tests for wave manifest write helpers.
 *
 * Tests operate on a temporary waves directory injected via AFK_STATE_DIR,
 * so nothing can touch the real ~/.afk/state/waves.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computePromptDigest,
  buildWaveUnit,
  createManifest,
  readManifest,
  updateWaveUnit,
  writeManifestSync,
} from './write.js';
import type { WaveManifest } from './types.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'afk-manifest-write-'));
  process.env['AFK_STATE_DIR'] = stateDir;
  process.env['AFK_WAVE_MANIFEST_DISABLED'] = undefined as unknown as string;
  delete process.env['AFK_WAVE_MANIFEST_DISABLED'];
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env['AFK_STATE_DIR'];
  delete process.env['AFK_WAVE_MANIFEST_DISABLED'];
  delete process.env['AFK_WAVE_MANIFEST_TTL_HOURS'];
});

describe('computePromptDigest', () => {
  it('produces a sha256 hex string', () => {
    const d = computePromptDigest('hello world');
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('truncates head to 512 chars', () => {
    const long = 'x'.repeat(1000);
    const d = computePromptDigest(long);
    expect(d.head).toHaveLength(512);
    expect(d.byteLen).toBe(1000);
  });

  it('records byteLen correctly for multi-byte chars', () => {
    const emoji = '🎉'.repeat(10); // 4 bytes each
    const d = computePromptDigest(emoji);
    expect(d.byteLen).toBe(40);
  });
});

describe('buildWaveUnit', () => {
  it('creates a pending unit with no worktreePath for non-worktree cwd', () => {
    const unit = buildWaveUnit({ id: 'u1', prompt: 'test', cwd: '/home/user/project', model: 'sonnet' });
    expect(unit.id).toBe('u1');
    expect(unit.status).toBe('pending');
    expect(unit.worktreePath).toBeUndefined();
    expect(unit.upstreamIds).toEqual([]);
  });

  it('extracts worktreePath for a worktree cwd', () => {
    const unit = buildWaveUnit({
      id: 'u2',
      prompt: 'test',
      cwd: '/repo/.afk-worktrees/my-branch/src',
      model: 'haiku',
    });
    expect(unit.worktreePath).toBe('/repo/.afk-worktrees/my-branch');
  });

  it('passes through upstreamIds', () => {
    const unit = buildWaveUnit({
      id: 'u3',
      prompt: 'test',
      cwd: undefined,
      model: 'sonnet',
      upstreamIds: ['a', 'b'],
    });
    expect(unit.upstreamIds).toEqual(['a', 'b']);
  });
});

describe('createManifest + readManifest', () => {
  it('writes a valid manifest and round-trips correctly', () => {
    const units = [
      buildWaveUnit({ id: 'call-1', prompt: 'task one', cwd: '/project', model: 'sonnet' }),
      buildWaveUnit({ id: 'call-2', prompt: 'task two', cwd: '/project', model: 'sonnet' }),
    ];
    const waveId = createManifest({
      source: 'agent-tool',
      parentSessionId: 'sess-123',
      traceLabel: 'my-label',
      units,
    });
    expect(waveId).toBeDefined();
    expect(typeof waveId).toBe('string');

    const manifest = readManifest(waveId!);
    expect(manifest).toBeDefined();
    expect(manifest!.version).toBe(1);
    expect(manifest!.source).toBe('agent-tool');
    expect(manifest!.parentSessionId).toBe('sess-123');
    expect(manifest!.traceLabel).toBe('my-label');
    expect(manifest!.units).toHaveLength(2);
    expect(manifest!.units[0]!.status).toBe('pending');
    expect(manifest!.units[1]!.status).toBe('pending');
  });

  it('returns undefined when disabled', () => {
    process.env['AFK_WAVE_MANIFEST_DISABLED'] = '1';
    const waveId = createManifest({
      source: 'compose-dag',
      parentSessionId: 'sess',
      traceLabel: null,
      units: [buildWaveUnit({ id: 'u1', prompt: 'x', cwd: undefined, model: 'sonnet' })],
    });
    expect(waveId).toBeUndefined();
  });

  it('returns undefined for missing waveId', () => {
    expect(readManifest('nonexistent-wave-id')).toBeUndefined();
  });
});

describe('updateWaveUnit', () => {
  function makeManifest(): WaveManifest {
    const units = [
      buildWaveUnit({ id: 'u1', prompt: 'foo', cwd: undefined, model: 'sonnet' }),
      buildWaveUnit({ id: 'u2', prompt: 'bar', cwd: undefined, model: 'haiku' }),
    ];
    const waveId = createManifest({
      source: 'agent-tool',
      parentSessionId: 'sess',
      traceLabel: null,
      units,
    });
    return readManifest(waveId!)!;
  }

  it('transitions pending → running → done', () => {
    const manifest = makeManifest();
    const waveId = manifest.waveId;

    updateWaveUnit(waveId, 'u1', 'running');
    const afterRunning = readManifest(waveId)!;
    const u1Running = afterRunning.units.find((u) => u.id === 'u1')!;
    expect(u1Running.status).toBe('running');
    expect(u1Running.startedAt).toBeDefined();
    expect(u1Running.settledAt).toBeUndefined();

    updateWaveUnit(waveId, 'u1', 'done');
    const afterDone = readManifest(waveId)!;
    const u1Done = afterDone.units.find((u) => u.id === 'u1')!;
    expect(u1Done.status).toBe('done');
    expect(u1Done.settledAt).toBeDefined();
  });

  it('records errorMessage on failed', () => {
    const manifest = makeManifest();
    updateWaveUnit(manifest.waveId, 'u2', 'failed', { errorMessage: 'something broke' });
    const after = readManifest(manifest.waveId)!;
    const u2 = after.units.find((u) => u.id === 'u2')!;
    expect(u2.status).toBe('failed');
    expect(u2.errorMessage).toBe('something broke');
    expect(u2.settledAt).toBeDefined();
  });

  it('truncates long errorMessage to 500 chars', () => {
    const manifest = makeManifest();
    const longError = 'e'.repeat(1000);
    updateWaveUnit(manifest.waveId, 'u1', 'failed', { errorMessage: longError });
    const after = readManifest(manifest.waveId)!;
    expect(after.units.find((u) => u.id === 'u1')!.errorMessage).toHaveLength(500);
  });

  it('advances updatedAt on each write', async () => {
    const manifest = makeManifest();
    const before = manifest.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    updateWaveUnit(manifest.waveId, 'u1', 'running');
    const after = readManifest(manifest.waveId)!;
    expect(after.updatedAt >= before).toBe(true);
  });

  it('is a no-op for an unknown waveId', () => {
    // Should not throw
    expect(() => updateWaveUnit('bad-wave-id', 'u1', 'done')).not.toThrow();
  });

  it('is a no-op for an unknown unitId', () => {
    const manifest = makeManifest();
    expect(() => updateWaveUnit(manifest.waveId, 'no-such-unit', 'done')).not.toThrow();
    // Original units unaffected
    const after = readManifest(manifest.waveId)!;
    expect(after.units.every((u) => u.status === 'pending')).toBe(true);
  });
});

describe('writeManifestSync atomicity', () => {
  it('does not leave a temp file on success', () => {
    const units = [
      buildWaveUnit({ id: 'u1', prompt: 'p', cwd: undefined, model: 'sonnet' }),
      buildWaveUnit({ id: 'u2', prompt: 'q', cwd: undefined, model: 'haiku' }),
    ];
    const waveId = createManifest({
      source: 'agent-tool',
      parentSessionId: 'sess',
      traceLabel: null,
      units,
    });
    const wavesDir = join(stateDir, 'waves');
    const tmpFile = join(wavesDir, `.${waveId!}.tmp`);
    expect(existsSync(tmpFile)).toBe(false);
  });
});
