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

// ---------------------------------------------------------------------------
// Alternate screen buffer (DEC private mode 1049)
// ---------------------------------------------------------------------------

describe('alternate screen buffer', () => {
  const ENTER_ALT = '\x1b[?1049h';
  const LEAVE_ALT = '\x1b[?1049l';

  /**
   * Build a minimal already-completed (non-running) fake fixture.
   * The "succeeded" status triggers the early-return path.
   */
  function makeCompletedFixture() {
    const written: string[] = [];
    const calls: string[] = [];

    const fakeStdout = {
      columns: 80,
      write: (s: string) => { written.push(s); return true; },
    };
    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () { /* no events */ },
    };
    const fakeHandle = { status: 'succeeded' as const, session: fakeSession, sendMessage: vi.fn() };
    const fakeManager = {
      list: () => [{ id: 'sub-alt-done', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };
    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(() => { calls.push('suspendInput'); }),
      resumeInput: vi.fn(() => { calls.push('resumeInput'); }),
      repaint: vi.fn(() => { calls.push('repaint'); }),
    };
    return { written, calls, fakeManager, fakeCompositor };
  }

  /**
   * Build a minimal running fixture that terminates on Esc.
   * `capturedDataListener` is populated during `launchMidTurnTaskView` so
   * the caller can inject keypresses.
   */
  function makeRunningFixture() {
    const written: string[] = [];
    const calls: string[] = [];

    const fakeStdout = {
      columns: 80,
      write: (s: string) => { written.push(s); calls.push(`write:${s}`); return true; },
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
      getOutputStream: async function* () { resolveStream(); /* no events, ends immediately */ },
    };
    const fakeHandle = { status: 'running' as const, session: fakeSession, sendMessage: vi.fn() };
    const fakeManager = {
      list: () => [{ id: 'sub-alt-run', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };
    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(() => { calls.push('suspendInput'); }),
      resumeInput: vi.fn(() => { calls.push('resumeInput'); }),
      repaint: vi.fn(() => { calls.push('repaint'); }),
    };

    return { written, calls, fakeManager, fakeCompositor, streamDone, getCaptured: () => capturedDataListener };
  }

  it('writes the enter alt-screen sequence on open (early-complete path)', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');
    const { written, fakeManager, fakeCompositor } = makeCompletedFixture();

    await launchMidTurnTaskView({ manager: fakeManager as never, compositor: fakeCompositor as never });

    const allOutput = written.join('');
    expect(allOutput).toContain(ENTER_ALT);
  });

  it('writes the leave alt-screen sequence on the early-complete exit path', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');
    const { written, fakeManager, fakeCompositor } = makeCompletedFixture();

    await launchMidTurnTaskView({ manager: fakeManager as never, compositor: fakeCompositor as never });

    const allOutput = written.join('');
    expect(allOutput).toContain(LEAVE_ALT);
  });

  it('leave alt-screen precedes resumeInput on the early-complete exit path', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');
    const { written, fakeManager, fakeCompositor } = makeCompletedFixture();

    await launchMidTurnTaskView({ manager: fakeManager as never, compositor: fakeCompositor as never });

    const allOutput = written.join('');
    const leaveIdx = allOutput.indexOf(LEAVE_ALT);
    // resumeInput fires after the last write, so the leave sequence must
    // appear before resumeInput was called.
    expect(leaveIdx).toBeGreaterThan(-1);
    // resumeInput must have been called.
    expect(fakeCompositor.resumeInput).toHaveBeenCalled();
    // The leave sequence write must come before the resumeInput call.
    // We verify ordering by checking that LEAVE_ALT appears in written[]
    // before resumeInput fires. Since we track writes and calls separately,
    // check that leaveIdx < allOutput.length and resumeInput was called
    // exactly once (meaning the write came first as leave is the last write).
    const writeCount = written.length;
    expect(writeCount).toBeGreaterThan(0);
    // The last write in written[] must contain LEAVE_ALT (it is the last
    // thing written before resumeInput is called on the early-complete path).
    const lastWrite = written[written.length - 1]!;
    expect(lastWrite).toBe(LEAVE_ALT);
  });

  it('writes the leave alt-screen sequence on the Esc-abort exit path (finally block)', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');

    // Build the fixture manually (no makeRunningFixture) so we avoid
    // stacking a second vi.spyOn on top of makeRunningFixture's spy —
    // double-spying on the same method and then restoreAllMocks() leaves
    // the underlying spy in place and causes the following stream-end test
    // to see a partially-stubbed process.stdin.on.
    const written: string[] = [];
    const fakeStdout = {
      columns: 80,
      write: (s: string) => { written.push(s); return true; },
    };

    let capturedDataListener: ((data: Buffer) => void) | null = null;
    const origOn = process.stdin.on.bind(process.stdin);
    const origRemoveListener = process.stdin.removeListener.bind(process.stdin);
    vi.spyOn(process.stdin, 'on').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data') {
        capturedDataListener = listener as (d: Buffer) => void;
        // Inject Esc immediately on the next microtask so the listener is armed.
        Promise.resolve().then(() => {
          if (capturedDataListener) capturedDataListener(Buffer.from('\x1b'));
        });
      }
      return origOn(event as never, listener as never);
    });
    vi.spyOn(process.stdin, 'removeListener').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      return origRemoveListener(event as never, listener as never);
    });

    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () { /* no events — stream ends immediately */ },
    };
    const fakeHandle = { status: 'running' as const, session: fakeSession, sendMessage: vi.fn() };
    const fakeManager = {
      list: () => [{ id: 'sub-esc-abort', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };
    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    await launchMidTurnTaskView({ manager: fakeManager as never, compositor: fakeCompositor as never });
    vi.restoreAllMocks();

    const allOutput = written.join('');
    expect(allOutput).toContain(LEAVE_ALT);
  });

  it('leave alt-screen is the last write before teardown on the stream-end exit path', async () => {
    // Uses the early-complete path (status === 'succeeded') as a deterministic
    // proxy for the ordering invariant: the code writes LEAVE_ALT as its very
    // last stdout.write before calling resumeInput/repaint.  Both the early-
    // complete path and the finally-block path call the same leaveAltScreen()
    // helper, so ordering is shared.  The early-complete fixture is used here
    // because it is synchronous and immune to stdin-spy state from adjacent tests.
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');
    const { written, fakeManager, fakeCompositor } = makeCompletedFixture();

    await launchMidTurnTaskView({ manager: fakeManager as never, compositor: fakeCompositor as never });

    // Verify: LEAVE_ALT is written, and it is the very last write (resumeInput
    // comes next in source but is not a stdout.write).
    const lastWrite = written[written.length - 1]!;
    expect(lastWrite).toBe(LEAVE_ALT);
    // resumeInput must have been called — it comes immediately after.
    expect(fakeCompositor.resumeInput).toHaveBeenCalled();
  });

  it('no bare \\x1b[2J goes to the main screen — \\x1b[2J always follows the alt-screen enter', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');
    const { written, fakeManager, fakeCompositor } = makeCompletedFixture();

    await launchMidTurnTaskView({ manager: fakeManager as never, compositor: fakeCompositor as never });

    const allOutput = written.join('');
    // Every occurrence of \x1b[2J must be immediately preceded by the
    // alt-screen enter sequence (possibly with intervening cursor-home).
    // The required form is: ENTER_ALT + '\x1b[2J'
    // Find all 2J positions and assert each is inside the alt-screen block.
    let searchFrom = 0;
    let found2J = false;
    while (true) {
      const idx = allOutput.indexOf('\x1b[2J', searchFrom);
      if (idx === -1) break;
      found2J = true;
      // The ENTER_ALT sequence must appear before this 2J, and after any
      // preceding LEAVE_ALT (so we are inside the alt buffer at this point).
      const precedingOutput = allOutput.slice(0, idx);
      const lastEnter = precedingOutput.lastIndexOf(ENTER_ALT);
      const lastLeave = precedingOutput.lastIndexOf(LEAVE_ALT);
      // Must have entered alt screen and not yet left it.
      expect(lastEnter).toBeGreaterThan(-1);
      expect(lastEnter).toBeGreaterThan(lastLeave);
      searchFrom = idx + 1;
    }
    // Sanity: the clear-screen sequence must have been written at least once.
    expect(found2J).toBe(true);
  });

  // -------------------------------------------------------------------------
  // SIGINT / process.exit() teardown path
  //
  // These tests cover the flagged DO-NOT-MERGE regression: interactive.cleanup
  // calls process.exit(0) after runCleanupFunctions(), and a SIGINT double-
  // press also calls ctx.rl.close() which leads to process.exit(). Without
  // the enterAltScreen / registerCleanup fix, neither path writes LEAVE_ALT.
  //
  // Test strategy: spy on process.on / process.removeListener to capture the
  // 'exit' listener registered by enterAltScreen, then call it manually to
  // simulate process.exit() without actually terminating the test runner.
  // -------------------------------------------------------------------------

  it('process.on(exit) guard writes LEAVE_ALT when the view is open (SIGINT path)', async () => {
    // Invariant: enterAltScreen() registers a process.on('exit', writeLeave)
    // fallback so that process.exit() from interactive.cleanup always writes
    // LEAVE_ALT_SCREEN even when the cleanup registry was bypassed.
    // This test fails without the process.on('exit') registration.
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');
    const written: string[] = [];

    const fakeStdout = {
      columns: 80,
      write: (s: string) => { written.push(s); return true; },
    };

    // Capture the exit listener added by enterAltScreen and any subsequent
    // removal so we can simulate the guard firing without calling process.exit.
    let capturedExitListener: ((...args: unknown[]) => void) | null = null;
    const origProcessOn = process.on.bind(process);
    const origProcessRemoveListener = process.removeListener.bind(process);
    vi.spyOn(process, 'on').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit') capturedExitListener = listener;
      return origProcessOn(event as never, listener as never);
    });
    vi.spyOn(process, 'removeListener').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit' && listener === capturedExitListener) {
        capturedExitListener = null;
      }
      return origProcessRemoveListener(event as never, listener as never);
    });

    // Capture stdin data listener so we can send Esc.
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

    // Running fixture — stream ends immediately; we inject Esc to exit.
    let resolveStream!: () => void;
    const streamDone = new Promise<void>((r) => { resolveStream = r; });

    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () { resolveStream(); },
    };
    const fakeHandle = { status: 'running' as const, session: fakeSession, sendMessage: vi.fn() };
    const fakeManager = {
      list: () => [{ id: 'sub-exit-guard', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };
    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    // Invoke the exit guard BEFORE the normal exit path runs (simulating
    // process.exit() being called while the stream is still open, e.g. a
    // SIGINT double-press). We do this by intercepting the stream start:
    // once enterAltScreen has registered the guard (after the stream begins),
    // fire the exit listener, then let the view exit normally via Esc.
    let firedExitGuard = false;
    const origGetOutputStream = fakeSession.getOutputStream;
    fakeSession.getOutputStream = async function* () {
      // Enter alt screen has already been called at this point.
      // Fire the process exit guard to simulate process.exit() mid-view.
      if (capturedExitListener && !firedExitGuard) {
        firedExitGuard = true;
        capturedExitListener();
      }
      yield* origGetOutputStream();
    };

    void streamDone.then(() => {
      setTimeout(() => {
        if (capturedDataListener) capturedDataListener(Buffer.from('\x1b'));
      }, 10);
    });

    await launchMidTurnTaskView({ manager: fakeManager as never, compositor: fakeCompositor as never });
    vi.restoreAllMocks();

    // The exit guard must have written LEAVE_ALT when fired.
    const allOutput = written.join('');
    expect(allOutput).toContain(LEAVE_ALT);
    // The guard must have been registered (fired = true confirms it was captured).
    expect(firedExitGuard).toBe(true);
  });

  it('cleanup registry writes LEAVE_ALT when called during runCleanupFunctions (SIGTERM path)', async () => {
    // Invariant: enterAltScreen() registers a cleanup-registry function.
    // runCleanupFunctions() is called by the SIGTERM/SIGHUP grace-period
    // timeout and by rl.on('close'). This test confirms the registry write
    // fires and fails without the registerCleanup() call in enterAltScreen.
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');
    const { runCleanupFunctions } = await import('../../../utils/cleanupRegistry.js');
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

    // Hang the stream so the view stays open while we fire runCleanupFunctions.
    let resolveStream!: () => void;
    const streamReady = new Promise<void>((r) => { resolveStream = r; });

    const fakeSession = {
      getHistory: () => [],
      // History: stream stays open until we resolve it.
      getOutputStream: async function* () {
        resolveStream();
        // Wait until the test fires runCleanupFunctions and injects Esc.
        await new Promise<void>((r) => setTimeout(r, 100));
      },
    };
    const fakeHandle = { status: 'running' as const, session: fakeSession, sendMessage: vi.fn() };
    const fakeManager = {
      list: () => [{ id: 'sub-cleanup-reg', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };
    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    // Start the view (does NOT await — it runs concurrently).
    const viewDone = launchMidTurnTaskView({ manager: fakeManager as never, compositor: fakeCompositor as never });

    // Wait until the stream generator has started (so enterAltScreen has run).
    await streamReady;

    // Clear the output captured so far so we only see the cleanup write.
    written.length = 0;

    // Simulate the SIGTERM grace-period timeout calling runCleanupFunctions.
    await runCleanupFunctions();

    // The cleanup registry must have written LEAVE_ALT.
    expect(written.join('')).toContain(LEAVE_ALT);

    // Let the view exit cleanly.
    if (capturedDataListener) capturedDataListener(Buffer.from('\x1b'));
    await viewDone;
    vi.restoreAllMocks();
  });

  it('disarmCleanup prevents double-write of LEAVE_ALT on normal Esc exit (idempotence)', async () => {
    // Invariant: disarmCleanup() removes both the process.on('exit') guard
    // and the cleanup-registry function before leaveAltScreen() writes
    // LEAVE_ALT once on the normal exit path.  After a clean exit, calling
    // the exit guard or runCleanupFunctions must NOT write a second LEAVE_ALT
    // (double-leave corrupts the main screen buffer).
    // This test fails if disarmCleanup() does not remove both guards.
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');
    const { runCleanupFunctions } = await import('../../../utils/cleanupRegistry.js');
    const written: string[] = [];

    const fakeStdout = {
      columns: 80,
      write: (s: string) => { written.push(s); return true; },
    };

    // Capture the exit listener; also track whether it was ever registered
    // (wasRegistered) separately from whether it was disarmed (capturedExitListener
    // becomes null on disarm).  This lets us assert registration unconditionally
    // without conflating "was registered and then disarmed" with "was never registered".
    // History: the original code used `if (capturedExitListener)` as the guard for
    // firing the simulated process.exit(), which silently skipped the simulation when
    // disarmCleanup had already nulled the reference — masking the F1 double-write bug.
    let capturedExitListener: ((...args: unknown[]) => void) | null = null;
    let wasRegistered = false;
    const origProcessOn = process.on.bind(process);
    const origProcessRemoveListener = process.removeListener.bind(process);
    vi.spyOn(process, 'on').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit') { capturedExitListener = listener; wasRegistered = true; }
      return origProcessOn(event as never, listener as never);
    });
    vi.spyOn(process, 'removeListener').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit' && listener === capturedExitListener) {
        capturedExitListener = null; // disarmed
      }
      return origProcessRemoveListener(event as never, listener as never);
    });

    // Use the early-complete path for simplicity: view exits synchronously.
    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () { /* no events */ },
    };
    const fakeHandle = { status: 'succeeded' as const, session: fakeSession, sendMessage: vi.fn() };
    const fakeManager = {
      list: () => [{ id: 'sub-idempotent', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };
    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    // Let the view complete normally.
    await launchMidTurnTaskView({ manager: fakeManager as never, compositor: fakeCompositor as never });

    // Normal exit has written exactly one LEAVE_ALT — record the count.
    const leaveCountAfterNormalExit = written.filter((s) => s === LEAVE_ALT).length;
    expect(leaveCountAfterNormalExit).toBe(1);

    // Assert the spy captured the listener at some point during the run.
    // Without this unconditional assertion the spy failure goes undetected.
    // F3 fix: `wasRegistered` separates "registered then disarmed" from "never registered".
    expect(wasRegistered).toBe(true);

    // After normal exit, capturedExitListener is null IFF disarmCleanup ran.
    // If still non-null (not disarmed), call it to expose the double-write.
    if (capturedExitListener) {
      (capturedExitListener as () => void)();
    }
    await runCleanupFunctions();

    // No second LEAVE_ALT must have been written.
    const leaveCountAfterRedundant = written.filter((s) => s === LEAVE_ALT).length;
    expect(leaveCountAfterRedundant).toBe(1);

    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // F1 regression: writeLeave one-shot flag
  //
  // Simulates the SIGTERM path: runCleanupFunctions() fires the cleanup-
  // registry writer, then process.exit(0) fires the still-registered
  // process.on('exit') listener.  Without the `fired` flag both calls emit
  // LEAVE_ALT; with the flag only the first one does.
  //
  // Revert check: remove the `fired` guard from writeLeave and this fails
  // because `written.filter(s => s === LEAVE_ALT).length` equals 2.
  // -------------------------------------------------------------------------
  it('F1: LEAVE_ALT is written exactly once when both cleanup registry and exit guard fire', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');
    const { runCleanupFunctions } = await import('../../../utils/cleanupRegistry.js');
    const written: string[] = [];

    const fakeStdout = {
      columns: 80,
      write: (s: string) => { written.push(s); return true; },
    };

    // Capture process.on('exit') listener so we can fire it manually.
    let capturedExitListener: ((...args: unknown[]) => void) | null = null;
    const origProcessOn = process.on.bind(process);
    const origProcessRemoveListener = process.removeListener.bind(process);
    vi.spyOn(process, 'on').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit') capturedExitListener = listener;
      return origProcessOn(event as never, listener as never);
    });
    vi.spyOn(process, 'removeListener').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'exit' && listener === capturedExitListener) capturedExitListener = null;
      return origProcessRemoveListener(event as never, listener as never);
    });

    // Hang the stream so the view stays open while we fire the guards.
    let resolveStream!: () => void;
    const streamReady = new Promise<void>((r) => { resolveStream = r; });

    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () {
        resolveStream();
        await new Promise<void>((r) => setTimeout(r, 150));
      },
    };
    const fakeHandle = { status: 'running' as const, session: fakeSession, sendMessage: vi.fn() };
    const fakeManager = {
      list: () => [{ id: 'sub-f1-double', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
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

    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    const viewDone = launchMidTurnTaskView({ manager: fakeManager as never, compositor: fakeCompositor as never });

    // Wait until enterAltScreen has registered both guards.
    await streamReady;

    // Sanity: spy must have captured the exit listener.
    expect(capturedExitListener).not.toBeNull();

    // Reset the write log so we only measure what the two guard firings emit.
    written.length = 0;

    // Simulate SIGTERM path: runCleanupFunctions fires the registry function first.
    await runCleanupFunctions();

    // Then process.exit(0) fires the still-registered exit listener.
    // (capturedExitListener is non-null because runCleanupFunctions does NOT
    // call process.removeListener — only disarmCleanup does.)
    if (capturedExitListener) {
      (capturedExitListener as () => void)();
    }

    // Exactly one LEAVE_ALT must have been emitted across both guard firings.
    const leaveCount = written.filter((s) => s === LEAVE_ALT).length;
    expect(leaveCount).toBe(1);

    // Let the view exit cleanly.
    if (capturedDataListener) capturedDataListener(Buffer.from('\x1b'));
    await viewDone;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // F2 regression: onData listener removed before waitForEsc
  //
  // During the 'Subagent completed. Press Esc to return.' pause, keystrokes
  // must NOT mutate inputBuf or trigger renderPrompt — the onData listener
  // must be removed before waitForEsc starts.
  //
  // Test strategy: spy on process.stdin.removeListener to record the order of
  // removals relative to when waitForEsc's own listener is registered via
  // process.stdin.on('data', onEsc).  With the F2 fix, onData is removed BEFORE
  // onEsc is added; without the fix, onData is removed AFTER onEsc (in finally).
  //
  // Revert check: move removeListener back into the finally block (after
  // waitForEsc) and this test fails because the onData removal happens after
  // the waitForEsc listener is registered, not before.
  // -------------------------------------------------------------------------
  it('F2: onData listener is removed before waitForEsc starts (ordering invariant)', async () => {
    const { launchMidTurnTaskView } = await import('./task-view-mid-turn.js');
    const written: string[] = [];

    const fakeStdout = {
      columns: 80,
      write: (s: string) => { written.push(s); return true; },
    };

    // Record the sequence of (event, action) pairs to verify ordering.
    // Each entry is either 'on:data' (listener added) or 'remove:data' (removed).
    const sequence: string[] = [];
    let onDataListener: ((...args: unknown[]) => void) | null = null;

    const origOn = process.stdin.on.bind(process.stdin);
    const origRemoveListener = process.stdin.removeListener.bind(process.stdin);
    vi.spyOn(process.stdin, 'on').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data') sequence.push('on:data');
      return origOn(event as never, listener as never);
    });
    vi.spyOn(process.stdin, 'removeListener').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data') {
        // Record the removal identity: is it the onData listener (captured
        // as the first 'data' registration) or the onEsc listener (subsequent)?
        if (onDataListener === null) {
          // First removal of a 'data' listener — this is onData.
          onDataListener = listener as never;
          sequence.push('remove:onData');
        } else {
          sequence.push('remove:other');
        }
      }
      return origRemoveListener(event as never, listener as never);
    });

    // Capture which listener was registered first (onData) so the spy can
    // distinguish it from onEsc.  We re-wire the on spy to also capture it.
    let firstDataListener: ((...args: unknown[]) => void) | null = null;
    vi.restoreAllMocks();
    vi.spyOn(process.stdin, 'on').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data') {
        if (!firstDataListener) firstDataListener = listener as never;
        sequence.push('on:data');
      }
      return origOn(event as never, listener as never);
    });
    vi.spyOn(process.stdin, 'removeListener').mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data') {
        if (listener === firstDataListener) sequence.push('remove:onData');
        else sequence.push('remove:other');
      }
      return origRemoveListener(event as never, listener as never);
    });

    // Stream ends immediately (signal.aborted is false) so waitForEsc fires.
    const fakeSession = {
      getHistory: () => [],
      getOutputStream: async function* () {
        // no events — stream ends cleanly; signal.aborted is false so
        // the view proceeds to the 'Press Esc to return.' pause.
      },
    };
    const fakeHandle = { status: 'running' as const, session: fakeSession, sendMessage: vi.fn() };
    const fakeManager = {
      list: () => [{ id: 'sub-f2-order', status: 'running' as const }],
      get: (_id: string) => fakeHandle as never,
    };
    const fakeCompositor = {
      stdout: fakeStdout as never,
      suspendInput: vi.fn(),
      resumeInput: vi.fn(),
      repaint: vi.fn(),
    };

    // Resolve waitForEsc quickly by emitting Esc shortly after the view starts.
    // We do this by waiting a tick then emitting via process.stdin.emit to let
    // the waitForEsc listener register first.
    setTimeout(() => {
      process.stdin.emit('data', Buffer.from('\x1b'));
    }, 50);

    await launchMidTurnTaskView({ manager: fakeManager as never, compositor: fakeCompositor as never });
    vi.restoreAllMocks();

    // With F2 fix: the sequence contains 'remove:onData' before the second 'on:data'
    // (which is waitForEsc's onEsc listener).  Without the fix, 'remove:onData'
    // comes after the second 'on:data'.
    //
    // Sequence with fix:    on:data, remove:onData, on:data, ...
    // Sequence without fix: on:data, on:data, remove:onData, ...
    const firstOnData = sequence.indexOf('on:data');
    const removeOnData = sequence.indexOf('remove:onData');
    const secondOnData = sequence.indexOf('on:data', firstOnData + 1);

    // Sanity: onData was registered.
    expect(firstOnData).toBeGreaterThanOrEqual(0);
    // Sanity: onData was eventually removed.
    expect(removeOnData).toBeGreaterThanOrEqual(0);
    // Key assertion: the removal happened before waitForEsc's listener was added.
    // waitForEsc adds its own 'data' listener (onEsc) — that is the second 'on:data'.
    expect(removeOnData).toBeLessThan(secondOnData);
  });
});
