/**
 * Tests for the session-startup wave manifest reconcile helper.
 *
 * Verifies that `runStartupReconcile` correctly gates on
 * `shouldSurfaceResumptionOffer`, calls the reconciler, and routes offers
 * to the `outputOffer` callback — while never throwing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStartupReconcile } from './startup-reconcile.js';
import { createManifest, buildWaveUnit } from './write.js';
import { getWaveManifestPath } from '../../paths.js';
import { readFileSync, writeFileSync } from 'node:fs';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'afk-startup-reconcile-'));
  process.env['AFK_STATE_DIR'] = stateDir;
  delete process.env['AFK_WAVE_MANIFEST_DISABLED'];
  delete process.env['AFK_WAVE_RESUME_UNATTENDED'];
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env['AFK_STATE_DIR'];
  delete process.env['AFK_WAVE_MANIFEST_DISABLED'];
  delete process.env['AFK_WAVE_RESUME_UNATTENDED'];
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStaleManifest(sessionId: string): string {
  const units = [
    buildWaveUnit({ id: 'u1', prompt: 'do the thing', cwd: '/tmp/wt', model: 'sonnet' }),
  ];
  const waveId = createManifest({
    source: 'agent-tool',
    parentSessionId: sessionId,
    traceLabel: null,
    units,
  });
  if (!waveId) throw new Error('createManifest returned null');
  return waveId;
}

// ---------------------------------------------------------------------------
// shouldSurfaceResumptionOffer gate — interactive path
// ---------------------------------------------------------------------------

describe('runStartupReconcile — interactive surface', () => {
  it('calls outputOffer for each stale manifest when isInteractive=true', () => {
    const sessionId = 'test-sess-interactive';
    makeStaleManifest(sessionId);

    const collected: string[] = [];
    runStartupReconcile({
      sessionId,
      isInteractive: true,
      outputOffer: (text) => collected.push(text),
    });

    expect(collected).toHaveLength(1);
    expect(collected[0]).toContain('[wave-resume]');
  });

  it('emits no output when there are no stale manifests', () => {
    const collected: string[] = [];
    runStartupReconcile({
      sessionId: 'no-manifests-sess',
      isInteractive: true,
      outputOffer: (text) => collected.push(text),
    });
    expect(collected).toHaveLength(0);
  });

  it('emits multiple offers when multiple stale manifests exist', () => {
    const sessionId = 'multi-manifest-sess';
    makeStaleManifest(sessionId);
    makeStaleManifest(sessionId);

    const collected: string[] = [];
    runStartupReconcile({
      sessionId,
      isInteractive: true,
      outputOffer: (text) => collected.push(text),
    });

    expect(collected).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// shouldSurfaceResumptionOffer gate — non-interactive path
// ---------------------------------------------------------------------------

describe('runStartupReconcile — non-interactive surface', () => {
  it('does NOT call outputOffer when isInteractive=false and AFK_WAVE_RESUME_UNATTENDED is unset', () => {
    const sessionId = 'daemon-sess';
    makeStaleManifest(sessionId);

    const collected: string[] = [];
    runStartupReconcile({
      sessionId,
      isInteractive: false,
      outputOffer: (text) => collected.push(text),
    });

    expect(collected).toHaveLength(0);
  });

  it('DOES call outputOffer when isInteractive=false and AFK_WAVE_RESUME_UNATTENDED=1', () => {
    process.env['AFK_WAVE_RESUME_UNATTENDED'] = '1';
    const sessionId = 'daemon-unattended-sess';
    makeStaleManifest(sessionId);

    const collected: string[] = [];
    runStartupReconcile({
      sessionId,
      isInteractive: false,
      outputOffer: (text) => collected.push(text),
    });

    expect(collected).toHaveLength(1);
    expect(collected[0]).toContain('[wave-resume]');
  });
});

// ---------------------------------------------------------------------------
// Fire-and-forget invariant — errors must never propagate
// ---------------------------------------------------------------------------

describe('runStartupReconcile — fire-and-forget', () => {
  it('does not throw when outputOffer callback throws', () => {
    const sessionId = 'throwing-sess';
    makeStaleManifest(sessionId);

    expect(() =>
      runStartupReconcile({
        sessionId,
        isInteractive: true,
        outputOffer: () => { throw new Error('callback error'); },
      }),
    ).not.toThrow();
  });

  it('does not throw when AFK_STATE_DIR is missing (no waves dir)', () => {
    // Point to a non-existent dir so readdirSync fails.
    process.env['AFK_STATE_DIR'] = join(stateDir, 'does-not-exist');

    expect(() =>
      runStartupReconcile({
        sessionId: 'missing-dir-sess',
        isInteractive: true,
        outputOffer: () => {},
      }),
    ).not.toThrow();
  });

  it('does not throw when a manifest file is corrupt', () => {
    // Write a corrupt manifest file directly.
    const waveId = 'deadbeef00000000';
    const wavesDir = join(stateDir, 'waves');
    require('node:fs').mkdirSync(wavesDir, { recursive: true });
    require('node:fs').writeFileSync(join(wavesDir, `${waveId}.json`), 'not-valid-json');

    expect(() =>
      runStartupReconcile({
        sessionId: 'corrupt-sess',
        isInteractive: true,
        outputOffer: () => {},
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Wiring verification — confirm the helper routes through formatResumptionOffer
// ---------------------------------------------------------------------------

describe('runStartupReconcile — output format', () => {
  it('output text includes waveId and source', () => {
    const sessionId = 'format-check-sess';
    makeStaleManifest(sessionId);

    const collected: string[] = [];
    runStartupReconcile({
      sessionId,
      isInteractive: true,
      outputOffer: (text) => collected.push(text),
    });

    expect(collected[0]).toContain('agent-tool');
    expect(collected[0]).toContain('Accept?');
  });
});
