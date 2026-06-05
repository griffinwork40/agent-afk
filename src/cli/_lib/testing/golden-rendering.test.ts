/**
 * Golden regression tests for TUI rendering
 *
 * These tests wire the REAL compositor/renderer, capture its stdout bytes IN ORDER,
 * feed them to a VirtualScreen, and assert screen state. The goal is to catch
 * corruption in the compositor's overlay / scrollback interaction, wide-character
 * handling, and markdown rendering concurrency.
 *
 * @module cli/_lib/testing/golden-rendering
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from '../../terminal-compositor.js';
import { VirtualScreen } from './virtual-screen.js';

type MockStdout = NodeJS.WriteStream & {
  isTTY: boolean;
  columns: number;
  rows: number;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: unknown[]) => void): MockStdout;
};

type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): boolean;
};

function makeMockStdout(isTTY = true): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = isTTY;
  s.columns = 80;
  s.rows = 24;
  return s;
}

function makeMockStdin(isTTY = true): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = isTTY;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

/**
 * Collect raw Buffer chunks from stdout and feed them to VirtualScreen in order.
 * This preserves multibyte splits and the true byte order the terminal sees.
 */
function setupByteCapture(
  stream: MockStdout,
  vscreen: VirtualScreen,
): { chunks: Buffer[] } {
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: unknown) => {
    if (chunk instanceof Buffer || Buffer.isBuffer(chunk)) {
      chunks.push(chunk as Buffer);
      vscreen.write(chunk as Buffer); // Feed to VirtualScreen immediately
    } else if (typeof chunk === 'string') {
      const buf = Buffer.from(chunk, 'utf-8');
      chunks.push(buf);
      vscreen.write(buf);
    }
  });
  return { chunks };
}

