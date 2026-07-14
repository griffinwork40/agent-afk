/**
 * Unit tests for the AFK-mode toggle helper.
 *
 * `toggleAfkMode` flips the session permission mode ('autonomous' <-> 'default'),
 * mirrors the result onto `stats.permissionMode`, resets the per-session push
 * budget on turn-ON, and preflights Telegram config (warns but still enters AFK
 * mode when unconfigured). Mirrors plan-mode-toggle's failure semantics: leave
 * permissionMode unchanged on a setPermissionMode rejection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable Telegram-config state the mocks read.
let mockToken: string | undefined = 'bot-token';
let mockTargets: number[] = [123456];

vi.mock('../config/env.js', () => ({
  get env() {
    return { TELEGRAM_BOT_TOKEN: mockToken };
  },
}));
vi.mock('../telegram/notify-routing.js', () => ({
  resolveConfiguredNotifyTargets: () => mockTargets,
}));
const resetAfkPushBudget = vi.fn();
vi.mock('./commands/interactive/afk-push.js', () => ({
  resetAfkPushBudget: () => resetAfkPushBudget(),
}));

// AFK ledger-channel collaborators — mocked so this stays a pure unit test of
// toggleAfkMode's orchestration. The real ledger handler, HMAC key, and
// presence writer are covered by their own suites (afk-ledger-channel.test.ts,
// afk-channel.test.ts).
const ensureSessionKey = vi.fn((_id: string): string | null => 'a'.repeat(64));
vi.mock('../agent/afk-channel.js', () => ({
  ensureSessionKey: (id: string) => ensureSessionKey(id),
}));
const ledgerHandlerSentinel: ElicitationHandler = () => Promise.resolve({ action: 'decline' });
const makeLedgerChannelHandler = vi.fn(
  (_deps: unknown): ElicitationHandler => ledgerHandlerSentinel,
);
// Stub abort-watcher: returns a no-op handle; correctness tested in its own suite.
const makeAbortWatcher = vi.fn(
  (_deps: unknown): { stop: () => void } => ({ stop: () => {} }),
);
vi.mock('../agent/afk-ledger-channel.js', () => ({
  makeLedgerChannelHandler: (deps: unknown) => makeLedgerChannelHandler(deps),
  makeAbortWatcher: (deps: unknown) => makeAbortWatcher(deps),
}));
const setPresenceAfk = vi.fn();
vi.mock('../agent/awareness/presence.js', () => ({
  setPresenceAfk: (id: string, afk: boolean) => setPresenceAfk(id, afk),
}));

import { toggleAfkMode } from './afk-mode-toggle.js';
import type { SessionStats, SlashContext } from './slash/types.js';
import type { ElicitationHandler } from '../agent/elicitation-router.js';

function makeStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
    ...overrides,
  };
}

function makeCtx(opts: {
  stats: SessionStats;
  setPermissionMode?: ReturnType<typeof vi.fn>;
  sessionId?: string;
  withChannel?: boolean;
}): {
  ctx: SlashContext;
  sess: {
    setPermissionMode: ReturnType<typeof vi.fn>;
    sessionId: string | undefined;
    recordLedgerElicitation: ReturnType<typeof vi.fn>;
  };
  lines: string[];
  swapCalls: (ElicitationHandler | null)[];
  stdinHandler: ElicitationHandler;
} {
  const lines: string[] = [];
  const sess = {
    setPermissionMode: opts.setPermissionMode ?? vi.fn().mockResolvedValue(undefined),
    sessionId: opts.sessionId,
    recordLedgerElicitation: vi.fn(),
  };
  const stdinHandler: ElicitationHandler = () => Promise.resolve({ action: 'decline' });
  const swapCalls: (ElicitationHandler | null)[] = [];
  const ctx: SlashContext = {
    session: { current: sess } as unknown as SlashContext['session'],
    stats: opts.stats,
    out: {
      line: (t = '') => lines.push(t),
      raw: (t) => lines.push(t),
      success: (t) => lines.push(`SUCCESS:${t}`),
      info: (t) => lines.push(`INFO:${t}`),
      warn: (t) => lines.push(`WARN:${t}`),
      error: (t) => lines.push(`ERROR:${t}`),
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    ...(opts.withChannel
      ? {
          stdinElicitationHandler: stdinHandler,
          swapElicitationHandler: (h: ElicitationHandler | null) => {
            swapCalls.push(h);
          },
        }
      : {}),
  };
  return { ctx, sess, lines, swapCalls, stdinHandler };
}

describe('toggleAfkMode', () => {
  beforeEach(() => {
    mockToken = 'bot-token';
    mockTargets = [123456];
    resetAfkPushBudget.mockClear();
  });

  it('flips default → autonomous and emits ON copy', async () => {
    const stats = makeStats({ permissionMode: 'default' });
    const { ctx, sess, lines } = makeCtx({ stats });

    await toggleAfkMode(ctx, true);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('autonomous');
    expect(stats.permissionMode).toBe('autonomous');
    expect(lines.join('\n').toLowerCase()).toContain('afk mode on');
  });

  it('resets the per-session push budget on turn-ON', async () => {
    const { ctx } = makeCtx({ stats: makeStats() });
    await toggleAfkMode(ctx, true);
    expect(resetAfkPushBudget).toHaveBeenCalledTimes(1);
  });

  it('flips autonomous → default and emits OFF copy', async () => {
    const stats = makeStats({ permissionMode: 'autonomous' });
    const { ctx, sess, lines } = makeCtx({ stats });

    await toggleAfkMode(ctx, false);

    expect(sess.setPermissionMode).toHaveBeenCalledWith('default');
    expect(stats.permissionMode).toBe('default');
    expect(lines.join('\n').toLowerCase()).toContain('afk mode off');
  });

  it('warns but STILL enters AFK mode when Telegram is unconfigured', async () => {
    mockToken = undefined;
    mockTargets = [];
    const stats = makeStats({ permissionMode: 'default' });
    const { ctx, lines } = makeCtx({ stats });

    await toggleAfkMode(ctx, true);

    // Mode still flips — gate + posture apply regardless of Telegram.
    expect(stats.permissionMode).toBe('autonomous');
    const joined = lines.join('\n').toLowerCase();
    expect(joined).toContain('telegram is not configured');
    expect(lines.some((l) => l.startsWith('ERROR:'))).toBe(true);
  });

  it('does NOT warn about Telegram when fully configured', async () => {
    const { ctx, lines } = makeCtx({ stats: makeStats() });
    await toggleAfkMode(ctx, true);
    expect(lines.join('\n').toLowerCase()).not.toContain('telegram is not configured');
  });

  it('leaves permissionMode unchanged and surfaces an error when setPermissionMode rejects', async () => {
    const setPermissionMode = vi.fn().mockRejectedValue(new Error('boom'));
    const stats = makeStats({ permissionMode: 'default' });
    const { ctx, lines } = makeCtx({ stats, setPermissionMode });

    await toggleAfkMode(ctx, true);

    expect(setPermissionMode).toHaveBeenCalledWith('autonomous');
    expect(stats.permissionMode).toBe('default');
    expect(lines.some((l) => l.startsWith('ERROR:'))).toBe(true);
  });
});

describe('toggleAfkMode — AFK ledger channel wiring (scope.lock criterion 1)', () => {
  beforeEach(() => {
    mockToken = 'bot-token';
    mockTargets = [123456];
    resetAfkPushBudget.mockClear();
    ensureSessionKey.mockClear();
    makeLedgerChannelHandler.mockClear();
    makeAbortWatcher.mockClear();
    setPresenceAfk.mockClear();
  });

  it('on /afk on, swaps to the ledger channel handler and marks presence AFK', async () => {
    const { ctx, sess, swapCalls, stdinHandler } = makeCtx({
      stats: makeStats({ permissionMode: 'default' }),
      sessionId: 's1',
      withChannel: true,
    });

    await toggleAfkMode(ctx, true);

    // Built the ledger handler against the right deps (live id + HMAC key +
    // the keyboard fallback) ...
    expect(makeLedgerChannelHandler).toHaveBeenCalledTimes(1);
    expect(makeLedgerChannelHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        key: 'a'.repeat(64),
        fallback: stdinHandler,
        emitElicitation: expect.any(Function),
      }),
    );
    // ... and installed THAT handler (not the stdin fallback).
    expect(swapCalls).toHaveLength(1);
    expect(swapCalls[0]).toBe(ledgerHandlerSentinel);
    expect(swapCalls[0]).not.toBe(stdinHandler);
    expect(setPresenceAfk).toHaveBeenCalledWith('s1', true);
    expect(sess.setPermissionMode).toHaveBeenCalledWith('autonomous');
  });

  it('wires emitElicitation to append via the session ledger writer', async () => {
    const { ctx, sess } = makeCtx({
      stats: makeStats(),
      sessionId: 's1',
      withChannel: true,
    });

    await toggleAfkMode(ctx, true);

    const firstCall = makeLedgerChannelHandler.mock.calls[0];
    if (!firstCall) throw new Error('expected makeLedgerChannelHandler to be called');
    const deps = firstCall[0] as {
      emitElicitation: (r: { kind: 'elicitation'; reqId: string; request: unknown }) => void;
    };
    const request = { type: 'text', message: 'pick one' };
    deps.emitElicitation({ kind: 'elicitation', reqId: 'r1', request });
    expect(sess.recordLedgerElicitation).toHaveBeenCalledWith('r1', request);
  });

  it('on /afk off, restores stdin (null swap) and clears the AFK presence marker', async () => {
    const { ctx, swapCalls } = makeCtx({
      stats: makeStats({ permissionMode: 'autonomous' }),
      sessionId: 's1',
      withChannel: true,
    });

    await toggleAfkMode(ctx, false);

    expect(swapCalls).toEqual([null]);
    expect(setPresenceAfk).toHaveBeenCalledWith('s1', false);
    expect(makeLedgerChannelHandler).not.toHaveBeenCalled();
  });

  it('degrades to keyboard-only AND warns when the provider session id is not yet known', async () => {
    const { ctx, swapCalls, lines } = makeCtx({
      stats: makeStats({ permissionMode: 'default' }),
      // no sessionId → e.g. /afk on before the first turn issued an id
      withChannel: true,
    });

    await toggleAfkMode(ctx, true);

    expect(makeLedgerChannelHandler).not.toHaveBeenCalled();
    expect(swapCalls).toHaveLength(0);
    expect(setPresenceAfk).not.toHaveBeenCalled();
    // AFK still entered — channel is additive, the keyboard stays live.
    expect(ctx.stats.permissionMode).toBe('autonomous');
    // F3 guard: the silent skip is gone — the operator is explicitly warned the
    // phone relay is NOT armed (and told to re-toggle after a turn), so they
    // don't walk away trusting a dead phone leg.
    expect(lines.some((l) => l.startsWith('ERROR:') && /phone relay NOT armed/i.test(l))).toBe(true);
  });

  it('F3: warns about the missing signing key but STILL arms the channel', async () => {
    ensureSessionKey.mockReturnValueOnce(null);
    const { ctx, swapCalls, lines } = makeCtx({
      stats: makeStats({ permissionMode: 'default' }),
      sessionId: 's-nokey',
      withChannel: true,
    });

    await toggleAfkMode(ctx, true);

    // Warned that phone replies / remote abort won't work without a key ...
    expect(lines.some((l) => l.startsWith('ERROR:') && /signing key/i.test(l))).toBe(true);
    // ... but the channel is STILL installed (keyboard fallback races) and AFK
    // is entered — a null key must not silently disable AFK.
    expect(makeLedgerChannelHandler).toHaveBeenCalledTimes(1);
    expect(swapCalls).toHaveLength(1);
    expect(ctx.stats.permissionMode).toBe('autonomous');
  });

  it('no-ops the swap on a surface that exposes no channel (non-REPL)', async () => {
    const { ctx, swapCalls } = makeCtx({
      stats: makeStats(),
      sessionId: 's1',
      withChannel: false,
    });

    await toggleAfkMode(ctx, true);

    expect(makeLedgerChannelHandler).not.toHaveBeenCalled();
    expect(swapCalls).toHaveLength(0);
    expect(setPresenceAfk).not.toHaveBeenCalled();
    expect(ctx.stats.permissionMode).toBe('autonomous');
  });

  // Criterion 4: abort-watcher wiring
  it('on /afk on, starts the abort-watcher bound to the same session and key', async () => {
    const { ctx } = makeCtx({
      stats: makeStats({ permissionMode: 'default' }),
      sessionId: 's2',
      withChannel: true,
    });

    await toggleAfkMode(ctx, true);

    expect(makeAbortWatcher).toHaveBeenCalledTimes(1);
    expect(makeAbortWatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's2',
        key: 'a'.repeat(64),
        onAbort: expect.any(Function),
      }),
    );
  });

  it('on /afk off, stops the abort-watcher (stop() is called)', async () => {
    // Turn ON first to install the watcher.
    const { ctx } = makeCtx({
      stats: makeStats({ permissionMode: 'default' }),
      sessionId: 's3',
      withChannel: true,
    });
    await toggleAfkMode(ctx, true);

    const handle = makeAbortWatcher.mock.results[0]?.value as { stop: ReturnType<typeof vi.fn> } | undefined;
    expect(handle).toBeDefined();
    // The stub returns { stop: () => {} }; spy on it.
    const stopSpy = vi.spyOn(handle!, 'stop');

    // Now turn OFF.
    await toggleAfkMode(ctx, false);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('abort-watcher is not started when no channel (non-REPL surface)', async () => {
    const { ctx } = makeCtx({
      stats: makeStats({ permissionMode: 'default' }),
      sessionId: 's4',
      withChannel: false,
    });

    await toggleAfkMode(ctx, true);

    expect(makeAbortWatcher).not.toHaveBeenCalled();
  });
});
