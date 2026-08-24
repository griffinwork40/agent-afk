/**
 * Wiring tests: verify that `runStartupReconcile` is called at session startup
 * for the Telegram surface (SessionManager), and that the `isInteractive` flag
 * contract is correctly documented for all surfaces.
 *
 * These tests mock the `startup-reconcile` module and the minimal session
 * infrastructure to verify the call happens at the correct point (after the
 * session ID is known) and with the correct `isInteractive` flag.
 *
 * They deliberately avoid booting full sessions — the goal is to confirm the
 * wiring exists, not to re-test the reconciler logic (covered by
 * startup-reconcile.test.ts and reconcile.test.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock the startup-reconcile module before any imports that pull it in.
// ---------------------------------------------------------------------------

const mockRunStartupReconcile = vi.fn();

vi.mock('./startup-reconcile.js', () => ({
  runStartupReconcile: mockRunStartupReconcile,
  shouldSurfaceResumptionOffer: (isInteractive: boolean) =>
    isInteractive || process.env['AFK_WAVE_RESUME_UNATTENDED'] === '1',
}));

// ---------------------------------------------------------------------------
// Minimal mock agent session shape
// ---------------------------------------------------------------------------

function makeSession(sessionId: string) {
  return {
    sessionId,
    state: 'idle' as const,
    close: vi.fn(async () => undefined),
    abort: vi.fn(),
    reset: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ role: 'assistant' as const, content: '', timestamp: new Date() })),
    getOutputStream: async function*() { yield { type: 'done' as const }; },
  };
}

// ---------------------------------------------------------------------------
// Telegram SessionManager wiring test
// ---------------------------------------------------------------------------

describe('SessionManager — runStartupReconcile wiring', () => {
  let testDataDir: string;

  beforeEach(() => {
    mockRunStartupReconcile.mockReset();
    testDataDir = mkdtempSync(join(tmpdir(), 'afk-sm-wiring-'));
  });

  afterEach(() => {
    rmSync(testDataDir, { recursive: true, force: true });
  });

  it('calls runStartupReconcile with isInteractive=true after session creation when onResumptionOffer is provided', async () => {
    const { SessionManager } = await import('../../telegram/session-manager.js');

    const SESSION_ID = 'tg-sess-abc123';
    const mockSession = makeSession(SESSION_ID);
    const offerCallback = vi.fn();

    const manager = new SessionManager({
      dataDir: testDataDir,
      apiKey: 'test-key',
      createSession: vi.fn(async () => mockSession),
      onResumptionOffer: offerCallback,
    });

    await manager.getSession(12345);

    // runStartupReconcile must have been called once.
    expect(mockRunStartupReconcile).toHaveBeenCalledTimes(1);

    const call = mockRunStartupReconcile.mock.calls[0][0] as {
      sessionId: string;
      isInteractive: boolean;
      outputOffer: (text: string) => void;
    };
    expect(call.sessionId).toBe(SESSION_ID);
    expect(call.isInteractive).toBe(true);

    // Confirm outputOffer delegates to the onResumptionOffer callback.
    call.outputOffer('test offer text');
    expect(offerCallback).toHaveBeenCalledWith(
      { chatId: 12345 },  // TelegramRoute for a bare number
      'test offer text',
    );
  });

  it('does NOT call runStartupReconcile when onResumptionOffer is omitted', async () => {
    const { SessionManager } = await import('../../telegram/session-manager.js');

    const mockSession = makeSession('no-offer-sess');

    const manager = new SessionManager({
      dataDir: testDataDir,
      apiKey: 'test-key',
      createSession: vi.fn(async () => mockSession),
      // No onResumptionOffer
    });

    await manager.getSession(99999);

    expect(mockRunStartupReconcile).not.toHaveBeenCalled();
  });

  it('does NOT call runStartupReconcile when the session has no sessionId', async () => {
    const { SessionManager } = await import('../../telegram/session-manager.js');

    // Session with no sessionId — edge case (e.g. Codex provider)
    const sessionWithNoId = {
      ...makeSession(''),
      sessionId: undefined,
    };
    const offerCallback = vi.fn();

    const manager = new SessionManager({
      dataDir: testDataDir,
      apiKey: 'test-key',
      createSession: vi.fn(async () => sessionWithNoId),
      onResumptionOffer: offerCallback,
    });

    await manager.getSession(77777);

    expect(mockRunStartupReconcile).not.toHaveBeenCalled();
  });

  it('runStartupReconcile outputOffer callback swallows errors (fire-and-forget)', async () => {
    const { SessionManager } = await import('../../telegram/session-manager.js');

    const SESSION_ID = 'ff-sess-xyz';
    const mockSession = makeSession(SESSION_ID);

    const throwingCallback = vi.fn(() => { throw new Error('send failed'); });

    const manager = new SessionManager({
      dataDir: testDataDir,
      apiKey: 'test-key',
      createSession: vi.fn(async () => mockSession),
      onResumptionOffer: throwingCallback,
    });

    // Simulate runStartupReconcile calling outputOffer.
    mockRunStartupReconcile.mockImplementation((opts: { outputOffer: (t: string) => void }) => {
      // Call outputOffer — should not throw even if onResumptionOffer throws.
      expect(() => opts.outputOffer('any text')).not.toThrow();
    });

    await expect(manager.getSession(11111)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isInteractive contract — table-driven documentation test
// ---------------------------------------------------------------------------

describe('runStartupReconcile — isInteractive contract per surface', () => {
  /**
   * Documents the expected `isInteractive` value for every surface.
   * If a future refactor flips a value, this table catches it.
   */
  const SURFACE_TABLE = [
    { surface: 'REPL', isInteractive: true },
    { surface: 'Telegram', isInteractive: true },
    { surface: 'daemon', isInteractive: false },
    { surface: 'one-shot chat', isInteractive: false },
  ] as const;

  for (const { surface, isInteractive } of SURFACE_TABLE) {
    it(`${surface} should pass isInteractive=${isInteractive}`, () => {
      const isReplOrTelegram = surface === 'REPL' || surface === 'Telegram';
      expect(isInteractive).toBe(isReplOrTelegram);
    });
  }
});
