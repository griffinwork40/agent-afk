/**
 * Tests for TerminalCompositor — multi-message queue.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369).
 * Shared mock factories live in ./terminal-compositor.test-helpers.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('TerminalCompositor — multi-message queue', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
  });

  it('queuing 3 messages mid-stream increments pendingCount and drains FIFO in order', async () => {
    const onSubmit = vi.fn();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
    await c.arm();

    // Helper: type text + press Enter (commits, clears live buffer).
    const typeAndEnter = (text: string) => {
      for (const ch of text) stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return' });
    };

    typeAndEnter('one');
    expect(c.getBuffer()).toEqual({ text: '', queued: true });
    expect(c.getPendingCount()).toBe(1);

    typeAndEnter('two');
    expect(c.getBuffer()).toEqual({ text: '', queued: true });
    expect(c.getPendingCount()).toBe(2);

    typeAndEnter('three');
    expect(c.getBuffer()).toEqual({ text: '', queued: true });
    expect(c.getPendingCount()).toBe(3);

    // Drain first payload: streaming → idle delivers 'one' (oldest).
    c.setInputMode('idle');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenLastCalledWith({ text: 'one', attachments: [] });
    expect(c.getPendingCount()).toBe(2);

    // Drain second: streaming → idle delivers 'two'.
    c.setInputMode('streaming');
    c.setInputMode('idle');
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith({ text: 'two', attachments: [] });
    expect(c.getPendingCount()).toBe(1);

    // Drain third: streaming → idle delivers 'three'.
    c.setInputMode('streaming');
    c.setInputMode('idle');
    expect(onSubmit).toHaveBeenCalledTimes(3);
    expect(onSubmit).toHaveBeenLastCalledWith({ text: 'three', attachments: [] });
    expect(c.getPendingCount()).toBe(0);
    expect(c.getBuffer()).toEqual({ text: '', queued: false });
  });

  it('in-progress draft survives draining a queued message', async () => {
    const onSubmit = vi.fn();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
    await c.arm();

    // Commit one message.
    for (const ch of 'queued') stdin.emit('keypress', ch, { name: ch, sequence: ch });
    stdin.emit('keypress', undefined, { name: 'return' });
    expect(c.getPendingCount()).toBe(1);

    // Type a second message WITHOUT Enter — live buffer = 'draft'.
    for (const ch of 'draft') stdin.emit('keypress', ch, { name: ch, sequence: ch });
    expect(c.getBuffer()).toEqual({ text: 'draft', queued: true });
    expect(c.getPendingCount()).toBe(1);

    // Drain the committed 'queued' message.
    c.setInputMode('idle');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ text: 'queued', attachments: [] });

    // Live buffer 'draft' is intact; queue is empty.
    expect(c.getBuffer().text).toBe('draft');
    expect(c.getPendingCount()).toBe(0);
    expect(c.getBuffer().queued).toBe(false);
  });

  it('render indicator shows [queued] for 1 and [N queued] for N>1', async () => {
    const writes = collectWrites(stdout);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();

    // Commit first message → render should show '[queued]'.
    writes.clear();
    for (const ch of 'msg1') stdin.emit('keypress', ch, { name: ch, sequence: ch });
    stdin.emit('keypress', undefined, { name: 'return' });
    expect(writes.all()).toContain('[queued]');

    // Commit second message → render should show '[2 queued]'.
    writes.clear();
    for (const ch of 'msg2') stdin.emit('keypress', ch, { name: ch, sequence: ch });
    stdin.emit('keypress', undefined, { name: 'return' });
    expect(writes.all()).toContain('[2 queued]');
  });

  it('↑ pulls the newest queued message (LIFO) for editing and re-Enter re-commits it', async () => {
    const onSubmit = vi.fn();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSubmit });
    await c.arm();

    const typeAndEnter = (text: string) => {
      for (const ch of text) stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return' });
    };

    typeAndEnter('one');
    typeAndEnter('two');
    expect(c.getPendingCount()).toBe(2);

    // ↑ on the (empty) live buffer pulls the NEWEST queued message ('two')
    // back for editing; the older 'one' stays queued.
    stdin.emit('keypress', undefined, { name: 'up' });
    expect(c.getBuffer()).toEqual({ text: 'two', queued: true });
    expect(c.getPendingCount()).toBe(1);

    // Edit the recalled draft and re-Enter → re-commits to the BACK of the FIFO.
    stdin.emit('keypress', '!', { name: '!', sequence: '!' });
    stdin.emit('keypress', undefined, { name: 'return' });
    expect(c.getBuffer()).toEqual({ text: '', queued: true });
    expect(c.getPendingCount()).toBe(2);

    // Drain: FIFO order is 'one' (oldest) then the edited 'two!'.
    c.setInputMode('idle');
    expect(onSubmit).toHaveBeenLastCalledWith({ text: 'one', attachments: [] });
    c.setInputMode('streaming');
    c.setInputMode('idle');
    expect(onSubmit).toHaveBeenLastCalledWith({ text: 'two!', attachments: [] });
    expect(c.getPendingCount()).toBe(0);
  });

  it('↑ does not pull the queue while the live buffer holds a draft', async () => {
    // The queued-message pull is gated on an EMPTY buffer. With a draft in
    // progress and no history wired, ↑ is a no-op — the draft and the queue
    // are both preserved (↑ never clobbers an in-progress message).
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    for (const ch of 'queued') stdin.emit('keypress', ch, { name: ch, sequence: ch });
    stdin.emit('keypress', undefined, { name: 'return' }); // commits 'queued', buffer → ''
    expect(c.getPendingCount()).toBe(1);
    for (const ch of 'draft') stdin.emit('keypress', ch, { name: ch, sequence: ch });
    stdin.emit('keypress', undefined, { name: 'up' }); // buffer non-empty → gate blocks the pull
    expect(c.getBuffer()).toEqual({ text: 'draft', queued: true });
    expect(c.getPendingCount()).toBe(1);
  });
});


