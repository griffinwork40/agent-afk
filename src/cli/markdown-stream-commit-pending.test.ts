import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StreamingMarkdownRenderer } from './markdown-stream.js';
import { PassThrough } from 'node:stream';

/**
 * Tests for StreamingMarkdownRenderer.commitPending()
 *
 * Regression test for the bug where orchestrator text without a trailing
 * block boundary (no \n\n) gets stuck in the overlay and leaks into
 * scrollback every time a subagent progress event triggers commitAbove().
 *
 * The fix adds commitPending() to explicitly flush pending buffer to
 * scrollback when a tool_use or tool_result chunk arrives — at that moment,
 * the preceding text content is finalized by the SDK's content model, so
 * it's safe to commit immediately without waiting for the next boundary.
 */

describe('StreamingMarkdownRenderer.commitPending()', () => {
  let stream: PassThrough;
  let renderer: StreamingMarkdownRenderer;

  beforeEach(() => {
    stream = new PassThrough();
    (stream as any).isTTY = false;
  });

  afterEach(() => {
    renderer?.dispose();
    stream?.destroy();
  });

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

  it('should commit pending buffer to scrollback and clear overlay', async () => {
    const { stub, overlayCalls, commitAboveCalls } = makeStubCompositor();
    const ttyStream = new PassThrough();
    (ttyStream as any).isTTY = true;

    renderer = new StreamingMarkdownRenderer({
      out: ttyStream,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stub as any,
    });

    // Push text without a block boundary (no \n\n) — simulates orchestrator's
    // "Dispatching three parallel reconnaissance sub-agents."
    renderer.push('Dispatching three parallel reconnaissance sub-agents.');

    // Before commitPending, the text should be in pending buffer (no boundary detected)
    expect(renderer.getPendingBuffer()).toContain('Dispatching');
    expect(commitAboveCalls.length).toBe(0);

    // Simulate the text being redrawn via repaint (it goes to overlay)
    vi.useFakeTimers();
    renderer.push(''); // Force a repaint to be scheduled
    vi.advanceTimersByTime(50);
    await vi.runAllTimersAsync();
    vi.useRealTimers();

    // Overlay should contain the dispatching text
    expect(overlayCalls.some((s) => s.includes('Dispatching'))).toBe(true);

    // Now call commitPending() as turn-handler does when tool_use arrives
    renderer.commitPending();

    // Buffer should be drained
    expect(renderer.getPendingBuffer()).toBe('');

    // Text should now be committed to scrollback (via commitAbove)
    expect(commitAboveCalls.length).toBeGreaterThan(0);
    expect(commitAboveCalls.some((s) => s.includes('Dispatching'))).toBe(true);

    // Overlay should be cleared
    expect(overlayCalls.at(-1)).toBe('');

    await renderer.flush();
  });

  it('should be a no-op if buffer is empty or whitespace-only', async () => {
    const { stub, commitAboveCalls, overlayCalls } = makeStubCompositor();
    const ttyStream = new PassThrough();
    (ttyStream as any).isTTY = true;

    renderer = new StreamingMarkdownRenderer({
      out: ttyStream,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stub as any,
    });

    // Initially empty
    renderer.commitPending();

    expect(commitAboveCalls.length).toBe(0);
    expect(overlayCalls.length).toBe(0);

    // Push only whitespace
    renderer.push('   \n  \n');

    const beforeCommitAbove = commitAboveCalls.length;
    renderer.commitPending();

    // Should not have committed whitespace-only content
    expect(commitAboveCalls.length).toBe(beforeCommitAbove);

    await renderer.flush();
  });

  it('should drain buffer and be available for new content after commitPending', async () => {
    const { stub, commitAboveCalls } = makeStubCompositor();
    const ttyStream = new PassThrough();
    (ttyStream as any).isTTY = true;

    renderer = new StreamingMarkdownRenderer({
      out: ttyStream,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stub as any,
    });

    // First text (no boundary)
    renderer.push('Part 1');
    renderer.commitPending();

    expect(commitAboveCalls.length).toBe(1);
    expect(commitAboveCalls[0]).toContain('Part 1');
    expect(renderer.getPendingBuffer()).toBe('');

    // Second text (after clearing)
    renderer.push('Part 2');
    expect(renderer.getPendingBuffer()).toBe('Part 2');

    renderer.commitPending();
    expect(commitAboveCalls.length).toBe(2);
    expect(commitAboveCalls[1]).toContain('Part 2');

    await renderer.flush();
  });

  it('should work in non-compositor mode (legacy path)', async () => {
    renderer = new StreamingMarkdownRenderer({ out: stream });

    renderer.push('Text without boundary');

    // Should be pending
    expect(renderer.getPendingBuffer()).toContain('Text');
    expect(renderer.getCommittedOutput()).toBe('');

    // commitPending() should work even without a compositor
    renderer.commitPending();

    // Buffer should be drained
    expect(renderer.getPendingBuffer()).toBe('');

    // Text should be in committed output
    expect(renderer.getCommittedOutput()).toContain('Text');

    await renderer.flush();
  });
});

