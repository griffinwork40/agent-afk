/**
 * `/compact` slash handler tests.
 *
 * Verifies the handler invokes `session.compact()` (not the broken
 * `session.sendMessage('/compact')` it used to forward) and renders the
 * three result shapes: success with counts, no-op with reason, error
 * including a summarization-failure reason.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SlashCommand, SlashContext, SessionStats } from './types.js';
import { coreCommands } from './commands/core.js';
import { createHookRegistry } from '../../agent/hooks.js';
import { HookBlockedError, AbortError } from '../../utils/errors.js';

// File-wide `ora` mock so the H1 spinner-routing tests below can assert
// whether the bare-ora constructor was invoked at all (it must NOT be, on
// the compositor path — that is the entire point of the fix: a bare ora
// racing the persistent TerminalCompositor's frame repaints is the bug).
// Mirrors the stop()-returns-inst mocking style used in
// interactive-lifecycle.test.ts / interactive.boot-warnings.test.ts. Every
// pre-existing test below (which predates this mock) is unaffected — it
// only inspects `lines`, never `ora` internals — so the mocked start/stop
// no-ops are behaviorally transparent to them.
const oraFactory = vi.hoisted(() =>
  vi.fn(() => {
    const inst = { start: vi.fn(), stop: vi.fn() };
    inst.start.mockReturnValue(inst);
    return inst;
  }),
);
vi.mock('ora', () => ({ default: oraFactory }));

function makeStats(): SessionStats {
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
  };
}

interface FakeSession {
  compact: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function fakeSession(): FakeSession {
  return {
    compact: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
  };
}

function makeCtx(session: FakeSession): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: session } as unknown as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = ''): void => {
        lines.push(t);
      },
      raw: (t): void => {
        lines.push(t);
      },
      success: (t): void => {
        lines.push(`SUCCESS:${t}`);
      },
      info: (t): void => {
        lines.push(`INFO:${t}`);
      },
      warn: (t): void => {
        lines.push(`WARN:${t}`);
      },
      error: (t): void => {
        lines.push(`ERROR:${t}`);
      },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

function getCompactCmd(): SlashCommand {
  const cmd = coreCommands.find((c) => c.name === '/compact');
  if (!cmd) throw new Error('compact command not registered');
  return cmd;
}

/**
 * Extends `makeCtx` with a mock `getCompositor` — the H1 fix's TTY path.
 * `setSpinner` is the only compositor method the handler calls; kept as a
 * bare `vi.fn()` (structural typing satisfies `TerminalCompositor` for the
 * handler's purposes, matching how `core-rewind.test.ts` mocks
 * `suspendInput`/`resumeInput` with a `Mock`-cast object rather than a full
 * compositor instance).
 */
function makeCtxWithCompositor(
  session: FakeSession,
): { ctx: SlashContext; lines: string[]; setSpinner: ReturnType<typeof vi.fn> } {
  const { ctx, lines } = makeCtx(session);
  const setSpinner = vi.fn();
  ctx.getCompositor = () =>
    ({ setSpinner }) as unknown as ReturnType<NonNullable<SlashContext['getCompositor']>>;
  return { ctx, lines, setSpinner };
}