describe('Golden rendering tests', () => {
  // Guaranteed teardown: arm() subscribes to the global ResizeBus, which on a
  // real TTY registers a process-level SIGWINCH listener that keeps Node's
  // event loop alive until disarm() unsubscribes. A failing assertion mid-test
  // would otherwise skip an inline disarm() and leak that listener → the test
  // process hangs. Track every compositor and disarm in afterEach so cleanup
  // runs even when an assertion throws. (Teardown registered before any test
  // body runs — inverse of arm.)
  const armed: TerminalCompositor[] = [];
  afterEach(() => {
    while (armed.length > 0) {
      try {
        armed.pop()?.disarm();
      } catch {
        /* idempotent; ignore */
      }
    }
    vi.useRealTimers();
  });

  /**
   * TEST 1: Boot logo survives first overlay
   *
   * Regression: overlay overdraws the boot logo (commitAbove content)
   * Expected: FAIL on current code (overlay clobbers banner)
   * Goal: Verify commitAbove content stays in scrollback and doesn't vanish
   */
  describe('test 1: Boot logo survives first overlay', () => {
    it('banner text remains visible after setOverlay', async () => {
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const vscreen = new VirtualScreen(80, 24);

      setupByteCapture(stdout, vscreen);

      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      armed.push(c);
      await c.arm();

      // Write a multi-line banner via commitAbove
      c.commitAbove('Welcome Banner\nLine 2\nLine 3');

      // Now set an overlay (e.g., a tool tree or in-progress markdown)
      c.setOverlay('Tool Tree:\n  Task 1\n  Task 2');

      // Guard (currently GREEN): the committed banner must survive into
      // scrollback/visible and the overlay must reach the visible frame. This
      // is a correctness invariant the refactor must preserve, not a current
      // repro of the boot-logo overdraw (that needs the real boot-print +
      // anchorRow path and is exercised manually in Wave 4).
      const screenAll = vscreen.screenText();
      expect(screenAll).toContain('Welcome');
      expect(screenAll).toContain('Banner');
      // Review #592 BLOCKER-2 gate: the BOTTOM committed line must also survive
      // overlay growth (pre-fix the off-by-one eviction clobbered it).
      expect(screenAll).toContain('Line 2');
      expect(screenAll).toContain('Line 3');
      expect(vscreen.visibleLines().join('\n')).toContain('Tool Tree');
    });
  });

  /**
   * TEST 2: Concurrent markdown + tool-tree don't clobber
   *
   * Regression: sub-agent tree interleaves with streamed markdown, scrambled paragraphs
   * Expected: FAIL on current code (last-writer-wins: only overlay or markdown visible)
   * Goal: Verify both markdown and overlay present after concurrent writes
   */
  describe('test 2: Concurrent markdown + tool-tree renders without clobber', () => {
    it('markdown pending + tool-tree compose into one visible frame (no clobber)', async () => {
      // Regression: the markdown renderer's 33ms-timer setOverlay and the
      // tool-lane setOverlay clobbered one another on the single overlay slot
      // (last-writer-wins). The fix routes BOTH through OverlayComposer so they
      // compose into one setOverlay call.
      //
      // This drives the REAL components — a real StreamingMarkdownRenderer
      // (whose throttled repaint now marks the composer dirty + flushes) and a
      // real ToolLane — through a real TerminalCompositor, then asserts the
      // VISIBLE frame the user sees contains BOTH at once. Pre-fix, the
      // markdown repaint's direct setOverlay would clobber the tool-lane frame
      // and one token would be missing.
      const { OverlayComposer } = await import('../overlay-composer.js');
      const { StreamingMarkdownRenderer } = await import('../../markdown-stream.js');
      const { ToolLane } = await import('../../commands/interactive/tool-lane.js');

      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const vscreen = new VirtualScreen(80, 24);
      setupByteCapture(stdout, vscreen);

      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      armed.push(c);
      await c.arm();

      // Real composer sinks into the real compositor's setOverlay.
      const composer = new OverlayComposer(c, [
        'thinking-live',
        'markdown-pending',
        'tool-lane',
        'progress-banner',
        'stage-rail',
      ]);
      // Real markdown renderer wired to the composer (not a direct setOverlay).
      const markdown = new StreamingMarkdownRenderer({ out: stdout, overlayComposer: composer });
      const toolLane = new ToolLane();
      composer.register({ key: 'markdown-pending', render: () => markdown.renderPending() });
      composer.register({
        key: 'tool-lane',
        render: () => (toolLane.hasPending() ? toolLane.getOverlay() : ''),
      });

      try {
        // A sub-agent tool event updates the shared tool-lane.
        toolLane.addStart('tool-1', 'web_search', '{"q":"x"}');
        composer.markDirty('tool-lane');
        composer.flush();

        // Orchestrator markdown streams in (no blank line, so it stays in the
        // live pending buffer) — scheduling the 33ms throttle.
        vi.useFakeTimers();
        markdown.push('ZEBRAPROSE streaming inline');
        // Fire the throttle: the markdown repaint composes THROUGH the composer.
        await vi.advanceTimersByTimeAsync(50);

        const visible = vscreen.visibleLines().join('\n');
        expect(visible).toContain('ZEBRAPROSE'); // markdown pending block survived
        expect(visible).toContain('web_search'); // tool-tree survived in the SAME frame
      } finally {
        markdown.dispose();
      }
    });
  });

  describe('test 3: Wide line wrapping with correct scrollback', () => {
    // Converted from it.fails: the single-copy commitAbove fix (WIP commit
    // e8b6d9f0) makes this assertion pass. Phase 1 now emits LF-only scrolls;
    // Phase 3 writes exactly one copy of the text above the live frame.
    // A 150-char line with 80-col terminal → soft-wraps to 2 rows but the
    // VirtualScreen sees exactly 150 'X' characters (1 copy), not 300 (2 copies
    // from the old dual-write). Note: the compositor is wrap-blind (lineCount =
    // newline-count = 1 for a single long line) — it opens only 1 scroll slot
    // and writes the full 150-char string at row 22. The VirtualScreen counts
    // all 'X' characters across scroll+viewport, so soft-wrapping at row 22-23
    // still yields 150 total.
    // TODO(review #592): compositor is wrap-blind — a soft-wrapping line opens 1 scroll slot but occupies 2 visual rows (potential 1-row drift). Track separately.
    it('long text wraps correctly and appears in scrollback', async () => {
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const vscreen = new VirtualScreen(80, 24);

      setupByteCapture(stdout, vscreen);

      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      armed.push(c);
      await c.arm();

      // Write a very long line that exceeds 80 columns
      const longLine = 'X'.repeat(150);
      c.commitAbove(longLine);

      // The committed line is 150 'X' chars total. On an 80-col terminal it
      // wraps to 2 physical rows but is still exactly 150 characters of content.
      const allText = vscreen.screenText();
      const xCount = (allText.match(/X/g) ?? []).length;

      // RED on current code: commitAbove is wrap-blind (lineCount = newline
      // count = 1, ignoring the soft-wrap to 2 rows) AND its 3-phase dance
      // paints the text twice (phase-1 scrolls it to scrollback, phase-3
      // re-paints it above the live frame) → the VirtualScreen sees 300 X's.
      // GREEN after Wave 2 Track B: wrap-aware ScrollbackCommitter + single
      // paint → exactly 150.
      expect(xCount).toBe(150);
    });
  });

  describe('test 4: No replacement char (�) for wide/box-drawing content', () => {
    it('renders box-drawing and emoji without producing invalid UTF-8', async () => {
      const stdout = makeMockStdout();
      const stdin = makeMockStdin();
      const vscreen = new VirtualScreen(80, 24);

      setupByteCapture(stdout, vscreen);

      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      armed.push(c);
      await c.arm();

      // Write content with box-drawing and emoji
      const content = '┌─────┐\n│ Box │\n└─────┘\nEmoji: 😀 ◉ ▀';
      c.commitAbove(content);

      const screenAll = vscreen.screenText();

      // Should NOT contain replacement character
      expect((screenAll.match(/�/g) ?? []).length).toBe(0);

      // Should contain the original characters
      expect(screenAll).toContain('Box');
      expect(screenAll).toContain('Emoji');
    });
  });
});