/**
 * Tests for StreamingMarkdownRenderer.discardPending()
 *
 * discardPending() is the counterpart to commitPending(): it drops the pending
 * (uncommitted) buffer WITHOUT writing it to scrollback. Used on a mid-stream
 * overload re-drive (anthropic-direct `stream.retry`) where the partial text
 * streamed before the overload will be re-streamed from scratch — committing
 * it would duplicate it. The load-bearing invariant under test: discardPending
 * must NEVER call commitAbove / write committed output.
 */
describe('StreamingMarkdownRenderer.discardPending()', () => {
  let stream: PassThrough;
  let renderer: StreamingMarkdownRenderer;

  beforeEach(() => {
    stream = new PassThrough();
    (stream as any).isTTY = false;
  });

  afterEach(() => {
    renderer?.dispose();
    stream?.destroy();
  });

  function makeStubCompositor() {
    const overlayCalls: string[] = [];
    const commitAboveCalls: string[] = [];
    const stub = {
      setOverlay(text: string) { overlayCalls.push(text); },
      commitAbove(text: string) { commitAboveCalls.push(text); },
      arm: async () => {},
      disarm: () => {},
      getBuffer: () => ({ text: '', queued: false }),
      isArmed: () => true,
    };
    return { stub, overlayCalls, commitAboveCalls };
  }

  it('discards the pending buffer and clears the overlay WITHOUT committing to scrollback', () => {
    const { stub, overlayCalls, commitAboveCalls } = makeStubCompositor();
    const ttyStream = new PassThrough();
    (ttyStream as any).isTTY = true;

    renderer = new StreamingMarkdownRenderer({
      out: ttyStream,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stub as any,
    });

    // Partial text streamed before a mid-stream overload (no block boundary).
    renderer.push('The answer is ');
    expect(renderer.getPendingBuffer()).toContain('The answer is');

    renderer.discardPending();

    // Buffer drained — the partial text is gone, NOT committed to scrollback.
    expect(renderer.getPendingBuffer()).toBe('');
    // The whole point of discardPending vs commitPending: no scrollback commit.
    expect(commitAboveCalls.length).toBe(0);
    // Overlay cleared so the discarded text vanishes from the screen.
    expect(overlayCalls.at(-1)).toBe('');
  });

  it('leaves the renderer reusable so the retry re-stream starts clean', () => {
    const { stub, commitAboveCalls } = makeStubCompositor();
    const ttyStream = new PassThrough();
    (ttyStream as any).isTTY = true;
    renderer = new StreamingMarkdownRenderer({
      out: ttyStream,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stub as any,
    });

    renderer.push('stale partial');
    renderer.discardPending();
    expect(renderer.getPendingBuffer()).toBe('');

    // The retry re-streams from scratch into the same renderer instance.
    renderer.push('fresh full answer');
    expect(renderer.getPendingBuffer()).toBe('fresh full answer');
    // Still nothing committed (no boundary yet) — and crucially no 'stale'.
    expect(commitAboveCalls.length).toBe(0);
  });

  it('does NOT move text to committed output in non-compositor mode', () => {
    renderer = new StreamingMarkdownRenderer({ out: stream });

    renderer.push('partial before overload');
    expect(renderer.getPendingBuffer()).toContain('partial');

    renderer.discardPending();

    expect(renderer.getPendingBuffer()).toBe('');
    // Unlike commitPending(), discardPending must NOT promote text to committed.
    expect(renderer.getCommittedOutput()).toBe('');
  });

  it('is a no-op on an empty buffer', () => {
    const { stub, commitAboveCalls } = makeStubCompositor();
    const ttyStream = new PassThrough();
    (ttyStream as any).isTTY = true;
    renderer = new StreamingMarkdownRenderer({
      out: ttyStream,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      compositor: stub as any,
    });
    expect(() => renderer.discardPending()).not.toThrow();
    expect(renderer.getPendingBuffer()).toBe('');
    expect(commitAboveCalls.length).toBe(0);
  });
});
