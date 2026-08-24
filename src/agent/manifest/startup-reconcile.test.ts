/**
 * Unit tests for the startup-reconcile helpers.
 *
 * Verifies that runReplReconcile, runTelegramReconcile, and
 * runNonInteractiveReconcile fire the expected callbacks when wave manifests
 * with unsettled units exist, and that they are no-ops when the gate is off.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReplReconcile, runTelegramReconcile, runNonInteractiveReconcile } from './startup-reconcile.js';
import { createManifest, buildWaveUnit } from './write.js';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'afk-sr-'));
  process.env['AFK_STATE_DIR'] = stateDir;
  delete process.env['AFK_WAVE_RESUME_UNATTENDED'];
  delete process.env['AFK_WAVE_MANIFEST_DISABLED'];
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  delete process.env['AFK_STATE_DIR'];
  delete process.env['AFK_WAVE_RESUME_UNATTENDED'];
  delete process.env['AFK_WAVE_MANIFEST_DISABLED'];
  vi.restoreAllMocks();
});

/** Create a manifest with two pending units owned by `sessionId`. */
function seedManifest(sessionId: string): string {
  const units = [
    buildWaveUnit({ id: 'u1', prompt: 'investigate', cwd: undefined, model: 'sonnet' }),
    buildWaveUnit({ id: 'u2', prompt: 'fix bug', cwd: undefined, model: 'haiku' }),
  ];
  return createManifest({ source: 'agent-tool', parentSessionId: sessionId, traceLabel: null, units }) ?? '';
}

describe('runReplReconcile', () => {
  it('writes resumption offer to stderr when manifests exist', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    seedManifest('repl-sess');

    runReplReconcile('repl-sess');
    // The helper schedules async via Promise.resolve().then() — flush it.
    await Promise.resolve();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((t) => t.includes('[wave-resume]'))).toBe(true);
  });

  it('is a no-op when no manifests exist', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    runReplReconcile('no-manifests-sess');
    await Promise.resolve();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((t) => t.includes('[wave-resume]'))).toBe(false);
  });
});

describe('runTelegramReconcile', () => {
  it('calls sendText with the resumption offer when manifests exist', async () => {
    const sendText = vi.fn();
    seedManifest('tg-sess');

    runTelegramReconcile('tg-sess', 42, sendText);
    await Promise.resolve();

    expect(sendText).toHaveBeenCalledOnce();
    const [calledChatId, calledText] = sendText.mock.calls[0] as [number, string];
    expect(calledChatId).toBe(42);
    expect(calledText).toContain('[wave-resume]');
  });

  it('is a no-op when no manifests exist', async () => {
    const sendText = vi.fn();

    runTelegramReconcile('no-manifests-sess', 99, sendText);
    await Promise.resolve();

    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('runNonInteractiveReconcile', () => {
  it('is a no-op without AFK_WAVE_RESUME_UNATTENDED=1', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    seedManifest('daemon-sess');

    runNonInteractiveReconcile('daemon-sess');
    await Promise.resolve();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((t) => t.includes('[wave-resume]'))).toBe(false);
  });

  it('writes resumption offer to stderr when AFK_WAVE_RESUME_UNATTENDED=1', async () => {
    process.env['AFK_WAVE_RESUME_UNATTENDED'] = '1';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    seedManifest('daemon-sess-2');

    runNonInteractiveReconcile('daemon-sess-2');
    await Promise.resolve();

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((t) => t.includes('[wave-resume]'))).toBe(true);
  });
});
