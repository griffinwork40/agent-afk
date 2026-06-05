/**
 * Regression tests for the non-TTY autocomplete reader.
 *
 * Key invariant: queued REPL input (`opts.initialBuffer`) must surface on
 * non-TTY surfaces (pipes, CI) without consuming stdin. The TTY path
 * pre-seeds the input core with the buffer; the non-TTY path returns it
 * directly as the read result so the message the user already pressed
 * Enter on is not silently lost.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Interface as ReadlineInterface } from 'readline';
import { readNonTty } from './non-tty.js';

function fakeRl(): ReadlineInterface {
  return {
    setPrompt: vi.fn(),
    prompt: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
  } as unknown as ReadlineInterface;
}

describe('readNonTty / initialBuffer', () => {
  it('returns initialBuffer immediately without touching stdin', async () => {
    const rl = fakeRl();
    const result = await readNonTty({
      rl,
      promptFn: () => '> ',
      initialBuffer: 'queued message',
    });
    expect(result.text).toBe('queued message');
    expect(result.attachments).toEqual([]);
    // Critical: stdin readline machinery is never engaged.
    expect(rl.prompt).not.toHaveBeenCalled();
    expect(rl.once).not.toHaveBeenCalled();
  });

  it('falls through to readline when initialBuffer is empty string', async () => {
    // Empty buffer is semantically "no queued input" — the reader should
    // block on stdin as usual rather than returning ''.
    const rl = fakeRl();
    // Capture the 'line' listener so we can fire it manually.
    let lineHandler: ((line: string) => void) | null = null;
    (rl.once as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: (line: string) => void) => {
        if (event === 'line') lineHandler = handler;
        return rl;
      },
    );
    const p = readNonTty({
      rl,
      promptFn: () => '> ',
      initialBuffer: '',
    });
    // Wait a tick so the readNonTty awaits the line promise.
    await new Promise((r) => setImmediate(r));
    expect(lineHandler).not.toBeNull();
    lineHandler!('typed input');
    const result = await p;
    expect(result.text).toBe('typed input');
  });

  it('falls through to readline when initialBuffer is undefined', async () => {
    const rl = fakeRl();
    let lineHandler: ((line: string) => void) | null = null;
    (rl.once as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, handler: (line: string) => void) => {
        if (event === 'line') lineHandler = handler;
        return rl;
      },
    );
    const p = readNonTty({ rl, promptFn: () => '> ' });
    await new Promise((r) => setImmediate(r));
    lineHandler!('typed input');
    const result = await p;
    expect(result.text).toBe('typed input');
  });
});
