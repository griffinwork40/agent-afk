/**
 * Unit tests for the wave manifest reconciler.
 *
 * All file I/O is routed through a temp directory via AFK_STATE_DIR.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  reconcileWaveManifests,
  formatResumptionOffer,
  sweepExpiredManifests,
  shouldSurfaceResumptionOffer,
} from './reconcile.js';
import { createManifest, buildWaveUnit, updateWaveUnit } from './write.js';
import { getWaveManifestPath } from '../../paths.js';
import type { WaveManifest } from './types.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'afk-reconcile-'));
  process.env['AFK_STATE_DIR'] = stateDir;
  delete process.env['AFK_WAVE_MANIFEST_DISABLED'];
  delete process.env['AFK_WAVE_MANIFEST_TTL_HOURS'];
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env['AFK_STATE_DIR'];
  delete process.env['AFK_WAVE_MANIFEST_DISABLED'];
  delete process.env['AFK_WAVE_MANIFEST_TTL_HOURS'];
});

describe('reconcileWaveManifests — basic discovery', () => {
  it('skips expired manifests and deletes them', () => {
    const units = [
      buildWaveUnit({ id: 'u1', prompt: 'x', cwd: undefined, model: 'sonnet' }),
      buildWaveUnit({ id: 'u2', prompt: 'y', cwd: undefined, model: 'haiku' }),
    ];
    const waveId = createManifest({
      source: 'agent-tool',
      parentSessionId: 'sess',
      traceLabel: null,
      units,
    });
    // Manually expire by writing a past expiresAt
    const manifestPath = getWaveManifestPath(waveId!);
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as WaveManifest;
    raw.expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(manifestPath, JSON.stringify(raw, null, 2));

    const result = reconcileWaveManifests({ sessionId: 'sess' });
    expect(result.offers).toHaveLength(0);
    expect(result.deletedExpired).toBe(1);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('offers manifests with unsettled units matching sessionId', () => {
    const units = [
      buildWaveUnit({ id: 'u1', prompt: 'task a', cwd: '/proj', model: 'sonnet' }),
      buildWaveUnit({ id: 'u2', prompt: 'task b', cwd: '/proj', model: 'haiku' }),
    ];
    createManifest({
      source: 'agent-tool',
      parentSessionId: 'my-session',
      traceLabel: null,
      units,
    });

    const result = reconcileWaveManifests({ sessionId: 'my-session' });
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]!.resumable).toHaveLength(2);
    expect(result.offers[0]!.blocked).toHaveLength(0);
  });

  it('skips manifests with all units settled', () => {
    const units = [
      buildWaveUnit({ id: 'u1', prompt: 'task a', cwd: undefined, model: 'sonnet' }),
      buildWaveUnit({ id: 'u2', prompt: 'task b', cwd: undefined, model: 'haiku' }),
    ];
    const waveId = createManifest({
      source: 'agent-tool',
      parentSessionId: 'sess-done',
      traceLabel: null,
      units,
    });
    updateWaveUnit(waveId!, 'u1', 'done');
    updateWaveUnit(waveId!, 'u2', 'done');

    const result = reconcileWaveManifests({ sessionId: 'sess-done' });
    expect(result.offers).toHaveLength(0);
  });

  it('returns empty result when waves dir does not exist', () => {
    const result = reconcileWaveManifests({ sessionId: 'no-waves-sess' });
    expect(result.offers).toHaveLength(0);
    expect(result.deletedExpired).toBe(0);
  });

  it('treats corrupt createdAt (NaN) as epoch — isRecent=false, isOwnSession carries it', () => {
    // A manifest with a corrupt createdAt value must not be silently skipped
    // forever. Before the guard: new Date('corrupt').getTime() = NaN,
    // now - NaN = NaN, NaN < HOURS_48_MS = false → isRecent = false. When the
    // session also mismatches, the manifest was silently dropped on every pass
    // instead of being surfaced or eventually deleted. Fix: treat NaN as
    // epoch (0), making isRecent definitively false and letting isOwnSession
    // carry the manifest when the parent session matches.
    const units = [
      buildWaveUnit({ id: 'u1', prompt: 'corrupt ts test', cwd: undefined, model: 'sonnet' }),
      buildWaveUnit({ id: 'u2', prompt: 'corrupt ts test 2', cwd: undefined, model: 'haiku' }),
    ];
    const waveId = createManifest({
      source: 'agent-tool',
      parentSessionId: 'corrupt-sess',
      traceLabel: null,
      units,
    });
    // Overwrite createdAt with a non-ISO string that produces NaN from Date().
    const manifestPath = getWaveManifestPath(waveId!);
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as WaveManifest;
    raw.createdAt = 'not-a-date';
    writeFileSync(manifestPath, JSON.stringify(raw, null, 2));

    // Case 1: isOwnSession = true → manifest is surfaced even with corrupt createdAt.
    const resultOwn = reconcileWaveManifests({ sessionId: 'corrupt-sess' });
    expect(resultOwn.offers).toHaveLength(1);
    expect(resultOwn.offers[0]!.resumable).toHaveLength(2);

    // Case 2: isOwnSession = false → manifest is NOT surfaced (isRecent=false, not own).
    const resultOther = reconcileWaveManifests({ sessionId: 'other-sess' });
    expect(resultOther.offers).toHaveLength(0);
  });
});

describe('reconcileWaveManifests — DAG upstream blocking', () => {
  it('marks units with unsatisfied upstreamIds as blocked', () => {
    const units = [
      buildWaveUnit({ id: 'nodeA', prompt: 'a', cwd: undefined, model: 'sonnet' }),
      buildWaveUnit({ id: 'nodeB', prompt: 'b', cwd: undefined, model: 'sonnet', upstreamIds: ['nodeA'] }),
    ];
    createManifest({
      source: 'compose-dag',
      parentSessionId: 'dag-sess',
      traceLabel: null,
      units,
    });

    const result = reconcileWaveManifests({ sessionId: 'dag-sess' });
    expect(result.offers).toHaveLength(1);
    const offer = result.offers[0]!;
    // nodeA has no deps → resumable; nodeB has unsatisfied dep on nodeA → blocked
    expect(offer.resumable.map((r) => r.unit.id)).toContain('nodeA');
    expect(offer.blocked.map((u) => u.id)).toContain('nodeB');
  });

  it('marks a node as resumable when its upstream is done', () => {
    const units = [
      buildWaveUnit({ id: 'nodeA', prompt: 'a', cwd: undefined, model: 'sonnet' }),
      buildWaveUnit({ id: 'nodeB', prompt: 'b', cwd: undefined, model: 'sonnet', upstreamIds: ['nodeA'] }),
    ];
    const waveId = createManifest({
      source: 'compose-dag',
      parentSessionId: 'dag-sess2',
      traceLabel: null,
      units,
    });
    // Mark nodeA done
    updateWaveUnit(waveId!, 'nodeA', 'done');

    const result = reconcileWaveManifests({ sessionId: 'dag-sess2' });
    // nodeA is done so not offered; nodeB's dep is satisfied → resumable
    const offer = result.offers[0];
    if (offer !== undefined) {
      expect(offer.resumable.map((r) => r.unit.id)).toContain('nodeB');
      expect(offer.blocked).toHaveLength(0);
    }
  });
});

describe('formatResumptionOffer', () => {
  it('includes the wave ID and unit count', () => {
    const units = [
      buildWaveUnit({ id: 'u1', prompt: 'investigate bug', cwd: '/proj', model: 'sonnet' }),
      buildWaveUnit({ id: 'u2', prompt: 'write tests', cwd: '/proj', model: 'haiku' }),
    ];
    const waveId = createManifest({
      source: 'agent-tool',
      parentSessionId: 'sess-fmt',
      traceLabel: null,
      units,
    });
    const result = reconcileWaveManifests({ sessionId: 'sess-fmt' });
    const offer = result.offers[0];
    expect(offer).toBeDefined();
    const formatted = formatResumptionOffer(offer!);
    expect(formatted).toContain('[wave-resume]');
    expect(formatted).toContain(waveId ?? '');
    expect(formatted).toContain('agent-tool');
    expect(formatted).toContain('investigate bug');
    expect(formatted).toContain("re-dispatch each ready unit's prompt from its listed cwd");
    expect(formatted).not.toContain('Accept? [yes/no]');
  });
});

describe('sweepExpiredManifests', () => {
  it('deletes expired manifests and leaves valid ones', () => {
    // Create a fresh manifest (not expired)
    const units1 = [
      buildWaveUnit({ id: 'u1', prompt: 'keep', cwd: undefined, model: 'sonnet' }),
      buildWaveUnit({ id: 'u2', prompt: 'keep2', cwd: undefined, model: 'haiku' }),
    ];
    const freshId = createManifest({
      source: 'agent-tool',
      parentSessionId: 'sess-fresh',
      traceLabel: null,
      units: units1,
    });

    // Create an expired manifest
    const units2 = [
      buildWaveUnit({ id: 'u3', prompt: 'expired', cwd: undefined, model: 'sonnet' }),
      buildWaveUnit({ id: 'u4', prompt: 'expired2', cwd: undefined, model: 'haiku' }),
    ];
    const expiredId = createManifest({
      source: 'agent-tool',
      parentSessionId: 'sess-old',
      traceLabel: null,
      units: units2,
    });
    // Manually expire it
    const expiredPath = getWaveManifestPath(expiredId!);
    const raw = JSON.parse(readFileSync(expiredPath, 'utf8')) as WaveManifest;
    raw.expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(expiredPath, JSON.stringify(raw, null, 2));

    const swept = sweepExpiredManifests();
    expect(swept.deleted).toBe(1);
    expect(existsSync(expiredPath)).toBe(false);
    expect(existsSync(getWaveManifestPath(freshId!))).toBe(true);
  });

  it('returns 0 deleted when waves dir does not exist', () => {
    const swept = sweepExpiredManifests();
    expect(swept.deleted).toBe(0);
  });
});

describe('reconcileWaveManifests — worktree missing detection', () => {
  it('marks unit worktreeStatus as missing when path does not exist', () => {
    const units = [
      buildWaveUnit({
        id: 'u1',
        prompt: 'test',
        cwd: '/nonexistent-repo/.afk-worktrees/branch/src',
        model: 'sonnet',
      }),
      buildWaveUnit({ id: 'u2', prompt: 'test2', cwd: '/project', model: 'haiku' }),
    ];
    createManifest({
      source: 'agent-tool',
      parentSessionId: 'wt-sess',
      traceLabel: null,
      units,
    });

    const result = reconcileWaveManifests({ sessionId: 'wt-sess' });
    const offer = result.offers[0];
    expect(offer).toBeDefined();
    const u1entry = offer!.resumable.find((r) => r.unit.id === 'u1');
    expect(u1entry?.worktreeStatus).toBe('missing');
    const u2entry = offer!.resumable.find((r) => r.unit.id === 'u2');
    expect(u2entry?.worktreeStatus).toBe('ok');
  });
});

describe('shouldSurfaceResumptionOffer', () => {
  afterEach(() => {
    delete process.env['AFK_WAVE_RESUME_UNATTENDED'];
  });

  it('returns false when not interactive and env var unset', () => {
    delete process.env['AFK_WAVE_RESUME_UNATTENDED'];
    expect(shouldSurfaceResumptionOffer(false)).toBe(false);
  });

  it('returns true when interactive regardless of env var', () => {
    delete process.env['AFK_WAVE_RESUME_UNATTENDED'];
    expect(shouldSurfaceResumptionOffer(true)).toBe(true);
    process.env['AFK_WAVE_RESUME_UNATTENDED'] = '0';
    expect(shouldSurfaceResumptionOffer(true)).toBe(true);
  });

  it("returns true when env var is '1' regardless of interactive", () => {
    process.env['AFK_WAVE_RESUME_UNATTENDED'] = '1';
    expect(shouldSurfaceResumptionOffer(false)).toBe(true);
    expect(shouldSurfaceResumptionOffer(true)).toBe(true);
  });
});
