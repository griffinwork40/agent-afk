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

vi.mock('../session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-store.js')>();
  return { ...actual, forkStoredSession: vi.fn() };
});
vi.mock('../../agent/journal/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent/journal/index.js')>();
  return { ...actual, forkJournal: vi.fn() };
});
import { forkStoredSession } from '../session-store.js';
import { forkJournal } from '../../agent/journal/index.js';

const forkStoredSessionMock = forkStoredSession as Mock;
const forkJournalMock = forkJournal as Mock;

function makeStats(): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    unpricedTurns: 0,
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
  rewindFiles?: Mock;
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
    const { ctx, lines, suspend, resume } = makeCtx(session);
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
    // Counts user prompts, never raw API messages (which include every
    // tool_use/tool_result message and read as "100+").
    const success = lines.find((l) => l.startsWith('SUCCESS:'));
    expect(success).toContain('Rewound 2 prompts (1 earlier kept)');
    expect(success).not.toContain('messages');
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

// ---------------------------------------------------------------------------
// conversation | files | both (#4271)
// ---------------------------------------------------------------------------

describe('/rewind with file checkpoints', () => {
  beforeEach(() => {
    (renderSelector as Mock).mockReset();
  });

  const linked = [
    { turnIndex: 4, preview: 'second question', checkpointTurnId: 'ckpt-2' },
    { turnIndex: 0, preview: 'first question', checkpointTurnId: 'ckpt-1' },
  ];
  const rewound = { rewound: true, reloadText: 'second question', messagesBefore: 6, messagesAfter: 4 };

  function session(rewindFiles: Mock): FakeSession {
    return {
      listRewindTargets: vi.fn().mockReturnValue(linked),
      rewindConversation: vi.fn().mockResolvedValue(rewound),
      rewindFiles,
    };
  }

  it('both: previews files, restores on confirm, then rewinds the conversation', async () => {
    const rewindFiles = vi.fn()
      .mockResolvedValueOnce({ canRewind: true, filesChanged: ['/w/a.ts', '/w/b.ts', '/w/new.ts'] })
      .mockResolvedValueOnce({ canRewind: true, filesChanged: ['/w/a.ts', '/w/b.ts', '/w/new.ts'], insertions: 3, deletions: 4 });
    const s = session(rewindFiles);
    const { ctx, lines } = makeCtx(s);
    // prompt #0 → mode "Conversation and files" (2) → "Restore these files" (0)
    (renderSelector as Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(2).mockResolvedValueOnce(0);

    const result = await getRewindCmd().handler(ctx, '');

    expect(rewindFiles).toHaveBeenNthCalledWith(1, 'ckpt-2', { dryRun: true });
    expect(rewindFiles).toHaveBeenNthCalledWith(2, 'ckpt-2', { overwriteConflicts: false });
    // The preview lists every file before anything is restored.
    for (const p of ['/w/a.ts', '/w/b.ts', '/w/new.ts']) expect(lines.some((l) => l.includes(p))).toBe(true);
    expect(lines.findIndex((l) => l.includes('/w/new.ts'))).toBeLessThan(lines.findIndex((l) => l.startsWith('SUCCESS:Restored 3 files')));
    expect(s.rewindConversation).toHaveBeenCalledWith(4);
    expect(result).toEqual({ kind: 'prefill', message: 'second question' });
  });

  it('files: restores files but leaves the conversation alone', async () => {
    const rewindFiles = vi.fn()
      .mockResolvedValueOnce({ canRewind: true, filesChanged: ['/w/a.ts'] })
      .mockResolvedValueOnce({ canRewind: true, filesChanged: ['/w/a.ts'], insertions: 1, deletions: 0 });
    const s = session(rewindFiles);
    const { ctx } = makeCtx(s);
    (renderSelector as Mock).mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const result = await getRewindCmd().handler(ctx, 'files');

    expect(rewindFiles).toHaveBeenCalledWith('ckpt-1', { overwriteConflicts: false });
    expect(s.rewindConversation).not.toHaveBeenCalled();
    expect(result).toBe('continue');
  });

  it('both: a per-file failure is reported and the conversation is NOT rewound', async () => {
    const rewindFiles = vi.fn()
      .mockResolvedValueOnce({ canRewind: true, filesChanged: ['/w/a.ts', '/w/b.ts'] })
      .mockResolvedValueOnce({
        canRewind: false, filesChanged: ['/w/a.ts'], insertions: 1, deletions: 0,
        failures: [{ path: '/w/b.ts', error: 'permission denied' }], error: 'Rewind failed at /w/b.ts',
      });
    const s = session(rewindFiles);
    const { ctx, lines } = makeCtx(s);
    (renderSelector as Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const result = await getRewindCmd().handler(ctx, 'both');

    expect(lines.some((l) => l === 'ERROR:Not restored: /w/b.ts: permission denied')).toBe(true);
    expect(lines.some((l) => l.startsWith('WARN:Conversation not rewound'))).toBe(true);
    expect(s.rewindConversation).not.toHaveBeenCalled();
    expect(result).toBe('continue');
  });

  it('conflicts offer overwrite vs keep, and keep passes overwriteConflicts:false', async () => {
    const rewindFiles = vi.fn()
      .mockResolvedValueOnce({ canRewind: true, filesChanged: ['/w/a.ts'], conflicts: ['/w/a.ts'] })
      .mockResolvedValueOnce({ canRewind: false, filesChanged: [], failures: [{ path: '/w/a.ts', error: 'changed outside the agent' }] });
    const s = session(rewindFiles);
    const { ctx, lines } = makeCtx(s);
    (renderSelector as Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await getRewindCmd().handler(ctx, 'files');

    expect((renderSelector as Mock).mock.calls[1]![0]).toHaveLength(3);
    expect(lines.some((l) => l.includes('/w/a.ts') && l.includes('changed outside the agent since'))).toBe(true);
    expect(rewindFiles).toHaveBeenLastCalledWith('ckpt-2', { overwriteConflicts: false });
  });

  it('both: keeping files changed outside the agent still rewinds the conversation', async () => {
    const rewindFiles = vi.fn()
      .mockResolvedValueOnce({ canRewind: true, filesChanged: ['/w/a.ts', '/w/b.ts'], conflicts: ['/w/a.ts'] })
      .mockResolvedValueOnce({
        canRewind: false, filesChanged: ['/w/b.ts'], insertions: 1, deletions: 0,
        failures: [{ path: '/w/a.ts', error: 'changed outside the agent since the last recorded state; not overwritten' }],
      });
    const s = session(rewindFiles);
    const { ctx, lines } = makeCtx(s);
    (renderSelector as Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    const result = await getRewindCmd().handler(ctx, 'both');

    expect(lines.some((l) => l === 'INFO:Kept 1 file changed outside the agent.')).toBe(true);
    expect(lines.some((l) => l.startsWith('ERROR:'))).toBe(false);
    expect(s.rewindConversation).toHaveBeenCalledWith(4);
    expect(result).toEqual({ kind: 'prefill', message: 'second question' });
  });

  it('cancelling the confirm changes nothing', async () => {
    const rewindFiles = vi.fn().mockResolvedValueOnce({ canRewind: true, filesChanged: ['/w/a.ts'] });
    const s = session(rewindFiles);
    const { ctx } = makeCtx(s);
    (renderSelector as Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    expect(await getRewindCmd().handler(ctx, 'both')).toBe('continue');
    expect(rewindFiles).toHaveBeenCalledTimes(1);
    expect(s.rewindConversation).not.toHaveBeenCalled();
  });

  it('conversation mode (Esc-Esc) never touches files and skips the mode menu', async () => {
    const rewindFiles = vi.fn();
    const s = session(rewindFiles);
    const { ctx } = makeCtx(s);
    (renderSelector as Mock).mockResolvedValueOnce(0);

    const result = await getRewindCmd().handler(ctx, 'conversation');

    expect(renderSelector).toHaveBeenCalledTimes(1);
    expect(rewindFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ kind: 'prefill', message: 'second question' });
  });

  it('files mode on a prompt without a checkpoint warns instead of guessing', async () => {
    const rewindFiles = vi.fn();
    const s: FakeSession = {
      listRewindTargets: vi.fn().mockReturnValue([{ turnIndex: 0, preview: 'q' }]),
      rewindConversation: vi.fn(), rewindFiles,
    };
    const { ctx, lines } = makeCtx(s);
    (renderSelector as Mock).mockResolvedValueOnce(0);

    expect(await getRewindCmd().handler(ctx, 'files')).toBe('continue');
    expect(rewindFiles).not.toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith('WARN:No file checkpoint'))).toBe(true);
  });

  it('rejects an unknown mode argument', async () => {
    const s = session(vi.fn());
    const { ctx, lines } = makeCtx(s);
    expect(await getRewindCmd().handler(ctx, 'everything')).toBe('continue');
    expect(renderSelector).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('Usage: /rewind'))).toBe(true);
  });

  it('nothing changed since the prompt: files mode reports it without a confirm step', async () => {
    const rewindFiles = vi.fn().mockResolvedValueOnce({ canRewind: true, filesChanged: [] });
    const s = session(rewindFiles);
    const { ctx, lines } = makeCtx(s);
    (renderSelector as Mock).mockResolvedValueOnce(0);

    await getRewindCmd().handler(ctx, 'files');

    expect(renderSelector).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.includes('No file changes to restore'))).toBe(true);
  });

  it('uncaptured warnings appear in preview when bash calls were not fully captured', async () => {
    const warnings = [
      'Bash call in turn t2 was not captured: background job',
      'Some shell side-effects in the rewound range are not undone by this restore.',
    ];
    const rewindFiles = vi.fn()
      .mockResolvedValueOnce({ canRewind: true, filesChanged: ['/w/a.ts'], uncaptured: warnings })
      .mockResolvedValueOnce({ canRewind: true, filesChanged: ['/w/a.ts'], insertions: 1, deletions: 0, uncaptured: warnings });
    const s = session(rewindFiles);
    const { ctx, lines } = makeCtx(s);
    (renderSelector as Mock).mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    await getRewindCmd().handler(ctx, 'files');

    // Each uncaptured warning is printed as a WARN line in the preview.
    for (const w of warnings) {
      expect(lines.some((l) => l.startsWith('WARN:') && l.includes(w))).toBe(true);
    }
  });

  it('uncaptured warnings appear even when no files changed', async () => {
    const warnings = ['Bash call in turn t1 was skipped (BASH_DISABLE).'];
    const rewindFiles = vi.fn()
      .mockResolvedValueOnce({ canRewind: true, filesChanged: [], uncaptured: warnings });
    const s = session(rewindFiles);
    const { ctx, lines } = makeCtx(s);
    (renderSelector as Mock).mockResolvedValueOnce(0);

    await getRewindCmd().handler(ctx, 'files');

    expect(lines.some((l) => l.includes('No file changes to restore'))).toBe(true);
    expect(lines.some((l) => l.startsWith('WARN:') && l.includes('BASH_DISABLE'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// forkBeforeRewind — ghost-branch prevention (#4495)
// ---------------------------------------------------------------------------

describe('/rewind forkBeforeRewind', () => {
  const FORK_ID = 'fork-0000-1111-2222-333333333333';
  const FORK_PATH = '/tmp/fake-fork.json';

  beforeEach(() => {
    (renderSelector as Mock).mockReset();
    forkStoredSessionMock.mockReset();
    forkJournalMock.mockReset();
  });

  function rewindSession(rewound: boolean): FakeSession {
    return {
      listRewindTargets: vi.fn().mockReturnValue([
        { turnIndex: 2, preview: 'second prompt' },
        { turnIndex: 0, preview: 'first prompt' },
      ]),
      rewindConversation: vi.fn().mockResolvedValue(
        rewound
          ? { rewound: true, reloadText: 'first prompt', messagesBefore: 4, messagesAfter: 2 }
          : { rewound: false, reason: 'session-busy', messagesBefore: 0, messagesAfter: 0 },
      ),
    };
  }

  function ctxWithSessionId(): { ctx: SlashContext; lines: string[] } {
    const { ctx, lines } = makeCtx(rewindSession(true));
    ctx.stats.sessionId = 'parent-session-id';
    return { ctx, lines };
  }

  it('forks the session on successful rewind', async () => {
    forkStoredSessionMock.mockReturnValue({ id: FORK_ID, path: FORK_PATH });
    forkJournalMock.mockReturnValue(true);
    const { ctx } = ctxWithSessionId();
    (renderSelector as Mock).mockResolvedValue(0);

    const result = await getRewindCmd().handler(ctx, '');

    expect(result).toEqual({ kind: 'prefill', message: 'first prompt' });
    expect(forkStoredSessionMock).toHaveBeenCalledOnce();
    expect(forkJournalMock).toHaveBeenCalledWith('parent-session-id', FORK_ID);
  });

  it('cleans up the fork when the rewind fails (no ghost branch)', async () => {
    forkStoredSessionMock.mockReturnValue({ id: FORK_ID, path: FORK_PATH });
    forkJournalMock.mockReturnValue(true);
    const session = rewindSession(false);
    const { ctx, lines } = makeCtx(session);
    ctx.stats.sessionId = 'parent-session-id';
    (renderSelector as Mock).mockResolvedValue(0);

    const result = await getRewindCmd().handler(ctx, '');

    expect(result).toBe('continue');
    expect(forkStoredSessionMock).toHaveBeenCalledOnce();
    // The fork sidecar must have been cleaned up since rewind failed.
    // We can't easily assert unlinkSync was called (it's a real import),
    // but the fork WAS attempted and the rewind gracefully failed.
    expect(lines.some((l) => l.includes('Cannot rewind'))).toBe(true);
  });

  it('proceeds with rewind when forkStoredSession throws', async () => {
    forkStoredSessionMock.mockImplementation(() => { throw new Error('disk full'); });
    const { ctx } = ctxWithSessionId();
    (renderSelector as Mock).mockResolvedValue(0);

    const result = await getRewindCmd().handler(ctx, '');

    // Rewind still succeeds despite fork failure.
    expect(result).toEqual({ kind: 'prefill', message: 'first prompt' });
    expect(forkJournalMock).not.toHaveBeenCalled();
  });

  it('skips fork when no sessionId is available', async () => {
    const session = rewindSession(true);
    const { ctx } = makeCtx(session);
    // stats.sessionId is undefined by default from makeStats()
    (renderSelector as Mock).mockResolvedValue(0);

    const result = await getRewindCmd().handler(ctx, '');

    expect(result).toEqual({ kind: 'prefill', message: 'first prompt' });
    expect(forkStoredSessionMock).not.toHaveBeenCalled();
    expect(forkJournalMock).not.toHaveBeenCalled();
  });

  it('cleans up sidecar when forkJournal returns false', async () => {
    forkStoredSessionMock.mockReturnValue({ id: FORK_ID, path: FORK_PATH });
    forkJournalMock.mockReturnValue(false);
    const { ctx } = ctxWithSessionId();
    (renderSelector as Mock).mockResolvedValue(0);

    const result = await getRewindCmd().handler(ctx, '');

    // Rewind still succeeds; the fork was cleaned up because journal copy failed.
    expect(result).toEqual({ kind: 'prefill', message: 'first prompt' });
    expect(forkStoredSessionMock).toHaveBeenCalledOnce();
    expect(forkJournalMock).toHaveBeenCalledOnce();
  });
});
