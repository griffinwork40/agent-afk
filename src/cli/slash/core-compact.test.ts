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
    planMode: false,
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
