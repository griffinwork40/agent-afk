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
    applyGhostWordAccept: vi.fn(),
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
// Content chunk buffering (streaming word-wrap fix)
// ---------------------------------------------------------------------------

describe('content chunk buffering', () => {
  it('joins streaming content chunks into continuous lines instead of one-word-per-line', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');

    const written: string[] = [];
    const fakeStdout = {
      columns: 80,
      write: (s: string) => { written.push(s); return true; },
    };

    // Capture the stdin 'data' listener so we can send Esc after the stream.
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

    // Simulate streaming token deltas: the model sends a few words per chunk.
    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () {
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: "I'll start" } };
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: ' by running' } };
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: ' a ground-state' } };
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: ' reconnaissance' } };
        // A newline in the stream triggers a line break.
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: '\nSecond line here' } };
        resolveStream();
      },
    };

    const fakeHandle = {
      status: 'running' as const,
      session: fakeSession,
      sendMessage: vi.fn(),
    };

    const fakeManager = {
      list: () => [{ id: 'sub-buf1', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };

    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    // Send Esc after the stream finishes so launchMidTurnTaskView exits.
    void streamDone.then(() => {
      setTimeout(() => {
        if (capturedDataListener) capturedDataListener(Buffer.from('\x1b'));
      }, 10);
    });

    await launchMidTurnTaskView({
      manager: fakeManager as never,
      compositor: fakeCompositor as never,
    });

    vi.restoreAllMocks();

    const allOutput = written.join('');

    // The full sentence should appear as one flushed line, not split per chunk.
    expect(allOutput).toContain("I'll start by running a ground-state reconnaissance");
    // The second line (after the embedded newline) should also be present.
    expect(allOutput).toContain('Second line here');

    // Critically: the words should NOT each be on separate lines.
    const lines = allOutput.split('\n');
    const singleWordLines = lines.filter(l => {
      const stripped = l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').trim();
      return stripped === "I'll start" || stripped === 'by running' || stripped === 'a ground-state';
    });
    expect(singleWordLines).toHaveLength(0);
  });

  it('flushes buffered content before non-content events', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');

    const written: string[] = [];
    const fakeStdout = {
      columns: 80,
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
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'Some text here' } };
        // A tool_use_detail event should cause the buffered content to flush first.
        yield { type: 'chunk' as const, chunk: { type: 'tool_use_detail' as const, toolUseId: 'tu-1', toolName: 'bash', toolInput: '{}' } };
        resolveStream();
      },
    };

    const fakeHandle = {
      status: 'running' as const,
      session: fakeSession,
      sendMessage: vi.fn(),
    };

    const fakeManager = {
      list: () => [{ id: 'sub-buf2', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };

    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    void streamDone.then(() => {
      setTimeout(() => {
        if (capturedDataListener) capturedDataListener(Buffer.from('\x1b'));
      }, 10);
    });

    await launchMidTurnTaskView({
      manager: fakeManager as never,
      compositor: fakeCompositor as never,
    });

    vi.restoreAllMocks();

    const allOutput = written.join('');
    // The buffered content line should appear before the tool badge.
    const contentIdx = allOutput.indexOf('Some text here');
    const toolIdx = allOutput.indexOf('[tool: bash]');
    expect(contentIdx).toBeGreaterThan(-1);
    expect(toolIdx).toBeGreaterThan(-1);
    expect(contentIdx).toBeLessThan(toolIdx);
  });

  it('resets lineBuf on stream_retry without flushing pre-retry content', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');

    const written: string[] = [];
    const fakeStdout = {
      columns: 80,
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
        // Pre-retry content accumulates in lineBuf (no newline yet).
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'Hello world' } };
        // stream_retry: model re-streams from scratch — buffer must be discarded.
        yield { type: 'stream_retry' as const };
        // Post-retry content starts fresh.
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'Fresh start\n' } };
        resolveStream();
      },
    };

    const fakeHandle = {
      status: 'running' as const,
      session: fakeSession,
      sendMessage: vi.fn(),
    };

    const fakeManager = {
      list: () => [{ id: 'sub-retry', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };

    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    void streamDone.then(() => {
      setTimeout(() => {
        if (capturedDataListener) capturedDataListener(Buffer.from('\x1b'));
      }, 10);
    });

    await launchMidTurnTaskView({
      manager: fakeManager as never,
      compositor: fakeCompositor as never,
    });

    vi.restoreAllMocks();

    const allOutput = written.join('');

    const stripAnsi = (s: string): string =>
      s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, '');

    // A flushed line is one that was explicitly committed with a trailing \n.
    // The live preview of "Hello world" has NO trailing \n — it is written as
    // `\r\x1b[K${lineBuf}` (no newline). When the buffer is reset on
    // stream_retry, the next write overwrites that preview row. We detect a
    // standalone flush of "Hello world" by looking for the pattern
    // `\r\x1b[K<content>\n` — i.e. a line that ended with \n without the
    // post-retry text appearing on the same terminal row.
    //
    // Split on \n first, then check each segment: a segment is a "flushed" line
    // only if it does NOT also contain the post-retry text (which would mean
    // the pre-retry preview and the post-retry flush are on the same segment).
    const segments = allOutput.split('\n');
    const hasPreRetryAsStandaloneFlushed = segments.some(seg => {
      const vis = stripAnsi(seg);
      return vis.includes('Hello world') && !vis.includes('Fresh start');
    });
    // Pre-retry text must NOT appear as a standalone flushed line.
    expect(hasPreRetryAsStandaloneFlushed).toBe(false);

    // Post-retry text MUST appear as a flushed line.
    const hasPostRetry = segments.some(l => stripAnsi(l).includes('Fresh start'));
    expect(hasPostRetry).toBe(true);
  });

  it('does not emit spurious blank lines for null-returning non-content events', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');

    const written: string[] = [];
    const fakeStdout = {
      columns: 80,
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
        // tool_result chunks return null from formatOutputEvent — should not
        // produce blank lines when lineBuf is empty.
        yield { type: 'chunk' as const, chunk: { type: 'tool_result' as const, toolUseId: 'tu-1', output: 'ok' } };
        yield { type: 'chunk' as const, chunk: { type: 'tool_result' as const, toolUseId: 'tu-2', output: 'ok' } };
        resolveStream();
      },
    };

    const fakeHandle = {
      status: 'running' as const,
      session: fakeSession,
      sendMessage: vi.fn(),
    };

    const fakeManager = {
      list: () => [{ id: 'sub-nullevt', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };

    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    void streamDone.then(() => {
      setTimeout(() => {
        if (capturedDataListener) capturedDataListener(Buffer.from('\x1b'));
      }, 10);
    });

    await launchMidTurnTaskView({
      manager: fakeManager as never,
      compositor: fakeCompositor as never,
    });

    vi.restoreAllMocks();

    const allOutput = written.join('');
    const stripAnsi = (s: string): string =>
      s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, '');

    // Count blank lines (segments that are empty after stripping ANSI).
    // The header/footer contribute some lines; null-returning events must NOT
    // add additional blank lines.
    const visibleLines = allOutput.split('\n').map(l => stripAnsi(l));
    const blankCount = visibleLines.filter(l => l === '').length;
    // Without the guard, each null event would add a blank line (2 extra).
    // With the guard, these events produce no output at all.
    // Allow a baseline of blanks from the header/footer (typically ~5-8).
    // The key assertion: no 'tool_result' text appears, and blank count is
    // within the header/footer baseline.
    expect(allOutput).not.toContain('tool_result');
    expect(blankCount).toBeLessThan(10);
  });

  it('preserves blank lines from consecutive model-intended newlines', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');

    const written: string[] = [];
    const fakeStdout = {
      columns: 80,
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
        // Double newline: paragraph break with blank line between.
        yield { type: 'chunk' as const, chunk: { type: 'content' as const, content: 'Para one\n\nPara two\n' } };
        resolveStream();
      },
    };

    const fakeHandle = {
      status: 'running' as const,
      session: fakeSession,
      sendMessage: vi.fn(),
    };

    const fakeManager = {
      list: () => [{ id: 'sub-dblnl', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };

    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    void streamDone.then(() => {
      setTimeout(() => {
        if (capturedDataListener) capturedDataListener(Buffer.from('\x1b'));
      }, 10);
    });

    await launchMidTurnTaskView({
      manager: fakeManager as never,
      compositor: fakeCompositor as never,
    });

    vi.restoreAllMocks();

    const allOutput = written.join('');

    // Both paragraphs must appear.
    expect(allOutput).toContain('Para one');
    expect(allOutput).toContain('Para two');

    // The blank line between paragraphs must be preserved. Look for the
    // pattern: "Para one" on a line, then an empty line, then "Para two".
    const stripAnsi = (s: string): string =>
      s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, '');
    const lines = allOutput.split('\n').map(l => stripAnsi(l));
    const paraOneIdx = lines.findIndex(l => l.includes('Para one'));
    const paraTwoIdx = lines.findIndex(l => l.includes('Para two'));
    expect(paraOneIdx).toBeGreaterThan(-1);
    expect(paraTwoIdx).toBeGreaterThan(-1);
    // There should be at least one blank line between them.
    expect(paraTwoIdx - paraOneIdx).toBeGreaterThanOrEqual(2);
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

  // -------------------------------------------------------------------------
  // Item 3: backspace with multi-byte (emoji / CJK) input
  // -------------------------------------------------------------------------
  it('backspace removes the entire emoji grapheme, not just one byte', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');

    const written: string[] = [];
    const fakeStdout = {
      columns: 40,
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

    // Sequence: type "hi🙂", then backspace (\x7f), then Esc.
    // After the backspace the emoji must be fully gone — "hi" remains.
    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () {
        await new Promise<void>((r) => setTimeout(r, 5));
        if (capturedDataListener) {
          capturedDataListener(Buffer.from('hi🙂'));  // type emoji
          capturedDataListener(Buffer.from('\x7f'));  // backspace
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
      list: () => [{ id: 'sub-bs', status: 'running' as const }],
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

    // The last renderPrompt write reflects the state after the backspace.
    const promptWrites = written.filter((s) => s.startsWith('\r\x1b[K'));
    expect(promptWrites.length).toBeGreaterThan(0);
    const lastPrompt = promptWrites[promptWrites.length - 1]!;
    const visible = stripAnsi(lastPrompt).replace(/\r/g, '');

    // Emoji must be fully gone.
    expect(visible).not.toContain('🙂');
    // "hi" and the prompt prefix should still be present.
    expect(visible).toContain('hi');
  });

  // -------------------------------------------------------------------------
  // Item 4: incremental per-keypress character accumulation
  // -------------------------------------------------------------------------
  it('accumulates characters sent one byte at a time and renders the suffix viewport correctly', async () => {
    const COLS = 10;
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

    // Send "Hello!!!" one character at a time (8 keystrokes) into a 10-col terminal.
    // Available = 10 - 2 ("> ") = 8 cols, so the last char keeps fitting without
    // triggering the ellipsis, but if we send one more we should see truncation.
    const chars = 'Hello World'.split('');
    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () {
        await new Promise<void>((r) => setTimeout(r, 5));
        if (capturedDataListener) {
          for (const ch of chars) {
            capturedDataListener(Buffer.from(ch));
          }
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
      list: () => [{ id: 'sub-inc', status: 'running' as const }],
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
    // One renderPrompt call per keypress — at least 11 calls (one per character).
    expect(promptWrites.length).toBeGreaterThanOrEqual(chars.length);

    // The last write shows the final accumulated state; it must fit within COLS.
    const lastPrompt = promptWrites[promptWrites.length - 1]!;
    const visible = stripAnsi(lastPrompt).replace(/\r/g, '');
    expect(visible.length).toBeLessThanOrEqual(COLS);

    // "Hello World" is 11 chars > available (8), so the ellipsis must appear.
    expect(visible).toContain('…');
    // The tail ("orld") must be visible.
    expect(visible.endsWith('orld')).toBe(true);
  });
});
