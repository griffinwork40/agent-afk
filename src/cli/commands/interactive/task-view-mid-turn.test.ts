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

// ---------------------------------------------------------------------------
// renderPrompt suffix viewport (issue #1477)
// ---------------------------------------------------------------------------

describe('renderPrompt suffix viewport', () => {
  /**
   * Drive the raw stdin `onData` handler by injecting keypresses into the
   * process.stdin event listeners, then capture what was written to stdout.
   *
   * We need launchMidTurnTaskView to be running but we short-circuit the
   * stream immediately by providing a session that yields no events. We then
   * send keypress data via process.stdin before the stream ends so the
   * renderPrompt path is exercised.
   *
   * Strategy: spy on process.stdin.on to capture the 'data' listener, call
   * it manually with typed bytes, then let the stream finish.
   */
  it('renders a suffix viewport when inputBuf exceeds terminal width', async () => {
    // Use a very narrow terminal (10 columns) to make overflow easy to trigger.
    const COLS = 10;
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');

    const written: string[] = [];
    const fakeStdout = {
      columns: COLS,
      write: (s: string) => { written.push(s); return true; },
    };

    // Capture the 'data' listener that onData registers on process.stdin.
    let capturedDataListener: ((data: Buffer) => void) | null = null;
    const origOn = process.stdin.on.bind(process.stdin);
    const origRemoveListener = process.stdin.removeListener.bind(process.stdin);
    vi.spyOn(process.stdin, 'on').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data') capturedDataListener = listener as (d: Buffer) => void;
      return origOn(event as never, listener as never);
    });
    vi.spyOn(process.stdin, 'removeListener').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      return origRemoveListener(event as never, listener as never);
    });

    // Session with no history and a stream that emits one event then closes.
    // We intercept after the first event to inject keystrokes before Esc.
    let resolveStream!: () => void;
    const streamDone = new Promise<void>((r) => { resolveStream = r; });

    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () {
        // Give the onData listener a chance to register, then inject typing.
        await new Promise<void>((r) => setTimeout(r, 5));
        if (capturedDataListener) {
          // Type a string longer than COLS (10), e.g. "Hello World!!!" (14 chars)
          capturedDataListener(Buffer.from('Hello World!!!'));
        }
        resolveStream();
        // Yield nothing — stream ends immediately after typing injection.
      },
    };

    const fakeHandle = {
      status: 'running' as const,
      session: fakeSession,
      sendMessage: vi.fn(),
    };
    const fakeManager = {
      list: () => [{ id: 'sub-vp', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };
    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    // Trigger Esc after stream done to allow launchMidTurnTaskView to exit.
    void streamDone.then(() => {
      if (capturedDataListener) capturedDataListener(Buffer.from('\x1b'));
    });

    await launchMidTurnTaskView({
      manager: fakeManager as never,
      compositor: fakeCompositor as never,
    });

    vi.restoreAllMocks();

    // Find any renderPrompt write: lines starting with \r\x1b[K followed by
    // the prompt prefix (palette.dim renders "> " with ANSI codes).
    const promptWrites = written.filter((s) => s.startsWith('\r\x1b[K'));

    // At least one renderPrompt write should have happened after typing.
    expect(promptWrites.length).toBeGreaterThan(0);

    // Strip ANSI from a prompt write and verify it fits within COLS.
    const stripAnsi = (s: string): string =>
      s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

    // The last renderPrompt write is the one after the long text was typed.
    const lastPrompt = promptWrites[promptWrites.length - 1]!;
    const visible = stripAnsi(lastPrompt).replace(/\r/g, '');

    // Total visible characters must fit within COLS (the terminal width).
    expect(visible.length).toBeLessThanOrEqual(COLS);

    // The visible content must contain the ellipsis character to signal
    // left-truncation occurred (since "Hello World!!!" is 14 chars > 8 available).
    expect(visible).toContain('…');

    // The tail of the input ("d!!!" or similar) must be visible at the end.
    // The input "Hello World!!!" truncated to 8 chars from the right (budget=8)
    // gives " World!!" → with "…" prefix = "… World!!".
    expect(visible.endsWith('!!!')).toBe(true);
  });

  it('does not add ellipsis when input fits within the terminal width', async () => {
    const COLS = 40;
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');

    const written: string[] = [];
    const fakeStdout = {
      columns: COLS,
      write: (s: string) => { written.push(s); return true; },
    };

    let capturedDataListener: ((data: Buffer) => void) | null = null;
    const origOn = process.stdin.on.bind(process.stdin);
    const origRemoveListener = process.stdin.removeListener.bind(process.stdin);
    vi.spyOn(process.stdin, 'on').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data') capturedDataListener = listener as (d: Buffer) => void;
      return origOn(event as never, listener as never);
    });
    vi.spyOn(process.stdin, 'removeListener').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      return origRemoveListener(event as never, listener as never);
    });

    let resolveStream!: () => void;
    const streamDone = new Promise<void>((r) => { resolveStream = r; });

    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () {
        await new Promise<void>((r) => setTimeout(r, 5));
        if (capturedDataListener) {
          // Short input — well within 40-column terminal (available=38).
          capturedDataListener(Buffer.from('hello'));
        }
        resolveStream();
      },
    };

    const fakeHandle = {
      status: 'running' as const,
      session: fakeSession,
      sendMessage: vi.fn(),
    };
    const fakeManager = {
      list: () => [{ id: 'sub-short', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };
    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    void streamDone.then(() => {
      if (capturedDataListener) capturedDataListener(Buffer.from('\x1b'));
    });

    await launchMidTurnTaskView({
      manager: fakeManager as never,
      compositor: fakeCompositor as never,
    });

    vi.restoreAllMocks();

    const stripAnsi = (s: string): string =>
      s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

    const promptWrites = written.filter((s) => s.startsWith('\r\x1b[K'));
    expect(promptWrites.length).toBeGreaterThan(0);

    const lastPrompt = promptWrites[promptWrites.length - 1]!;
    const visible = stripAnsi(lastPrompt).replace(/\r/g, '');

    // No ellipsis — short input renders as-is.
    expect(visible).not.toContain('…');
    // The full text is visible.
    expect(visible).toContain('hello');
  });
});
