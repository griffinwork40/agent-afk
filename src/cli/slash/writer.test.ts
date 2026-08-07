/**
 * createConsoleWriter — sink routing contract.
 *
 * Stage 2b wired an optional `WriterSink` parameter so slash output
 * can route through `CompletionWriter` (which the REPL hot-swaps
 * between `console.log` and `compositor.commitAbove`). These tests
 * lock the routing contract — without them, a future refactor that
 * drops the sink wiring or captures `sink.fn` by value (instead of by
 * reference) would silently regress the hot-swap behavior Stage 3
 * relies on.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createConsoleWriter, type WriterSink } from './writer.js';
import { displayWidth, stripAnsi } from '../display.js';

describe('createConsoleWriter — sink routing', () => {
  describe('without a sink (default)', () => {
    it('line() routes through console.log', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const w = createConsoleWriter();
        w.line('hello');
        expect(spy).toHaveBeenCalledWith('hello');
      } finally {
        spy.mockRestore();
      }
    });

    it('raw() routes through process.stdout.write (no trailing newline)', () => {
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        const w = createConsoleWriter();
        w.raw('no-newline');
        expect(spy).toHaveBeenCalledWith('no-newline');
      } finally {
        spy.mockRestore();
      }
    });

    it('success/info/warn/error all route through console.log with prefixes', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const w = createConsoleWriter();
        w.success('s');
        w.info('i');
        w.warn('w');
        w.error('e');
        expect(spy).toHaveBeenCalledTimes(4);
        // Don't assert ANSI exactly — palette helpers may change. Just check
        // the message body landed in each routed call.
        const lines = spy.mock.calls.map((args) => String(args[0]));
        expect(lines.some((l) => l.includes('s'))).toBe(true);
        expect(lines.some((l) => l.includes('i'))).toBe(true);
        expect(lines.some((l) => l.includes('w'))).toBe(true);
        expect(lines.some((l) => l.includes('e'))).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('with a sink', () => {
    it('line() routes through sink.fn instead of console.log', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const lines: string[] = [];
      const sink: WriterSink = { fn: (line) => lines.push(line) };
      try {
        const w = createConsoleWriter(sink);
        w.line('hello');
        expect(lines).toEqual(['hello']);
        expect(consoleSpy).not.toHaveBeenCalled();
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it('raw() bypasses sink.fn and routes through process.stdout.write when no rawFn provided', () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const lines: string[] = [];
      const sink: WriterSink = { fn: (line) => lines.push(line) };
      try {
        const w = createConsoleWriter(sink);
        w.raw('payload');
        // sink.fn must NOT be called — raw() preserves its no-newline contract
        expect(lines).toEqual([]);
        expect(stdoutSpy).toHaveBeenCalledWith('payload');
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it('raw() routes through sink.rawFn when explicitly provided', () => {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const rawCapture: string[] = [];
      const sink: WriterSink = {
        fn: () => { throw new Error('sink.fn should not be called for raw()'); },
        rawFn: (text) => rawCapture.push(text),
      };
      try {
        const w = createConsoleWriter(sink);
        w.raw('payload');
        expect(rawCapture).toEqual(['payload']);
        expect(stdoutSpy).not.toHaveBeenCalled();
      } finally {
        stdoutSpy.mockRestore();
      }
    });

    it('all decorated variants (success/info/warn/error) route through sink.fn', () => {
      const lines: string[] = [];
      const sink: WriterSink = { fn: (line) => lines.push(line) };
      const w = createConsoleWriter(sink);
      w.success('ok');
      w.info('note');
      w.warn('caution');
      w.error('boom');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toContain('ok');
      expect(lines[1]).toContain('note');
      expect(lines[2]).toContain('caution');
      expect(lines[3]).toContain('boom');
    });

    it('reads sink.fn by reference on every write — hot-swap takes effect immediately', () => {
      // This is the load-bearing assertion for Stage 3. CompletionWriter
      // is hot-swapped between console.log and compositor.commitAbove at
      // turn boundaries (turn-handler.ts:124 + :290). If the writer
      // captured `sink.fn` by value at construction, swaps would never
      // take effect on the long-lived slashCtx.out writer.
      const firstCalls: string[] = [];
      const secondCalls: string[] = [];
      const sink: WriterSink = { fn: (line) => firstCalls.push(line) };
      const w = createConsoleWriter(sink);

      w.line('before-swap');
      sink.fn = (line) => secondCalls.push(line);
      w.line('after-swap');

      expect(firstCalls).toEqual(['before-swap']);
      expect(secondCalls).toEqual(['after-swap']);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe('createConsoleWriter — width bounding', () => {
  const originalColumns = process.stdout.columns;
  const originalIsTTY = process.stdout.isTTY;
  const setTerminal = (cols: number, isTTY: boolean): void => {
    Object.defineProperty(process.stdout, 'columns', { configurable: true, writable: true, value: cols });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, writable: true, value: isTTY });
  };

  afterEach(() => {
    setTerminal(originalColumns as number, originalIsTTY as boolean);
    vi.restoreAllMocks();
  });

  /** The real `/worktree list` row shape — ~100 columns of fixed padEnd(). */
  const wideTableRow =
    '  ' + 'some/path'.padEnd(45) + '  ' + 'owner'.padEnd(12) + '  ' + '3d'.padEnd(5) +
    '  ' + 'stale-dirty'.padEnd(22) + '  ' + 'warn';

  it('wraps a sinkless over-wide row so nothing exits the right edge on a TTY', () => {
    setTerminal(62, true);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = createConsoleWriter();

    w.line(wideTableRow);

    const emitted = spy.mock.calls[0]?.[0] as string;
    const rows = emitted.split('\n');
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(displayWidth(row), `row exceeds 62: ${JSON.stringify(stripAnsi(row))}`).toBeLessThanOrEqual(62);
    }
  });

  it('bounds the prefixed helpers (info/warn/error/success) too', () => {
    setTerminal(40, true);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = createConsoleWriter();

    w.info('i'.repeat(120));
    w.warn('w'.repeat(120));
    w.error('e'.repeat(120));
    w.success('s'.repeat(120));

    for (const call of spy.mock.calls) {
      for (const row of (call[0] as string).split('\n')) {
        expect(displayWidth(row)).toBeLessThanOrEqual(40);
      }
    }
  });

  it('leaves non-TTY output byte-identical so piped rows stay whole', () => {
    setTerminal(62, false);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = createConsoleWriter();

    w.line(wideTableRow);

    expect(spy).toHaveBeenCalledWith(wideTableRow);
  });

  it('does not bound the sink path — the sink owner wraps and reflows', () => {
    setTerminal(62, true);
    const calls: string[] = [];
    const w = createConsoleWriter({ fn: (line) => calls.push(line) });

    w.line(wideTableRow);

    expect(calls).toEqual([wideTableRow]);
  });
});
