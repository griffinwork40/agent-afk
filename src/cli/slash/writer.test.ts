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
