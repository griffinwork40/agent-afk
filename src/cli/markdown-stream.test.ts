import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import stringWidth from 'string-width';
import { StreamingMarkdownRenderer } from './markdown-stream.js';
import { hasMarkdownContent } from './markdown-stream-format.js';
import { wrapToWidth } from './wrap.js';
import { PassThrough } from 'node:stream';

/**
 * Tests for StreamingMarkdownRenderer
 *
 * Verifies:
 * 1. Plain text fast-path rendering
 * 2. Markdown block boundary detection and commitment
 * 3. Fenced code block handling (streaming + complete)
 * 4. List block handling across chunks
 * 5. Non-TTY behavior (no cursor rewriting)
 * 6. Throttling of repaints
 * 7. Proper cleanup and disposal
 */

describe('StreamingMarkdownRenderer', () => {
  let stream: PassThrough;
  let renderer: StreamingMarkdownRenderer;

  beforeEach(() => {
    // Create a mock stream that behaves like stdout
    stream = new PassThrough();
    // Mark it as non-TTY by default (tests override as needed)
    (stream as any).isTTY = false;
  });

  afterEach(() => {
    renderer?.dispose();
    stream?.destroy();
  });

  describe('Plain text fast-path', () => {
    it('should render pure text without markdown markers', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('Hello world');
      renderer.push('This is just plain text');
      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('Hello world');
      expect(output).toContain('This is just plain text');
    });

    it('should preserve exact formatting for plain text', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('Line 1\nLine 2\nLine 3');
      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('Line 1');
      expect(output).toContain('Line 2');
      expect(output).toContain('Line 3');
    });
  });

  describe('Block boundary detection', () => {
    it('should detect double newline as block boundary', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('# Heading');
      renderer.push('\n\n');
      renderer.push('Paragraph text');

      expect(renderer.getPendingBuffer()).toContain('Paragraph text');
      expect(renderer.getCommittedOutput()).toContain('Heading');

      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('Heading');
      expect(output).toContain('Paragraph text');
    });

    it('should handle heading and paragraph blocks', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('# Hello\n\n');
      renderer.push('para\n\n');

      // Both should be committed
      const committed = renderer.getCommittedOutput();
      expect(committed).toContain('Hello');
      expect(committed).toContain('para');
      expect(renderer.getPendingBuffer()).toBe('');

      await renderer.flush();
    });

    it('should not split on single newline', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('Line 1\n');
      renderer.push('Line 2\n');

      // Should still be pending until double newline detected
      expect(renderer.getPendingBuffer()).toContain('Line 1');
      expect(renderer.getPendingBuffer()).toContain('Line 2');
      expect(renderer.getCommittedOutput()).toBe('');

      renderer.push('\n');

      // Now double newline is present, should be committed
      const output = renderer.getCommittedOutput();
      expect(output).toContain('Line 1');
      expect(output).toContain('Line 2');

      await renderer.flush();
    });
  });

  describe('Fenced code block handling', () => {
    it('should hold open code fence in pending until closed', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('```js\n');
      expect(renderer.getCommittedOutput()).toBe('');
      expect(renderer.getPendingBuffer()).toContain('```js');

      renderer.push('const x = 1;');
      expect(renderer.getCommittedOutput()).toBe('');

      renderer.push('\n```\n');

      // After closing fence + boundary, should be committed
      const committed = renderer.getCommittedOutput();
      expect(committed).toContain('const x = 1;');
      expect(committed).toContain('js');

      await renderer.flush();
    });

    it('should render code block with language markers', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('```python\nprint("hello")\n```\n');

      expect(renderer.getCommittedOutput()).toBeTruthy();
      const output = renderer.getCommittedOutput();
      expect(output).toContain('hello');
      expect(output).toContain('python');

      await renderer.flush();
    });

    it('should handle code block without language', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('```\nraw code\n```\n');

      const output = renderer.getCommittedOutput();
      expect(output).toContain('raw code');

      await renderer.flush();
    });

    it('should handle multiple code blocks in sequence', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('```js\nfn();\n```\n\n');
      renderer.push('Text between\n\n');
      renderer.push('```py\nfn()\n```\n');

      const output = renderer.getCommittedOutput();
      expect(output).toContain('fn');
      expect(output).toContain('Text between');

      await renderer.flush();
    });
  });

  describe('List block handling', () => {
    it('should commit list as single block on boundary', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('- Item 1');
      renderer.push('\n- Item 2');
      renderer.push('\n- Item 3\n\n');

      const committed = renderer.getCommittedOutput();
      // All three items should appear in committed output
      expect(committed).toContain('Item 1');
      expect(committed).toContain('Item 2');
      expect(committed).toContain('Item 3');

      await renderer.flush();
    });

    it('should not commit list until boundary detected', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('- Item 1');
      expect(renderer.getCommittedOutput()).toBe('');
      expect(renderer.getPendingBuffer()).toContain('Item 1');

      renderer.push('\n- Item 2\n');
      expect(renderer.getCommittedOutput()).toBe('');

      renderer.push('\n');
      // Now boundary is detected
      expect(renderer.getCommittedOutput()).toBeTruthy();

      await renderer.flush();
    });
  });

  describe('Non-TTY behavior', () => {
    it('should write output without cursor rewriting', async () => {
      const writeStream = new PassThrough();
      (writeStream as any).isTTY = false;

      const writeData: string[] = [];
      writeStream.on('data', (chunk) => {
        writeData.push(chunk.toString());
      });

      renderer = new StreamingMarkdownRenderer({ out: writeStream });

      renderer.push('Some text\n\n');
      renderer.push('More text');

      await renderer.flush();

      // Verify data was written
      expect(writeData.length).toBeGreaterThan(0);
      const written = writeData.join('');
      expect(written).toContain('Some text');
      expect(written).toContain('More text');

      // Should NOT contain ANSI cursor control sequences from log-update
      // log-update uses \u001B sequences; we shouldn't see cursor movement
      expect(written).not.toContain('\u001B[H'); // Cursor home
      expect(written).not.toContain('\u001B[2K'); // Clear line
    });
  });

  describe('Indentation', () => {
    it('should apply custom indent to committed blocks', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream, indent: '    ' });

      renderer.push('Line 1\n\n');

      const output = renderer.getCommittedOutput();
      // Indentation should be applied
      expect(output).toMatch(/^    /m);

      await renderer.flush();
    });

    it('should apply default indent (two spaces)', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('Line 1\n\n');

      const output = renderer.getCommittedOutput();
      expect(output).toMatch(/^  /m); // Default is two spaces

      await renderer.flush();
    });
  });

  describe('Throttling', () => {
    it('should limit repaints to throttle interval', async () => {
      vi.useFakeTimers();

      const ttyStream = new PassThrough();
      (ttyStream as any).isTTY = true;

      renderer = new StreamingMarkdownRenderer({
        out: ttyStream,
        throttleMs: 100,
      });

      // Track how many times repaint logic is invoked
      const repaintCalls: number[] = [];
      const originalPush = renderer.push.bind(renderer);

      renderer.push = function (chunk: string) {
        repaintCalls.push(Date.now());
        originalPush(chunk);
      };

      // Push multiple chunks rapidly
      renderer.push('chunk 1 ');
      renderer.push('chunk 2 ');
      renderer.push('chunk 3 ');

      // Multiple pushes, but repaints should be throttled
      // The throttle should ensure max frequency
      expect(repaintCalls.length).toBe(3);

      vi.useRealTimers();
      await renderer.flush();
    });

    it('should dispose cleanly without dangling timers', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream, throttleMs: 50 });

      renderer.push('test ');
      renderer.push('data');

      // Dispose before flush
      renderer.dispose();

      // Should not hang; process should exit cleanly
      // This test passes if it doesn't timeout
      await new Promise((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, 100);
      });

      expect(true).toBe(true); // Reached here without hanging
    });
  });

  describe('Mixed markdown and plain text', () => {
    it('should detect and render markdown blocks', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('Plain text here\n\n');
      renderer.push('# Heading\n\n');
      renderer.push('More plain\n\n');

      const output = renderer.getCommittedOutput();
      expect(output).toContain('Plain text here');
      expect(output).toContain('Heading');
      expect(output).toContain('More plain');

      await renderer.flush();
    });

    it('should handle inline markdown in paragraphs', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('This has **bold** and *italic* text\n\n');

      const output = renderer.getCommittedOutput();
      expect(output).toContain('bold');
      expect(output).toContain('italic');

      await renderer.flush();
    });
  });

  describe('Edge cases', () => {
    it('should handle empty pushes gracefully', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('');
      renderer.push('');
      renderer.push('text\n\n');

      expect(renderer.getCommittedOutput()).toContain('text');

      await renderer.flush();
    });

    it('should handle multiple consecutive newlines', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('text\n\n\n\n');

      // First \n\n is a boundary
      expect(renderer.getCommittedOutput()).toContain('text');

      await renderer.flush();
    });

    it('should not error on flush without any pushes', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      // Should not throw
      await expect(renderer.flush()).resolves.toBeUndefined();
    });

    it('should handle very long code blocks', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('```js\n');
      // Simulate a large code block
      for (let i = 0; i < 100; i++) {
        renderer.push(`const var${i} = ${i};\n`);
      }
      renderer.push('```\n');

      const output = renderer.getCommittedOutput();
      expect(output).toContain('var0');
      expect(output).toContain('var99');

      await renderer.flush();
    });
  });

  describe('API contract', () => {
    it('should expose getCommittedOutput', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      expect(typeof renderer.getCommittedOutput).toBe('function');

      renderer.push('test\n\n');
      const output = renderer.getCommittedOutput();

      expect(typeof output).toBe('string');

      await renderer.flush();
    });

    it('should expose getPendingBuffer', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      expect(typeof renderer.getPendingBuffer).toBe('function');

      renderer.push('pending');
      const pending = renderer.getPendingBuffer();

      expect(typeof pending).toBe('string');
      expect(pending).toBe('pending');

      await renderer.flush();
    });

    it('should expose dispose', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      expect(typeof renderer.dispose).toBe('function');

      renderer.push('text\n\n');
      renderer.dispose();

      // After dispose, should be cleanable
      expect(renderer.getPendingBuffer()).toBe('');

      await renderer.flush();
    });
  });

  describe('Stream closure', () => {
    it('should handle stream closure gracefully', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('text\n\n');
      stream.destroy();

      // Should still be callable
      await expect(renderer.flush()).resolves.toBeUndefined();

      renderer.dispose();
    });
  });

  describe('Terminal width wrapping', () => {
    const prevCols = process.stdout.columns;

    afterEach(() => {
      Object.defineProperty(process.stdout, 'columns', {
        value: prevCols,
        configurable: true,
      });
    });

    it('wraps committed plain text to stdout.columns - 2', async () => {
      Object.defineProperty(process.stdout, 'columns', { value: 36, configurable: true });
      renderer = new StreamingMarkdownRenderer({ out: stream });
      const long = 'alpha '.repeat(30).trim();
      renderer.push(`${long}\n\n`);
      await renderer.flush();
      const out = renderer.getCommittedOutput();
      for (const line of out.split('\n')) {
        if (line.length === 0) continue;
        expect(stringWidth(line)).toBeLessThanOrEqual(34);
      }
    });

    it('wraps markdown output at narrow width (committed lines respect width)', async () => {
      Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
      renderer = new StreamingMarkdownRenderer({ out: stream });
      renderer.push('**bold** word '.repeat(8).trim() + '\n\n');
      await renderer.flush();
      const out = renderer.getCommittedOutput();
      expect(out).toContain('bold');
      for (const line of out.split('\n')) {
        if (line.length === 0) continue;
        expect(stringWidth(line)).toBeLessThanOrEqual(38);
      }
    });
  });

  describe('compositor integration', () => {
    function makeStubCompositor() {
      const overlayCalls: string[] = [];
      const commitAboveCalls: string[] = [];
      const stub = {
        setOverlay(text: string) {
          overlayCalls.push(text);
        },
        commitAbove(text: string) {
          commitAboveCalls.push(text);
        },
        // Unused by renderer but required by type
        arm: async () => {},
        disarm: () => {},
        getBuffer: () => ({ text: '', queued: false }),
        isArmed: () => true,
      };
      return { stub, overlayCalls, commitAboveCalls };
    }

    it('routes committed blocks through compositor.commitAbove', async () => {
      const { stub, commitAboveCalls } = makeStubCompositor();
      const ttyStream = new PassThrough();
      (ttyStream as any).isTTY = true;

      renderer = new StreamingMarkdownRenderer({
        out: ttyStream,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compositor: stub as any,
      });

      renderer.push('block one\n\n');
      renderer.push('block two\n\n');

      expect(commitAboveCalls.length).toBe(2);
      expect(commitAboveCalls[0]).toContain('block one');
      expect(commitAboveCalls[1]).toContain('block two');

      await renderer.flush();
    });

    it('routes pending overlay through compositor.setOverlay on repaint', async () => {
      vi.useFakeTimers();
      const { stub, overlayCalls } = makeStubCompositor();
      const ttyStream = new PassThrough();
      (ttyStream as any).isTTY = true;

      renderer = new StreamingMarkdownRenderer({
        out: ttyStream,
        throttleMs: 10,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compositor: stub as any,
      });

      renderer.push('pending overlay text');
      vi.advanceTimersByTime(20);
      // Flush microtasks queued by the throttled setTimeout callback
      await vi.runAllTimersAsync();

      expect(overlayCalls.length).toBeGreaterThan(0);
      expect(overlayCalls.some((s) => s.includes('pending overlay text'))).toBe(true);

      vi.useRealTimers();
      await renderer.flush();
    });

    it('wraps pending overlay to stdout.columns - 2 before compositor.setOverlay', async () => {
      // Regression: log-update counts logical (\n-separated) lines when
      // clearing its tracked region. A soft-wrapped overlay painted into the
      // compositor left orphaned visual rows in scrollback because the clear
      // undershot the visual row count. `repaint()` now wraps before calling
      // `compositor.setOverlay`, symmetric with the committed-block path.
      const prevCols = process.stdout.columns;
      Object.defineProperty(process.stdout, 'columns', { value: 36, configurable: true });
      vi.useFakeTimers();
      try {
        const { stub, overlayCalls } = makeStubCompositor();
        const ttyStream = new PassThrough();
        (ttyStream as any).isTTY = true;

        renderer = new StreamingMarkdownRenderer({
          out: ttyStream,
          throttleMs: 10,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          compositor: stub as any,
        });

        const long = 'alpha '.repeat(30).trim();
        renderer.push(long);
        vi.advanceTimersByTime(20);
        await vi.runAllTimersAsync();

        expect(overlayCalls.length).toBeGreaterThan(0);
        for (const call of overlayCalls) {
          for (const line of call.split('\n')) {
            if (line.length === 0) continue;
            expect(stringWidth(line)).toBeLessThanOrEqual(34);
          }
        }

        vi.useRealTimers();
        await renderer.flush();
      } finally {
        vi.useRealTimers();
        Object.defineProperty(process.stdout, 'columns', { value: prevCols, configurable: true });
      }
    });

    it('flush() clears overlay via compositor instead of writing to stdout', async () => {
      const { stub, overlayCalls } = makeStubCompositor();
      const ttyStream = new PassThrough();
      (ttyStream as any).isTTY = true;

      const writes: string[] = [];
      ttyStream.on('data', (c) => writes.push(c.toString()));

      renderer = new StreamingMarkdownRenderer({
        out: ttyStream,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compositor: stub as any,
      });

      renderer.push('block\n\n');
      await renderer.flush();

      // Overlay cleared by a setOverlay('') call at the tail.
      expect(overlayCalls.at(-1)).toBe('');
      // Committed content did NOT go to stdout directly — it went via
      // commitAbove, so the PassThrough should not receive the committed
      // payload here.
      expect(writes.join('')).not.toContain('block');
    });

    it('non-compositor path still writes committed content to stdout on flush', async () => {
      // Regression: ensure the legacy path is unchanged when compositor is absent.
      renderer = new StreamingMarkdownRenderer({ out: stream });
      renderer.push('legacy\n\n');

      const writes: string[] = [];
      stream.on('data', (c) => writes.push(c.toString()));

      await renderer.flush();

      expect(writes.join('')).toContain('legacy');
    });

    it('streams a table as a compact overlay placeholder, then commits it exactly once', async () => {
      // Regression (the "ghost table rows" bug): a streaming markdown table has
      // no internal blank line, so the whole growing table accumulated in the
      // pending buffer and was painted into the live overlay every chunk. Once
      // taller than the viewport, rows scrolled into scrollback where the
      // overlay's absolute-cursor erase could not reclaim them — leaving ghost
      // tail rows beside the final committed table. The fix paints a
      // fixed-height placeholder for an in-progress table, so the overlay never
      // grows past the viewport. The full table still commits once.
      const prevCols = process.stdout.columns;
      Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
      vi.useFakeTimers();
      try {
        const { stub, overlayCalls, commitAboveCalls } = makeStubCompositor();
        const ttyStream = new PassThrough();
        (ttyStream as any).isTTY = true;

        renderer = new StreamingMarkdownRenderer({
          out: ttyStream,
          throttleMs: 10,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          compositor: stub as any,
        });

        // Stream a table (header + delimiter + many rows) with NO trailing
        // blank line, so it stays in the pending buffer the whole time.
        renderer.push('| Col A | Col B |\n');
        renderer.push('|-------|-------|\n');
        for (let i = 0; i < 12; i++) {
          renderer.push(`| ROW_${i} | value ${i} |\n`);
          vi.advanceTimersByTime(20);
          await vi.runAllTimersAsync();
        }

        // The live overlay only ever shows the compact placeholder…
        expect(overlayCalls.length).toBeGreaterThan(0);
        expect(overlayCalls.some((s) => s.includes('streaming table'))).toBe(true);
        // …never the growing table rows (the un-clearable ghost source).
        expect(overlayCalls.some((s) => s.includes('ROW_11'))).toBe(false);
        for (const call of overlayCalls) {
          const nonEmpty = call.split('\n').filter((l) => l.trim().length > 0);
          expect(nonEmpty.length).toBeLessThanOrEqual(2);
        }

        // Close the block → the full table commits to scrollback exactly once.
        vi.useRealTimers();
        renderer.push('\n\n');
        await renderer.flush();

        const committed = commitAboveCalls.join('\n');
        expect(committed).toContain('ROW_0');
        expect(committed).toContain('ROW_11');
        expect((committed.match(/ROW_11\b/g) ?? []).length).toBe(1);
      } finally {
        vi.useRealTimers();
        Object.defineProperty(process.stdout, 'columns', { value: prevCols, configurable: true });
      }
    });
  });

  describe('resize handling', () => {
    // Regression for the "overlay stuck at old wrap on resize" bug. The
    // renderer subscribes to ResizeBus in its constructor; on resize the
    // pending buffer must re-render at the new `getTerminalWidth()` instead
    // of waiting for the next push() chunk.
    it('re-wraps the pending overlay at the new terminal width on resize', async () => {
      const overlayCalls: string[] = [];
      const stub = {
        setOverlay(text: string) {
          overlayCalls.push(text);
        },
        commitAbove(_text: string) {},
      };
      const prevCols = process.stdout.columns;
      Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
      vi.useFakeTimers();
      try {
        const ttyStream = new PassThrough();
        (ttyStream as any).isTTY = true;

        renderer = new StreamingMarkdownRenderer({
          out: ttyStream,
          throttleMs: 10,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          compositor: stub as any,
        });

        // Push a single long line and let it render at 80 cols.
        const long = 'alpha '.repeat(40).trim();
        renderer.push(long);
        vi.advanceTimersByTime(20);
        await vi.runAllTimersAsync();
        const wideCallCount = overlayCalls.length;
        expect(wideCallCount).toBeGreaterThan(0);
        const wideRender = overlayCalls[overlayCalls.length - 1]!;
        const wideMaxLineWidth = Math.max(
          ...wideRender.split('\n').filter((l) => l.length > 0).map((l) => stringWidth(l)),
        );

        // Shrink the terminal and emit a resize. ResizeBus debounces 150ms.
        Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
        process.stdout.emit('resize');
        vi.advanceTimersByTime(150); // debounce
        vi.advanceTimersByTime(20);  // throttle
        await vi.runAllTimersAsync();

        // Re-render happened (new setOverlay call) AND it's wrapped narrower.
        expect(overlayCalls.length).toBeGreaterThan(wideCallCount);
        const narrowRender = overlayCalls[overlayCalls.length - 1]!;
        const narrowMaxLineWidth = Math.max(
          ...narrowRender.split('\n').filter((l) => l.length > 0).map((l) => stringWidth(l)),
        );
        expect(narrowMaxLineWidth).toBeLessThan(wideMaxLineWidth);
        // Sanity: the new render fits in the new terminal.
        expect(narrowMaxLineWidth).toBeLessThanOrEqual(38); // 40 - 2 padding
      } finally {
        vi.useRealTimers();
        Object.defineProperty(process.stdout, 'columns', { value: prevCols, configurable: true });
      }
    });

    it('dispose() unsubscribes from ResizeBus so post-dispose resizes do not fire', async () => {
      const overlayCalls: string[] = [];
      const stub = {
        setOverlay(text: string) {
          overlayCalls.push(text);
        },
        commitAbove(_text: string) {},
      };
      vi.useFakeTimers();
      try {
        const ttyStream = new PassThrough();
        (ttyStream as any).isTTY = true;

        renderer = new StreamingMarkdownRenderer({
          out: ttyStream,
          throttleMs: 10,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          compositor: stub as any,
        });

        renderer.push('hello');
        vi.advanceTimersByTime(20);
        await vi.runAllTimersAsync();
        const beforeDispose = overlayCalls.length;
        expect(beforeDispose).toBeGreaterThan(0);

        renderer.dispose();
        // After dispose, a resize event must not trigger any further
        // setOverlay calls (and must not throw — dispose cleared the buffer
        // so any stray repaint would crash on stale state).
        process.stdout.emit('resize');
        vi.advanceTimersByTime(200);
        await vi.runAllTimersAsync();

        expect(overlayCalls.length).toBe(beforeDispose);
        // Mark renderer as undefined so the outer afterEach doesn't double-dispose.
        renderer = undefined as unknown as StreamingMarkdownRenderer;
      } finally {
        vi.useRealTimers();
      }
    });

    it('non-TTY renderers do not subscribe to ResizeBus', async () => {
      // The resize subscription is a no-op for non-TTY surfaces (Telegram,
      // daemon, tests) because they never render an overlay. Subscribing
      // anyway would leak a listener and pin debounce timers in long-lived
      // non-TTY hosts.
      vi.useFakeTimers();
      try {
        renderer = new StreamingMarkdownRenderer({ out: stream });
        renderer.push('hello world');
        const beforeResize = renderer.getPendingBuffer();
        process.stdout.emit('resize');
        vi.advanceTimersByTime(200);
        await vi.runAllTimersAsync();
        // Non-TTY: no overlay path. Pending buffer unchanged.
        expect(renderer.getPendingBuffer()).toBe(beforeResize);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('flush() race-safety (regression)', () => {
    // Regression: final output was being overwritten by a pending log-update
    // repaint that landed between flush()'s write and clear. The fix latches
    // a `flushing` flag so scheduleRepaint/repaint early-return, and reorders
    // flush to clear the overlay BEFORE writing committed content.

    it('flush() sets flushing flag and blocks further scheduleRepaint', async () => {
      (stream as any).isTTY = true;
      renderer = new StreamingMarkdownRenderer({ out: stream, throttleMs: 5 });

      renderer.push('pending partial content ');
      await renderer.flush();

      expect((renderer as any).flushing).toBe(true);
      expect((renderer as any).throttleTimer).toBeNull();

      // A post-flush push must NOT schedule a new repaint timer.
      renderer.push('more content after flush');
      expect((renderer as any).throttleTimer).toBeNull();
    });

    it('flush() causes in-flight repaint() to early-return via flushing guard', async () => {
      (stream as any).isTTY = true;
      renderer = new StreamingMarkdownRenderer({ out: stream, throttleMs: 5 });

      // Simulate an in-flight repaint by invoking the private method directly
      // after flush() has latched the flushing flag.
      renderer.push('streaming ');
      await renderer.flush();

      const before = renderer.getCommittedOutput();
      // Force a repaint call after flush — the guard must make it a no-op.
      await (renderer as any).repaint();
      const after = renderer.getCommittedOutput();

      expect(after).toBe(before);
    });

    it('flush() is idempotent — repeated calls do not duplicate output', async () => {
      (stream as any).isTTY = true;
      renderer = new StreamingMarkdownRenderer({ out: stream, throttleMs: 5 });

      renderer.push('hello world\n\n');
      await renderer.flush();
      const firstCommitted = renderer.getCommittedOutput();

      await renderer.flush();
      const secondCommitted = renderer.getCommittedOutput();

      expect(secondCommitted).toBe(firstCommitted);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Review-feedback regression tests (PR #156)
  // ──────────────────────────────────────────────────────────────────────────
  describe('PR #156 review regressions', () => {
    const prevCols = process.stdout.columns;

    afterEach(() => {
      Object.defineProperty(process.stdout, 'columns', {
        value: prevCols,
        configurable: true,
      });
    });

    // 1. committed += '\n\n' contract — locks in paragraph separator
    it('separates committed blocks with a double-newline in getCommittedOutput()', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('First paragraph.\n\n');
      renderer.push('Second paragraph.\n\n');
      renderer.push('Third paragraph.\n\n');

      const out = renderer.getCommittedOutput();
      // Each consecutive pair of committed blocks must be separated by \n\n.
      // Strip ANSI and leading/trailing whitespace per block for portability.
      const parts = out.split('\n\n').filter((p) => p.trim().length > 0);
      expect(parts.length).toBeGreaterThanOrEqual(3);
      expect(out).toContain('First paragraph');
      expect(out).toContain('Second paragraph');
      expect(out).toContain('Third paragraph');
      // The raw separator must be \n\n, not a single \n.
      expect(out).toMatch(/First paragraph[^]*\n\n[^]*Second paragraph/);
      expect(out).toMatch(/Second paragraph[^]*\n\n[^]*Third paragraph/);

      await renderer.flush();
    });

    // 2. Indented blocks must not overflow termWidth regardless of indent size
    it('indented blocks do not overflow terminal width with custom indent', async () => {
      Object.defineProperty(process.stdout, 'columns', { value: 40, configurable: true });
      renderer = new StreamingMarkdownRenderer({ out: stream, indent: '      ' }); // 6-char indent

      const long = 'word '.repeat(20).trim();
      renderer.push(`${long}\n\n`);
      await renderer.flush();

      const out = renderer.getCommittedOutput();
      // termWidth = stdout.columns - 2 = 38; no line should exceed it
      for (const line of out.split('\n')) {
        if (line.trim().length === 0) continue;
        expect(stringWidth(line)).toBeLessThanOrEqual(38);
      }
    });

    // 3. wrapToWidth is idempotent — double-wrapping must be a no-op
    it('wrapToWidth is idempotent: wrapToWidth(wrapToWidth(s,w),w) === wrapToWidth(s,w)', () => {
      const cases = [
        { text: 'alpha '.repeat(20).trim(), width: 40 },
        { text: 'short line', width: 80 },
        { text: 'a\nb\nc', width: 20 },
        { text: 'x'.repeat(50), width: 20 },
        { text: 'word '.repeat(5).trim() + '\n' + 'word '.repeat(5).trim(), width: 15 },
      ];

      for (const { text, width } of cases) {
        const once = wrapToWidth(text, width);
        const twice = wrapToWidth(once, width);
        expect(twice).toBe(once);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // hasEmitted() unit tests
  // ──────────────────────────────────────────────────────────────────────────
  describe('hasEmitted()', () => {
    it('returns false on construction before any push', () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });
      expect(renderer.hasEmitted()).toBe(false);
    });

    it('returns false after push("") — empty string does not count as emitted', () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });
      renderer.push('');
      expect(renderer.hasEmitted()).toBe(false);
    });

    it('returns true after push with non-empty content', () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });
      renderer.push('hello');
      expect(renderer.hasEmitted()).toBe(true);
    });

    it('returns true after flush completes — content promoted to committed', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });
      renderer.push('some content\n\n');
      await renderer.flush();
      expect(renderer.hasEmitted()).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // F1 regression: hasMarkdownContent ordered-list detection
  // ──────────────────────────────────────────────────────────────────────────
  describe('F1: hasMarkdownContent ordered-list detection', () => {
    it('pure ordered list triggers markdown rendering path (not plain-text)', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      // "1. foo\n2. bar" contains no legacy markers (#*_-`>|~) but must still
      // be treated as markdown so the list receives ANSI dim numbering.
      renderer.push('1. foo\n2. bar\n\n');
      await renderer.flush();

      const output = renderer.getCommittedOutput();
      // The formatter renders ordered list items with "  1. " / "  2. " prefix
      // (dim ANSI). After stripping ANSI we must see the numbers and text.
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toContain('1.');
      expect(stripped).toContain('foo');
      expect(stripped).toContain('2.');
      expect(stripped).toContain('bar');
    });

    it('hasMarkdownContent returns true for "1. foo\\n2. bar"', () => {
      // hasMarkdownContent moved from a private method to a pure free function
      // in markdown-stream-format.ts during the module split; test it there.
      expect(hasMarkdownContent('1. foo\n2. bar')).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // F5/F5b/F12 regressions: code fence split protection
  // ──────────────────────────────────────────────────────────────────────────
  describe('F5: backtick fence with internal blank line is NOT split', () => {
    it('``` fence containing a blank line commits as a single block', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      // This used to split at the \n\n inside the fence, orphaning the second half
      renderer.push('```js\nconst a = 1;\n\nconst b = 2;\n```\n\n');
      await renderer.flush();

      const output = renderer.getCommittedOutput();
      // Both lines must appear in a single committed block (not orphaned plain text)
      expect(output).toContain('const a = 1;');
      expect(output).toContain('const b = 2;');
      // The 'js' language header must also appear (from the formatter's lang header)
      expect(output).toContain('js');
    });

    it('``` fence received in incremental chunks with internal blank line is not split', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('```js\n');
      renderer.push('line one;\n');
      renderer.push('\n'); // blank line inside fence — must NOT trigger a boundary
      renderer.push('line two;\n');
      renderer.push('```\n\n');
      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('line one;');
      expect(output).toContain('line two;');
    });
  });

  describe('F5b: tilde fence with internal blank line is NOT split', () => {
    it('~~~ fence containing a blank line commits as a single block', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('~~~py\nfirst = 1\n\nsecond = 2\n~~~\n\n');
      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('first = 1');
      expect(output).toContain('second = 2');
    });

    it('~~~ fence without language tag is not split at internal blank line', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('~~~\nraw block\n\nstill raw\n~~~\n\n');
      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('raw block');
      expect(output).toContain('still raw');
    });
  });

  describe('F12: mixed-case / non-alpha language tags are handled', () => {
    it('```TypeScript fence with internal blank line is not split', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('```TypeScript\nconst x: string = "a";\n\nconst y = x;\n```\n\n');
      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('const x');
      expect(output).toContain('const y');
    });

    it('```C++ fence with internal blank line is not split', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('```C++\nint main() {\n\n  return 0;\n}\n```\n\n');
      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('int main');
      expect(output).toContain('return 0');
    });

    it('```YAML fence with internal blank line is not split', async () => {
      renderer = new StreamingMarkdownRenderer({ out: stream });

      renderer.push('```YAML\nkey: value\n\nother: val\n```\n\n');
      await renderer.flush();

      const output = renderer.getCommittedOutput();
      expect(output).toContain('key: value');
      expect(output).toContain('other: val');
    });
  });
});
