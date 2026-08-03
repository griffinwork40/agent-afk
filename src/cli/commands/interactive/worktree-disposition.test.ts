import { describe, expect, it, vi } from 'vitest';
import {
  resolveWorktreeDisposition,
  resolveWorktreeExitPolicy,
} from './worktree-disposition.js';

const quietConsole = { warn: vi.fn() };

describe('resolveWorktreeExitPolicy', () => {
  it('uses CLI before env before config', () => {
    expect(resolveWorktreeExitPolicy({ cli: 'keep', env: 'remove', config: 'ask', isTTY: true, console: quietConsole })).toBe('keep');
    expect(resolveWorktreeExitPolicy({ env: 'remove', config: 'keep', isTTY: true, console: quietConsole })).toBe('remove');
    expect(resolveWorktreeExitPolicy({ config: 'keep', isTTY: true, console: quietConsole })).toBe('keep');
  });

  it('warns on invalid highest-precedence values and uses the surface fallback', () => {
    const logger = { warn: vi.fn() };
    expect(resolveWorktreeExitPolicy({ cli: 'bad', env: 'keep', isTTY: true, console: logger })).toBe('ask');
    expect(resolveWorktreeExitPolicy({ cli: 'bad', isTTY: false, console: logger })).toBe('remove');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});

describe('resolveWorktreeDisposition', () => {
  // An unpromptable 'ask' must NOT lock: locking is permanent (worktree-sweep
  // classifies `locked` ahead of every age/owner check and then no-ops), so
  // locking the unattended backstop would leak one dead worktree per abnormal
  // exit. Preserve-without-lock keeps the tree for a grace window instead.
  it('resolves to keep-unlocked on non-TTY ask (reversible, still sweep-eligible)', async () => {
    const picker = vi.fn();
    await expect(resolveWorktreeDisposition({ picker, isTTY: false, policy: 'ask', turnCount: 1, hasWorktree: true, console: quietConsole })).resolves.toBe('keep-unlocked');
    expect(picker).not.toHaveBeenCalled();
  });

  it('resolves to keep-unlocked when a TTY ask has no picker (signal-driven exit)', async () => {
    await expect(resolveWorktreeDisposition({ isTTY: true, policy: 'ask', turnCount: 1, hasWorktree: true, console: quietConsole })).resolves.toBe('keep-unlocked');
  });

  it('locks for an explicit keep policy even with no picker available', async () => {
    await expect(resolveWorktreeDisposition({ isTTY: false, policy: 'keep', turnCount: 1, hasWorktree: true, console: quietConsole })).resolves.toBe('keep-locked');
  });

  it('honours an explicit remove policy with no picker available', async () => {
    await expect(resolveWorktreeDisposition({ isTTY: false, policy: 'remove', turnCount: 1, hasWorktree: true, console: quietConsole })).resolves.toBe('remove');
  });

  it('skips the picker for zero turns', async () => {
    const picker = vi.fn();
    await expect(resolveWorktreeDisposition({ picker, isTTY: true, policy: 'ask', turnCount: 0, hasWorktree: true, console: quietConsole })).resolves.toBe('remove');
    expect(picker).not.toHaveBeenCalled();
  });

  it('skips the picker when there is no worktree to dispose of', async () => {
    const picker = vi.fn();
    await expect(resolveWorktreeDisposition({ picker, isTTY: true, policy: 'ask', turnCount: 3, hasWorktree: false, console: quietConsole })).resolves.toBe('remove');
    expect(picker).not.toHaveBeenCalled();
  });

  it('keeps and locks when the picker is cancelled (user was present and declined)', async () => {
    await expect(resolveWorktreeDisposition({ picker: async () => null, isTTY: true, policy: 'ask', turnCount: 1, hasWorktree: true, console: quietConsole })).resolves.toBe('keep-locked');
  });

  it('keeps and locks when the picker throws, and warns', async () => {
    const logger = { warn: vi.fn() };
    await expect(resolveWorktreeDisposition({
      picker: async () => { throw new Error('compositor gone'); },
      isTTY: true, policy: 'ask', turnCount: 1, hasWorktree: true, console: logger,
    })).resolves.toBe('keep-locked');
    expect(logger.warn.mock.calls.flat().join(' ')).toMatch(/compositor gone/);
  });

  it.each([
    ['Keep worktree and cd into it on exit', 'keep-locked'],
    ['Delete worktree and branch', 'remove'],
  ] as const)('maps picker selection %s to %s', async (selection, expected) => {
    await expect(resolveWorktreeDisposition({ picker: async () => [selection], isTTY: true, policy: 'ask', turnCount: 1, hasWorktree: true, console: quietConsole })).resolves.toBe(expected);
  });
});
