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
import { runReplReconcile, runTelegramReconcile, runNonInteractiveReconcile, runDaemonReconcile } from './startup-reconcile.js';
import { createManifest, buildWaveUnit, readManifest } from './write.js';

vi.mock('../../telegram/push.js', () => ({
  pushIfConfigured: vi.fn(),
}));

import { pushIfConfigured } from '../../telegram/push.js';
const mockPushIfConfigured = vi.mocked(pushIfConfigured);

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'afk-sr-'));
  process.env['AFK_STATE_DIR'] = stateDir;
  delete process.env['AFK_WAVE_RESUME_UNATTENDED'];
  delete process.env['AFK_WAVE_MANIFEST_DISABLED'];
  mockPushIfConfigured.mockReset();
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

    const route = { chatId: 42, threadId: 7 };
    runTelegramReconcile('tg-sess', route, sendText);
    // The inner .then() callback is now async (awaits Promise.resolve(sendText(...)));
    // two microtask ticks are needed: one to enter the then(), one to resume after await.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendText).toHaveBeenCalledOnce();
    const [calledRoute, calledText] = sendText.mock.calls[0] as [typeof route, string];
    expect(calledRoute).toBe(route);
    expect(calledText).toContain('[wave-resume]');
  });

  it('is a no-op when no manifests exist', async () => {
    const sendText = vi.fn();

    runTelegramReconcile('no-manifests-sess', { chatId: 99 }, sendText);
    await Promise.resolve();
    await Promise.resolve();

    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('runTelegramReconcile — offeredAt stamping', () => {
  it('marks manifest as offered after sendText returns void (legacy/undefined)', async () => {
    // vi.fn() returns undefined — treated as "assumed delivered" (backward compat).
    const sendText = vi.fn();
    const waveId = seedManifest('tg-dedup');

    runTelegramReconcile('tg-dedup', { chatId: 42 }, sendText);
    // Two microtask ticks: enter the async then(), resume after await Promise.resolve().
    await Promise.resolve();
    await Promise.resolve();

    expect(sendText).toHaveBeenCalledOnce();
    const manifest = readManifest(waveId);
    expect(manifest?.offeredAt).toBeDefined();
  });

  it('marks manifest as offered after sendText returns Promise<true>', async () => {
    const sendText = vi.fn().mockResolvedValue(true);
    const waveId = seedManifest('tg-dedup-true');

    runTelegramReconcile('tg-dedup-true', { chatId: 42 }, sendText);
    // Three ticks: enter the async then(), resolve Promise.resolve(sendText(...)),
    // resume after the awaited promise settles.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sendText).toHaveBeenCalledOnce();
    const manifest = readManifest(waveId);
    expect(manifest?.offeredAt).toBeDefined();
  });

  it('does NOT stamp offeredAt when sendText returns Promise<false>', async () => {
    // Simulates a Telegram send failure (429, network error, blocked bot).
    const sendText = vi.fn().mockResolvedValue(false);
    const waveId = seedManifest('tg-dedup-fail');

    runTelegramReconcile('tg-dedup-fail', { chatId: 42 }, sendText);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(sendText).toHaveBeenCalledOnce();
    const manifest = readManifest(waveId);
    // offeredAt must NOT be set — the offer must be re-surfaced next session.
    expect(manifest?.offeredAt).toBeUndefined();
  });

  it('does not re-send on second reconcile after marking', async () => {
    const sendText = vi.fn();
    seedManifest('tg-dedup2');

    runTelegramReconcile('tg-dedup2', { chatId: 42 }, sendText);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendText).toHaveBeenCalledOnce();

    // Second reconcile: manifest is marked, should not send again.
    sendText.mockClear();
    runTelegramReconcile('tg-dedup2', { chatId: 42 }, sendText);
    await Promise.resolve();
    await Promise.resolve();
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('runReplReconcile — offeredAt stamping', () => {
  it('marks manifest as offered after writing to stderr', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const waveId = seedManifest('repl-dedup');

    runReplReconcile('repl-dedup');
    await Promise.resolve();

    const manifest = readManifest(waveId);
    expect(manifest?.offeredAt).toBeDefined();
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

// ---------------------------------------------------------------------------
// runDaemonReconcile — #3248
// ---------------------------------------------------------------------------

describe('runDaemonReconcile', () => {
  it('is a no-op without AFK_WAVE_RESUME_UNATTENDED=1', async () => {
    mockPushIfConfigured.mockResolvedValue([{ ok: true, status: 200 }]);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    seedManifest('dr-gated');

    runDaemonReconcile('dr-gated');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPushIfConfigured).not.toHaveBeenCalled();
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((t) => t.includes('[wave-resume]'))).toBe(false);
  });

  it('pushes via Telegram when AFK_WAVE_RESUME_UNATTENDED=1 and manifests exist', async () => {
    process.env['AFK_WAVE_RESUME_UNATTENDED'] = '1';
    mockPushIfConfigured.mockResolvedValue([{ ok: true, status: 200 }]);
    seedManifest('dr-push');

    runDaemonReconcile('dr-push');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPushIfConfigured).toHaveBeenCalledOnce();
    const [text] = mockPushIfConfigured.mock.calls[0] as [string];
    expect(text).toContain('[wave-resume]');
  });

  it('stamps offeredAt only when Telegram push reports ok:true', async () => {
    process.env['AFK_WAVE_RESUME_UNATTENDED'] = '1';
    mockPushIfConfigured.mockResolvedValue([{ ok: true, status: 200 }]);
    const waveId = seedManifest('dr-stamp-ok');

    runDaemonReconcile('dr-stamp-ok');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const manifest = readManifest(waveId);
    expect(manifest?.offeredAt).toBeDefined();
  });

  it('does NOT stamp offeredAt when all pushes fail (ok:false)', async () => {
    process.env['AFK_WAVE_RESUME_UNATTENDED'] = '1';
    mockPushIfConfigured.mockResolvedValue([{ ok: false, status: 429, errorMessage: 'Rate Limited' }]);
    const waveId = seedManifest('dr-stamp-fail');

    runDaemonReconcile('dr-stamp-fail');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const manifest = readManifest(waveId);
    // Delivery failed → offer must re-surface on next session.
    expect(manifest?.offeredAt).toBeUndefined();
  });

  it('falls back to stderr and stamps when Telegram is not configured (null result)', async () => {
    process.env['AFK_WAVE_RESUME_UNATTENDED'] = '1';
    // pushIfConfigured returns null when no token/targets are configured.
    mockPushIfConfigured.mockResolvedValue(null as unknown as ReturnType<typeof pushIfConfigured> extends Promise<infer R> ? R : never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const waveId = seedManifest('dr-fallback');

    runDaemonReconcile('dr-fallback');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // stderr receives the offer text.
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((t) => t.includes('[wave-resume]'))).toBe(true);
    // Manifest is stamped (stderr delivery is "confirmed").
    const manifest = readManifest(waveId);
    expect(manifest?.offeredAt).toBeDefined();
  });

  it('does not re-send on second reconcile after a successful push', async () => {
    process.env['AFK_WAVE_RESUME_UNATTENDED'] = '1';
    mockPushIfConfigured.mockResolvedValue([{ ok: true, status: 200 }]);
    seedManifest('dr-dedup');

    runDaemonReconcile('dr-dedup');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPushIfConfigured).toHaveBeenCalledOnce();

    // Second reconcile: manifest is stamped, should not push again.
    mockPushIfConfigured.mockClear();
    runDaemonReconcile('dr-dedup');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockPushIfConfigured).not.toHaveBeenCalled();
  });
});
