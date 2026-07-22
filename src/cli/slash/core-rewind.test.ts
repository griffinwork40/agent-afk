/**
 * `/rewind` slash handler tests.
 *
 * Verifies the handler enumerates rewind targets, drives the arrow-key picker,
 * calls `session.rewindConversation(turnIndex)` for the chosen turn, and
 * returns a `{ kind: 'prefill' }` result carrying the discarded message's text
 * for reload-and-edit. Also covers the empty / cancel / not-supported paths.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { SlashCommand, SlashContext, SessionStats } from './types.js';
import { coreCommands } from './commands/core.js';

vi.mock('../input/selectors.js', () => ({
  renderSelector: vi.fn(),
  CUSTOM_ANSWER_SENTINEL: '\u270E Type your own answer',
}));
import { renderSelector } from '../input/selectors.js';

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
  listRewindTargets: Mock;
  rewindConversation: Mock;
}

function makeCtx(session: FakeSession): { ctx: SlashContext; lines: string[]; suspend: Mock; resume: Mock } {
  const lines: string[] = [];
  const suspend = vi.fn();
  const resume = vi.fn();
  const ctx: SlashContext = {
    session: { current: session } as unknown as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t): void => { lines.push(t); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    getCompositor: () =>
      ({ suspendInput: suspend, resumeInput: resume }) as unknown as ReturnType<
        NonNullable<SlashContext['getCompositor']>
      >,
  };
  return { ctx, lines, suspend, resume };
}

function getRewindCmd(): SlashCommand {
  const cmd = coreCommands.find((c) => c.name === '/rewind');
  if (!cmd) throw new Error('rewind command not registered');
  return cmd;
}

describe('/rewind slash handler', () => {
  beforeEach(() => {
    (renderSelector as Mock).mockReset();
  });

  it('is registered in coreCommands', () => {
    expect(coreCommands.some((c) => c.name === '/rewind')).toBe(true);
  });

  it('info + no picker when there is nothing to rewind to', async () => {
    const session: FakeSession = {
      listRewindTargets: vi.fn().mockReturnValue([]),
      rewindConversation: vi.fn(),
    };
    const { ctx, lines } = makeCtx(session);

    const result = await getRewindCmd().handler(ctx, '');

    expect(result).toBe('continue');
    expect(renderSelector).not.toHaveBeenCalled();
    expect(session.rewindConversation).not.toHaveBeenCalled();
    expect(lines.find((l) => l.startsWith('INFO:'))).toContain('Nothing to rewind');
  });

  it('rewinds to the chosen turn and returns a prefill result', async () => {
    const session: FakeSession = {
      listRewindTargets: vi.fn().mockReturnValue([
        { turnIndex: 6, preview: 'third question' },
        { turnIndex: 4, preview: 'second question' },
        { turnIndex: 0, preview: 'first question' },
      ]),
      rewindConversation: vi.fn().mockResolvedValue({
        rewound: true,
        reloadText: 'second question',
        messagesBefore: 8,
        messagesAfter: 4,
      }),
    };
    const { ctx, suspend, resume } = makeCtx(session);
    // Pick index 1 → the { turnIndex: 4 } target.
    (renderSelector as Mock).mockResolvedValue(1);

    const result = await getRewindCmd().handler(ctx, '');

    // Picker was fed the previews; compositor input suspended around it.
    expect(renderSelector).toHaveBeenCalledWith(
      ['third question', 'second question', 'first question'],
      expect.anything(),
    );
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(session.rewindConversation).toHaveBeenCalledWith(4);
    expect(result).toEqual({ kind: 'prefill', message: 'second question' });
  });

  it('cancelling the picker is a no-op', async () => {
    const session: FakeSession = {
      listRewindTargets: vi.fn().mockReturnValue([{ turnIndex: 0, preview: 'q' }]),
      rewindConversation: vi.fn(),
    };
    const { ctx, resume } = makeCtx(session);
    (renderSelector as Mock).mockResolvedValue(':cancel');

    const result = await getRewindCmd().handler(ctx, '');

    expect(result).toBe('continue');
    expect(session.rewindConversation).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledTimes(1); // input re-armed even on cancel
  });

  it('non-TTY picker (null) surfaces a friendly info line', async () => {
    const session: FakeSession = {
      listRewindTargets: vi.fn().mockReturnValue([{ turnIndex: 0, preview: 'q' }]),
      rewindConversation: vi.fn(),
    };
    const { ctx, lines } = makeCtx(session);
    (renderSelector as Mock).mockResolvedValue(null);

    const result = await getRewindCmd().handler(ctx, '');

    expect(result).toBe('continue');
    expect(session.rewindConversation).not.toHaveBeenCalled();
    expect(lines.find((l) => l.startsWith('INFO:'))).toContain('interactive terminal');
  });

  it('warns when the provider does not support rewind', async () => {
    const session: FakeSession = {
      listRewindTargets: vi.fn().mockReturnValue([{ turnIndex: 0, preview: 'q' }]),
      rewindConversation: vi.fn().mockResolvedValue({
        rewound: false,
        reason: 'not-supported',
        messagesBefore: 0,
        messagesAfter: 0,
      }),
    };
    const { ctx, lines } = makeCtx(session);
    (renderSelector as Mock).mockResolvedValue(0);

    const result = await getRewindCmd().handler(ctx, '');

    expect(result).toBe('continue');
    expect(lines.find((l) => l.startsWith('WARN:'))).toContain('not supported');
  });
});