describe('/compact slash handler', () => {
  // ora draws to stdout in tests; silence it so Vitest output stays clean.
  const originalWrite = process.stdout.write.bind(process.stdout);
  beforeEach(() => {
    process.stdout.write = ((): boolean => true) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('calls session.compact() and never forwards "/compact" as a user message', async () => {
    const session = fakeSession();
    session.compact.mockResolvedValue({
      compacted: true,
      messagesBefore: 12,
      messagesAfter: 5,
      tokensSavedEstimate: 200,
    });
    const { ctx, lines } = makeCtx(session);

    await getCompactCmd().handler(ctx, '');

    expect(session.compact).toHaveBeenCalledTimes(1);
    expect(session.sendMessage).not.toHaveBeenCalled();
    const success = lines.find((l) => l.startsWith('SUCCESS:'));
    expect(success).toBeDefined();
    expect(success).toContain('12');
    expect(success).toContain('5');
    expect(success).toContain('200');
  });

  it('renders no-op reason as info', async () => {
    const session = fakeSession();
    session.compact.mockResolvedValue({
      compacted: false,
      reason: 'history-too-short',
      messagesBefore: 2,
      messagesAfter: 2,
    });
    const { ctx, lines } = makeCtx(session);

    await getCompactCmd().handler(ctx, '');

    const info = lines.find((l) => l.startsWith('INFO:'));
    expect(info).toBeDefined();
    expect(info).toContain('history-too-short');
  });

  it('renders nothing-to-summarize as a friendly keep-window info line', async () => {
    const session = fakeSession();
    session.compact.mockResolvedValue({
      compacted: false,
      reason: 'nothing-to-summarize',
      messagesBefore: 4,
      messagesAfter: 4,
    });
    const { ctx, lines } = makeCtx(session);

    await getCompactCmd().handler(ctx, '');

    const info = lines.find((l) => l.startsWith('INFO:'));
    expect(info).toBeDefined();
    expect(info).toContain('keep window');
  });

  it('renders aborted reason as a plain "cancelled" info line', async () => {
    const session = fakeSession();
    session.compact.mockResolvedValue({
      compacted: false,
      reason: 'aborted',
      messagesBefore: 8,
      messagesAfter: 8,
    });
    const { ctx, lines } = makeCtx(session);

    await getCompactCmd().handler(ctx, '');

    const info = lines.find((l) => l.startsWith('INFO:'));
    expect(info).toBeDefined();
    expect(info).toContain('cancelled');
  });

  it('renders summarization failures as an error', async () => {
    const session = fakeSession();
    session.compact.mockResolvedValue({
      compacted: false,
      reason: 'summarization-failed: boom',
      messagesBefore: 10,
      messagesAfter: 10,
    });
    const { ctx, lines } = makeCtx(session);

    await getCompactCmd().handler(ctx, '');

    const error = lines.find((l) => l.startsWith('ERROR:'));
    expect(error).toBeDefined();
    expect(error).toContain('summarization-failed: boom');
    expect(error).toContain('History unchanged');
  });

  it('renders a thrown error from compact() as ERROR', async () => {
    const session = fakeSession();
    session.compact.mockRejectedValue(new Error('blew up'));
    const { ctx, lines } = makeCtx(session);

    await getCompactCmd().handler(ctx, '');

    const error = lines.find((l) => l.startsWith('ERROR:'));
    expect(error).toBeDefined();
    expect(error).toContain('blew up');
  });
});

// ---------------------------------------------------------------------------
// PreCompact hook integration
// ---------------------------------------------------------------------------

describe('/compact PreCompact hook integration', () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  beforeEach(() => {
    process.stdout.write = ((): boolean => true) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  it('fires PreCompact hook with trigger=manual before compaction', async () => {
    const session = fakeSession();
    session.compact.mockResolvedValue({
      compacted: true,
      messagesBefore: 8,
      messagesAfter: 3,
    });
    const registry = createHookRegistry();
    const hookHandler = vi.fn(async () => ({}));
    registry.register('PreCompact', hookHandler);
    const sessionWithRegistry = { ...session, hookRegistry: registry, sessionId: 'test-sess' };
    const { ctx } = makeCtx(sessionWithRegistry as unknown as typeof session);

    await getCompactCmd().handler(ctx, '');

    expect(hookHandler).toHaveBeenCalledTimes(1);
    const [ctx0] = hookHandler.mock.calls[0] as [{ event: string; trigger: string }];
    expect(ctx0.event).toBe('PreCompact');
    expect(ctx0.trigger).toBe('manual');
    expect(session.compact).toHaveBeenCalledTimes(1);
  });

  it('skips compaction and renders info when PreCompact hook blocks', async () => {
    const session = fakeSession();
    const registry = createHookRegistry();
    registry.register('PreCompact', async () => ({
      decision: 'block' as const,
      reason: 'frozen',
    }));
    const sessionWithRegistry = { ...session, hookRegistry: registry, sessionId: 'test-sess' };
    const { ctx, lines } = makeCtx(sessionWithRegistry as unknown as typeof session);

    await getCompactCmd().handler(ctx, '');

    expect(session.compact).not.toHaveBeenCalled();
    const info = lines.find((l) => l.startsWith('INFO:'));
    expect(info).toBeDefined();
    expect(info).toContain('frozen');
  });

  it('hooks without a registry proceed normally', async () => {
    const session = fakeSession();
    session.compact.mockResolvedValue({
      compacted: true,
      messagesBefore: 4,
      messagesAfter: 2,
    });
    // No hookRegistry on session — tests that the undefined guard works.
    const { ctx } = makeCtx(session);

    await getCompactCmd().handler(ctx, '');

    expect(session.compact).toHaveBeenCalledTimes(1);
  });

  it('converts HookBlockedError thrown by handler to an info skip message', async () => {
    // Verify HookBlockedError is handled gracefully rather than propagating.
    const session = fakeSession();
    const registry = createHookRegistry();
    registry.register('PreCompact', async () => {
      throw new HookBlockedError('handler threw directly', 'PreCompact');
    });
    const sessionWithRegistry = { ...session, hookRegistry: registry, sessionId: 's' };
    const { ctx, lines } = makeCtx(sessionWithRegistry as unknown as typeof session);

    await getCompactCmd().handler(ctx, '');

    expect(session.compact).not.toHaveBeenCalled();
    // HookBlockedError thrown by handler surfaces as a block (fail-safe) -> skipped.
    const info = lines.find((l) => l.startsWith('INFO:'));
    expect(info).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// H1: route the progress indicator through the compositor's in-frame
// spinner instead of a bare ora, so a single frame owns both the spinner
// row and the input line (see terminal-compositor.ts:~800 for the ora-vs-
// compositor region-tracking race this avoids).
// ---------------------------------------------------------------------------

describe('/compact spinner routing (H1: compositor vs. bare ora)', () => {
  beforeEach(() => {
    oraFactory.mockClear();
  });

  it('with a compositor: enables then disables the in-frame spinner and never constructs ora', async () => {
    const session = fakeSession();
    session.compact.mockResolvedValue({
      compacted: true,
      messagesBefore: 10,
      messagesAfter: 4,
    });
    const { ctx, setSpinner } = makeCtxWithCompositor(session);

    await getCompactCmd().handler(ctx, '');

    expect(setSpinner).toHaveBeenCalledTimes(2);
    expect(setSpinner).toHaveBeenNthCalledWith(1, { enabled: true });
    expect(setSpinner).toHaveBeenNthCalledWith(2, { enabled: false });
    expect(oraFactory).not.toHaveBeenCalled();
  });

  it('without a compositor (getCompositor absent): falls back to the bare-ora path unchanged', async () => {
    const session = fakeSession();
    session.compact.mockResolvedValue({
      compacted: true,
      messagesBefore: 10,
      messagesAfter: 4,
    });
    const { ctx } = makeCtx(session); // no getCompositor at all
    expect(ctx.getCompositor).toBeUndefined();

    await getCompactCmd().handler(ctx, '');

    expect(oraFactory).toHaveBeenCalledTimes(1);
    const instance = oraFactory.mock.results[0]?.value as { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    expect(instance.start).toHaveBeenCalledTimes(1);
    expect(instance.stop).toHaveBeenCalledTimes(1);
  });

  it('without a compositor (getCompositor returns null): falls back to the bare-ora path unchanged', async () => {
    const session = fakeSession();
    session.compact.mockResolvedValue({
      compacted: true,
      messagesBefore: 10,
      messagesAfter: 4,
    });
    const { ctx } = makeCtx(session);
    ctx.getCompositor = () => null;

    await getCompactCmd().handler(ctx, '');

    expect(oraFactory).toHaveBeenCalledTimes(1);
    const instance = oraFactory.mock.results[0]?.value as { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    expect(instance.stop).toHaveBeenCalledTimes(1);
  });

  it('disables the in-frame spinner even when session.compact() rejects', async () => {
    const session = fakeSession();
    session.compact.mockRejectedValue(new Error('compact blew up'));
    const { ctx, setSpinner, lines } = makeCtxWithCompositor(session);

    await getCompactCmd().handler(ctx, '');

    expect(setSpinner).toHaveBeenCalledTimes(2);
    expect(setSpinner).toHaveBeenNthCalledWith(1, { enabled: true });
    expect(setSpinner).toHaveBeenNthCalledWith(2, { enabled: false });
    expect(oraFactory).not.toHaveBeenCalled();
    expect(lines.find((l) => l.startsWith('ERROR:'))).toContain('compact blew up');
  });

  it('disables the in-frame spinner when the PreCompact hook blocks (HookBlockedError path)', async () => {
    const session = fakeSession();
    const registry = createHookRegistry();
    registry.register('PreCompact', async () => ({
      decision: 'block' as const,
      reason: 'frozen',
    }));
    const sessionWithRegistry = { ...session, hookRegistry: registry, sessionId: 'test-sess' };
    const { ctx, setSpinner } = makeCtxWithCompositor(sessionWithRegistry as unknown as typeof session);

    const result = await getCompactCmd().handler(ctx, '');

    expect(result).toBe('continue');
    expect(session.compact).not.toHaveBeenCalled();
    expect(setSpinner).toHaveBeenCalledTimes(2);
    expect(setSpinner).toHaveBeenNthCalledWith(1, { enabled: true });
    expect(setSpinner).toHaveBeenNthCalledWith(2, { enabled: false });
  });

  it('disables the in-frame spinner and rethrows on AbortError', async () => {
    const session = fakeSession();
    session.compact.mockRejectedValue(new AbortError('user cancelled'));
    const { ctx, setSpinner } = makeCtxWithCompositor(session);

    await expect(getCompactCmd().handler(ctx, '')).rejects.toBeInstanceOf(AbortError);

    expect(setSpinner).toHaveBeenCalledTimes(2);
    expect(setSpinner).toHaveBeenNthCalledWith(1, { enabled: true });
    expect(setSpinner).toHaveBeenNthCalledWith(2, { enabled: false });
  });

  it('with a compositor: still disables the spinner on every !result.compacted branch', async () => {
    const reasons = [
      'aborted',
      'summarization-failed: x',
      'microcompacted',
      'nothing-to-summarize',
      'not-supported',
      'responses-compaction-unavailable',
      'some-unknown-reason',
    ];
    for (const reason of reasons) {
      oraFactory.mockClear();
      const session = fakeSession();
      session.compact.mockResolvedValue({
        compacted: false,
        reason,
        messagesBefore: 2,
        messagesAfter: 2,
      });
      const { ctx, setSpinner } = makeCtxWithCompositor(session);

      await getCompactCmd().handler(ctx, '');

      expect(setSpinner).toHaveBeenCalledTimes(2);
      expect(setSpinner).toHaveBeenNthCalledWith(1, { enabled: true });
      expect(setSpinner).toHaveBeenNthCalledWith(2, { enabled: false });
      expect(oraFactory).not.toHaveBeenCalled();
    }
  });
});
