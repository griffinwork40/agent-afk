import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTaskViewHandler } from './task-view-mid-turn.js';
import type { TurnHandles } from './shared.js';

// ---------------------------------------------------------------------------
// createTaskViewHandler
// ---------------------------------------------------------------------------

describe('createTaskViewHandler', () => {
  it('returns null when getCompositor returns null (non-TTY)', () => {
    const h: Pick<TurnHandles, 'getCompositor' | 'setTaskViewHandler'> = {
      getCompositor: () => null,
      setTaskViewHandler: vi.fn(),
    };
    expect(createTaskViewHandler(h)).toBeNull();
  });

  it('returns null when getCompositor is undefined', () => {
    const h: Pick<TurnHandles, 'getCompositor' | 'setTaskViewHandler'> = {
      setTaskViewHandler: vi.fn(),
    };
    expect(createTaskViewHandler(h)).toBeNull();
  });

  it('returns a function when compositor is available', () => {
    const compositor = { stdout: process.stdout } as never;
    const h: Pick<TurnHandles, 'getCompositor' | 'setTaskViewHandler'> = {
      getCompositor: () => compositor,
      setTaskViewHandler: vi.fn(),
    };
    const handler = createTaskViewHandler(h);
    expect(handler).toBeTypeOf('function');
  });

  it('handler is a no-op when tasks manager is not wired', () => {
    const compositor = {
      stdout: process.stdout,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    } as never;
    const h: Pick<TurnHandles, 'getCompositor' | 'setTaskViewHandler'> = {
      getCompositor: () => compositor,
      setTaskViewHandler: vi.fn(),
    };
    const handler = createTaskViewHandler(h)!;
    // Should not throw when tasks manager is not registered.
    expect(() => handler()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tab dispatch integration (KeyDispatchHost.onTaskView)
// ---------------------------------------------------------------------------

describe('Tab dispatch integration', () => {
  let dispatchKey: typeof import('../../terminal-compositor.input-dispatch.js').dispatchKey;

  beforeEach(async () => {
    ({ dispatchKey } = await import('../../terminal-compositor.input-dispatch.js'));
  });

  it('fires onTaskView in streaming mode when Tab is pressed', () => {
    const onTaskView = vi.fn();
    const host = makeHost({ inputMode: 'streaming', onTaskView });
    dispatchKey(host, '\t', { name: 'tab', sequence: '\t' } as never);
    expect(onTaskView).toHaveBeenCalledOnce();
  });

  it('does not fire onTaskView in idle mode', () => {
    const onTaskView = vi.fn();
    const host = makeHost({ inputMode: 'idle', onTaskView });
    dispatchKey(host, '\t', { name: 'tab', sequence: '\t' } as never);
    expect(onTaskView).not.toHaveBeenCalled();
  });

  it('does not fire onTaskView when handler is not wired', () => {
    const host = makeHost({ inputMode: 'streaming' });
    // Should not throw — Tab falls through to ghost-accept.
    expect(() =>
      dispatchKey(host, '\t', { name: 'tab', sequence: '\t' } as never),
    ).not.toThrow();
  });

  it('dropdown takes priority over onTaskView in streaming mode', () => {
    const onTaskView = vi.fn();
    const host = makeHost({
      inputMode: 'streaming',
      onTaskView,
      applyDropdownSelection: () => true, // dropdown consumed Tab
    });
    dispatchKey(host, '\t', { name: 'tab', sequence: '\t' } as never);
    expect(onTaskView).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeHost(
  overrides: Partial<import('../../terminal-compositor.input-dispatch.js').KeyDispatchHost> & {
    inputMode?: string;
    onTaskView?: () => void;
  } = {},
): import('../../terminal-compositor.input-dispatch.js').KeyDispatchHost {
  return {
    armed: true,
    input: { buffer: '', cursor: 0 } as never,
    queued: false,
    pendingSubmissions: [],
    inputMode: (overrides.inputMode ?? 'idle') as never,
    pickerController: null,
    pasting: false,
    pasteStartBufferLen: 0,
    pasteStartCursor: 0,
    pasteRegistry: new Map(),
    clipboardInFlight: false,
    clipboardFailureMsg: null,
    attachments: [],
    softStopped: false,
    lastIdleEscAt: 0,
    postEscCoalesce: false,
    postEscPayload: null,
    canceled: false,
    backgrounded: false,
    paused: false,
    repaint: vi.fn(),
    scheduleRepaint: vi.fn(),
    clearScreen: vi.fn(),
    applyEdit: vi.fn(() => true),
    updateAutocomplete: vi.fn(),
    updateGhost: vi.fn(),
    dismissPromptGhost: vi.fn(() => false),
    applyDropdownSelection: overrides.applyDropdownSelection ?? vi.fn(() => false),
    applyGhostAccept: vi.fn(),
    ...overrides,
  } as never;
}

// ---------------------------------------------------------------------------
// Width clamping — launchMidTurnTaskView content writes
// ---------------------------------------------------------------------------

describe('launchMidTurnTaskView width clamping', () => {
  it('clamps long subagent history lines to terminal width', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');

    // Collect every chunk written to our fake stdout.
    const written: string[] = [];
    const fakeStdout = {
      columns: 40,
      write: (s: string) => { written.push(s); return true; },
    };

    // A history line that is far wider than 40 columns.
    const longLine = 'A'.repeat(200);

    // Minimal fake session: non-empty history, immediate-complete stream.
    const fakeSession = {
      getHistory: () => [
        { role: 'assistant' as const, content: longLine },
      ],
      getOutputStream: async function* () {
        // yield nothing — subagent already done
      },
    };

    // Fake handle — already completed so the view returns immediately.
    const fakeHandle = {
      status: 'succeeded' as const,
      session: fakeSession,
      sendMessage: vi.fn(),
    };

    const fakeManager = {
      list: () => [{ id: 'sub-1', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };

    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    await launchMidTurnTaskView({
      manager: fakeManager as never,
      compositor: fakeCompositor as never,
    });

    // Every non-ANSI-only line written must be ≤ 40 visible characters.
    // We join all written chunks and split by newline, then check each line.
    const allOutput = written.join('');
    const lines = allOutput.split('\n');

    // Strip ANSI escape sequences for width measurement (CSI + OSC patterns).
    const stripAnsi = (s: string): string =>
      s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

    // Cursor-positioning sequences like \r\x1b[K (erase line) are fine —
    // they should not be clamped. Only visible content lines must be ≤ cols.
    for (const line of lines) {
      const visible = stripAnsi(line);
      // Skip empty lines and bare CR (cursor movement remnants).
      if (visible.replace(/\r/g, '').trim() === '') continue;
      // Skip the clear-screen line (\x1b[2J\x1b[H).
      if (line.includes('\x1b[2J')) continue;
      expect(visible.length).toBeLessThanOrEqual(40);
    }
  });

  it('does not clamp cursor-movement ANSI sequences (CSI codes)', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');

    const written: string[] = [];
    const fakeStdout = {
      columns: 40,
      write: (s: string) => { written.push(s); return true; },
    };

    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () {},
    };
    const fakeHandle = {
      status: 'succeeded' as const,
      session: fakeSession,
      sendMessage: vi.fn(),
    };
    const fakeManager = {
      list: () => [{ id: 'sub-2', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };
    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    await launchMidTurnTaskView({
      manager: fakeManager as never,
      compositor: fakeCompositor as never,
    });

    const allOutput = written.join('');
    // Cursor-movement sequences must still be present in the raw output.
    // The clear-screen + cursor-home sequence (\x1b[2J\x1b[H) is always written first.
    expect(allOutput).toContain('\x1b[2J\x1b[H');
  });
});
