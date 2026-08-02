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
  it('resolves to keep on non-TTY ask (reversible default when no picker can be shown)', async () => {
    const picker = vi.fn();
    await expect(resolveWorktreeDisposition({ picker, isTTY: false, policy: 'ask', turnCount: 1, hasWorktree: true, console: quietConsole })).resolves.toBe('keep');
    expect(picker).not.toHaveBeenCalled();
  });

  it('skips the picker for zero turns', async () => {
    const picker = vi.fn();
    await expect(resolveWorktreeDisposition({ picker, isTTY: true, policy: 'ask', turnCount: 0, hasWorktree: true, console: quietConsole })).resolves.toBe('remove');
    expect(picker).not.toHaveBeenCalled();
  });

  it('keeps when the picker is cancelled', async () => {
    await expect(resolveWorktreeDisposition({ picker: async () => null, isTTY: true, policy: 'ask', turnCount: 1, hasWorktree: true, console: quietConsole })).resolves.toBe('keep');
  });

  it.each([
    ['Keep worktree and cd into it on exit', 'keep'],
    ['Delete worktree and branch', 'remove'],
  ] as const)('maps picker selection %s to %s', async (selection, expected) => {
    await expect(resolveWorktreeDisposition({ picker: async () => [selection], isTTY: true, policy: 'ask', turnCount: 1, hasWorktree: true, console: quietConsole })).resolves.toBe(expected);
  });
});
