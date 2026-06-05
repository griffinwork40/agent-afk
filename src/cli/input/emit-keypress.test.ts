import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spy on the readline primitive so we can assert the escapeCodeTimeout
// contract — the timeout itself cannot be exercised via the synchronous
// `stdin.emit('keypress', ...)` path the other suites use (that bypasses
// Node's escape-sequence decoder entirely).
const { emitKeypressEventsSpy } = vi.hoisted(() => ({ emitKeypressEventsSpy: vi.fn() }));
vi.mock('readline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('readline')>();
  return { ...actual, emitKeypressEvents: emitKeypressEventsSpy };
});

import { emitKeypressEventsImmediateEscape } from './emit-keypress.js';

describe('emitKeypressEventsImmediateEscape', () => {
  beforeEach(() => emitKeypressEventsSpy.mockClear());

  it('attaches keypress events with a sub-perception escapeCodeTimeout so a lone ESC fires on the first press', () => {
    // Regression guard for the "ESC needs two presses" bug: Node's default
    // 500ms keyseq-timeout buffers a chunk-trailing ESC. A small nonzero
    // timeout (50ms) fires lone-ESC well below perceptible latency while
    // still leaving a reassembly window so a split escape sequence (e.g. a
    // TCP-fragmented `\x1b[200~` paste start over SSH) is not misread as a
    // bare ESC and fired as soft-stop/cancel — see emit-keypress.ts and
    // Codex review #626. The timeout must stay > 0 and below ~100ms; if a
    // refactor drops the option or restores the 500ms default, ESC latency
    // returns.
    const fakeStream = {} as NodeJS.ReadableStream;
    emitKeypressEventsImmediateEscape(fakeStream);
    expect(emitKeypressEventsSpy).toHaveBeenCalledTimes(1);
    const [stream, opts] = emitKeypressEventsSpy.mock.calls[0] as [
      NodeJS.ReadableStream,
      { escapeCodeTimeout: number },
    ];
    expect(stream).toBe(fakeStream);
    expect(opts.escapeCodeTimeout).toBeGreaterThan(0);
    expect(opts.escapeCodeTimeout).toBeLessThanOrEqual(100);
  });
});
