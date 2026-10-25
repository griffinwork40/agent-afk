import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReplInteractions } from './interaction.repl.js';
import { renderSelector } from '../input/selectors.js';
import type { SlashContext } from './types.js';

const { start, stop, spinner, oraFactory } = vi.hoisted(() => {
  const start = vi.fn();
  const stop = vi.fn();
  const spinner = { start, stop, text: '' };
  start.mockReturnValue(spinner);
  return { start, stop, spinner, oraFactory: vi.fn(() => spinner) };
});
vi.mock('ora', () => ({ default: oraFactory }));
vi.mock('../input/selectors.js', () => ({ renderSelector: vi.fn() }));

const stdinTTY = process.stdin.isTTY;
const stdoutTTY = process.stdout.isTTY;
function tty(value: boolean) {
  (process.stdin as { isTTY?: boolean }).isTTY = value;
  (process.stdout as { isTTY?: boolean }).isTTY = value;
}
function setup() {
  const compositor = { suspendInput: vi.fn(), resumeInput: vi.fn(), setSpinner: vi.fn() };
  const out = { info: vi.fn() } as unknown as SlashContext['out'];
  const getCompositor = vi.fn(() => compositor as unknown as ReturnType<NonNullable<SlashContext['getCompositor']>>);
  return { compositor, out, getCompositor, ...createReplInteractions({ out, getCompositor }) };
}
const request = {
  corrId: 'c1', title: 'Pick one', default: 'b', cancellable: true,
  options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta', description: 'second' }],
};
beforeEach(() => { vi.clearAllMocks(); tty(true); });
afterEach(() => {
  (process.stdin as { isTTY?: boolean }).isTTY = stdinTTY;
  (process.stdout as { isTTY?: boolean }).isTTY = stdoutTTY;
});

describe('REPL slash interaction adapter', () => {
  it('maps default-first labels to values and restores compositor input', async () => {
    vi.mocked(renderSelector).mockResolvedValue(0);
    const ctx = setup();
    expect(await ctx.choose(request)).toBe('b');
    expect(renderSelector).toHaveBeenCalledWith(['Beta — second', 'Alpha'], expect.any(AbortSignal));
    expect(request.options[0]?.value).toBe('a');
    expect(ctx.out.info).toHaveBeenCalledWith('Pick one');
    expect(ctx.compositor.suspendInput).toHaveBeenCalledOnce();
    expect(ctx.compositor.resumeInput).toHaveBeenCalledOnce();
  });

  it.each([':cancel', null] as const)('maps selector %s to null', async (answer) => {
    vi.mocked(renderSelector).mockResolvedValue(answer);
    const ctx = setup();
    expect(await ctx.choose(request)).toBeNull();
    expect(ctx.compositor.resumeInput).toHaveBeenCalledOnce();
  });

  it('restores input after a selector error', async () => {
    vi.mocked(renderSelector).mockRejectedValue(new Error('selector failed'));
    const ctx = setup();
    await expect(ctx.choose(request)).rejects.toThrow('selector failed');
    expect(ctx.compositor.resumeInput).toHaveBeenCalledOnce();
  });

  it('non-TTY choose is cancellation without taking terminal input', async () => {
    tty(false);
    const ctx = setup();
    expect(await ctx.choose(request)).toBeNull();
    expect(renderSelector).not.toHaveBeenCalled();
    expect(ctx.getCompositor).not.toHaveBeenCalled();
  });

  it('uses compositor progress instead of ora, including updates and idempotent end', () => {
    const ctx = setup();
    ctx.progress({ corrId: 'p', phase: 'start', label: 'Working' });
    ctx.progress({ corrId: 'p', phase: 'update', label: 'Almost done', fraction: 0.9 });
    ctx.progress({ corrId: 'p', phase: 'end', label: 'Done' });
    ctx.progress({ corrId: 'p', phase: 'end', label: 'Done' });
    expect(ctx.compositor.setSpinner.mock.calls).toEqual([[{ enabled: true }], [{ enabled: false }]]);
    expect(vi.mocked(ctx.out.info).mock.calls).toEqual([['Working'], ['Almost done']]);
    expect(oraFactory).not.toHaveBeenCalled();
  });

  it('uses ora only for TTY without compositor and stops on end', () => {
    const ctx = setup();
    ctx.getCompositor.mockReturnValue(null);
    ctx.progress({ corrId: 'p', phase: 'start', label: 'Working' });
    ctx.progress({ corrId: 'p', phase: 'update', label: 'Almost done' });
    ctx.progress({ corrId: 'p', phase: 'end', label: 'Done' });
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(spinner.text).toContain('Almost done');
  });

  it('piped progress renders text without ora or terminal methods', () => {
    tty(false);
    const out = { info: vi.fn() } as unknown as SlashContext['out'];
    const { progress } = createReplInteractions({ out });
    progress({ corrId: 'p', phase: 'start', label: 'Working' });
    progress({ corrId: 'p', phase: 'end', label: 'Done' });
    expect(out.info).toHaveBeenCalledWith('Working');
    expect(oraFactory).not.toHaveBeenCalled();
  });
});
