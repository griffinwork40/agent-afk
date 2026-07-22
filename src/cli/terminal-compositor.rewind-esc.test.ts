/**
 * Tests for the double-Esc rewind trigger in the compositor's idle-mode
 * Escape handler (the "press Esc twice to edit a previous message" affordance).
 *
 * Contract:
 *   - Two Escapes at an EMPTY idle prompt (within the double-tap window) fire
 *     `onRewindRequest` exactly once.
 *   - A single idle Esc only arms the window — no fire.
 *   - Escapes with a non-empty draft never fire (and leave the draft alone).
 *   - Streaming-mode Esc is unchanged (soft-stop, not rewind).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

describe('TerminalCompositor — double-Esc rewind trigger', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    __resetStdinClaimForTests();
  });

  it('double-Esc at an empty idle prompt fires onRewindRequest once', async () => {
    const onRewindRequest = vi.fn();
    const c = new TerminalCompositor({ stdout, stdin });
    await c.arm();
    c.setInputMode('idle');
    c.setOnRewindRequest(onRewindRequest);

    stdin.emit('keypress', undefined, { name: 'escape' }); // arms
    stdin.emit('keypress', undefined, { name: 'escape' }); // fires
    expect(onRewindRequest).toHaveBeenCalledTimes(1);
  });

  it('a single idle Esc only arms — does not fire', async () => {
    const onRewindRequest = vi.fn();
    const c = new TerminalCompositor({ stdout, stdin });
    await c.arm();
    c.setInputMode('idle');
    c.setOnRewindRequest(onRewindRequest);

    stdin.emit('keypress', undefined, { name: 'escape' });
    expect(onRewindRequest).not.toHaveBeenCalled();
  });

  it('does not fire when the input buffer is non-empty', async () => {
    const onRewindRequest = vi.fn();
    const c = new TerminalCompositor({ stdout, stdin });
    await c.arm();
    c.setInputMode('idle');
    c.setOnRewindRequest(onRewindRequest);

    for (const ch of 'draft') stdin.emit('keypress', ch, { name: ch, sequence: ch });
    stdin.emit('keypress', undefined, { name: 'escape' });
    stdin.emit('keypress', undefined, { name: 'escape' });

    expect(onRewindRequest).not.toHaveBeenCalled();
    // The draft is untouched — idle Esc is a no-op for typed text.
    expect(c.getBuffer().text).toBe('draft');
  });

  it('a third Esc after firing re-arms rather than double-firing', async () => {
    const onRewindRequest = vi.fn();
    const c = new TerminalCompositor({ stdout, stdin });
    await c.arm();
    c.setInputMode('idle');
    c.setOnRewindRequest(onRewindRequest);

    stdin.emit('keypress', undefined, { name: 'escape' }); // arm
    stdin.emit('keypress', undefined, { name: 'escape' }); // fire (1)
    stdin.emit('keypress', undefined, { name: 'escape' }); // re-arm (window reset)
    expect(onRewindRequest).toHaveBeenCalledTimes(1);
    stdin.emit('keypress', undefined, { name: 'escape' }); // fire (2)
    expect(onRewindRequest).toHaveBeenCalledTimes(2);
  });

  it('streaming-mode Esc still soft-stops and never fires rewind', async () => {
    const onRewindRequest = vi.fn();
    const onSoftStop = vi.fn();
    const c = new TerminalCompositor({ stdout, stdin, onSoftStop });
    await c.arm();
    c.setInputMode('streaming');
    c.setOnRewindRequest(onRewindRequest);

    stdin.emit('keypress', undefined, { name: 'escape' });
    stdin.emit('keypress', undefined, { name: 'escape' });

    expect(onSoftStop).toHaveBeenCalledTimes(1);
    expect(onRewindRequest).not.toHaveBeenCalled();
  });
});
