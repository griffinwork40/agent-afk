import { afterEach, describe, expect, it, vi } from 'vitest';
import chalk from 'chalk';
import { SkillIdentityState } from './skill-identity-state.js';
import { sanitizeSkillIdentity } from './skill-identity-format.js';
import { CommitCoordinator } from './commit-coordinator.js';
import { displayWidth, stripAnsi } from '../display.js';
import * as terminalSize from '../terminal-size.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { Writer } from '../slash/types.js';

afterEach(() => vi.restoreAllMocks());

describe('committed skill identity', () => {
  describe.each(['writer', 'compositor'] as const)('%s sink', (sink) => {
    it.each([20, 40, 80])('one-line brand+dim form at width %i, no args line', async (width) => {
      vi.spyOn(terminalSize, 'getTerminalWidth').mockReturnValue(width);
      const input = {
        name: '\x1b[31mreview\x1b[0m',
        purpose: `Inspect\n changes 界 ${'carefully '.repeat(15)}`,
        arguments: `src/${'long-path-'.repeat(15)}index.ts`,
      };
      const expected = sanitizeSkillIdentity(input);
      const line = vi.fn();
      const out = { line, raw: line, info: line, warn: line, error: line, success: line } satisfies Writer;
      const commitAbove = vi.fn();
      const compositor = sink === 'compositor' ? { commitAbove } as unknown as TerminalCompositor : null;
      const state = new SkillIdentityState(input);
      const coordinator = new CommitCoordinator();
      await state.introduce(coordinator, compositor, out);
      await state.introduce(coordinator, compositor, out);
      await coordinator.flushAll();

      const commits = sink === 'compositor' ? commitAbove : line;
      expect(commits).toHaveBeenCalledTimes(1);
      expect(sink === 'compositor' ? line : commitAbove).not.toHaveBeenCalled();
      const text = String(commits.mock.calls[0]![0]);
      // Must contain the name (stripped of ANSI) and the purpose text.
      const plain = stripAnsi(text).replace(/\n/g, ' ');
      expect(plain).toContain(`/${expected.name}`);
      expect(plain).toContain(expected.purpose.replace(/\s+/gu, ' ').trim().slice(0, 20));
      // No args: line.
      expect(plain).not.toContain('args:');
      // No ANSI at chalk level 0 (non-TTY / NO_COLOR).
      expect(text).not.toContain('\x1b');
      // Every row fits the terminal width.
      for (const row of text.split('\n')) expect(displayWidth(row)).toBeLessThanOrEqual(width);
    });

    it('no-purpose renders name only (no separator)', async () => {
      vi.spyOn(terminalSize, 'getTerminalWidth').mockReturnValue(80);
      const line = vi.fn();
      const out = { line, raw: line, info: line, warn: line, error: line, success: line } satisfies Writer;
      const commitAbove = vi.fn();
      const compositor = sink === 'compositor' ? { commitAbove } as unknown as TerminalCompositor : null;
      const state = new SkillIdentityState({ name: 'mint', purpose: '', arguments: 'some args' });
      const coordinator = new CommitCoordinator();
      await state.introduce(coordinator, compositor, out);
      await coordinator.flushAll();
      const commits = sink === 'compositor' ? commitAbove : line;
      const text = stripAnsi(String(commits.mock.calls[0]![0]));
      expect(text.trim()).toBe('/mint');
      expect(text).not.toContain('·');
      expect(text).not.toContain('args:');
    });
  });

  it('styled output at forced chalk level 3 contains brand/dim sequences and wraps correctly', async () => {
    const savedLevel = chalk.level;
    try {
      chalk.level = 3;
      vi.spyOn(terminalSize, 'getTerminalWidth').mockReturnValue(40);
      const line = vi.fn();
      const out = { line, raw: line, info: line, warn: line, error: line, success: line } satisfies Writer;
      const state = new SkillIdentityState({
        name: 'tackle-issues',
        purpose: 'Tackle N open GitHub issues in parallel using worktree-isolated subagents, producing one PR per issue',
        arguments: '20',
      });
      const coordinator = new CommitCoordinator();
      await state.introduce(coordinator, null, out);
      await coordinator.flushAll();
      const text = String(line.mock.calls[0]![0]);
      // At level 3 there must be ANSI escape sequences.
      expect(text).toContain('\x1b');
      // Every visible row must fit within 40 columns.
      for (const row of text.split('\n')) expect(displayWidth(row)).toBeLessThanOrEqual(40);
      // Plain content must include the name and purpose start.
      const plain = stripAnsi(text);
      expect(plain).toContain('/tackle-issues');
      expect(plain).toContain('·');
    } finally {
      chalk.level = savedLevel;
    }
  });

  it('chalk level 0 produces no ANSI escape sequences', async () => {
    const savedLevel = chalk.level;
    try {
      chalk.level = 0;
      vi.spyOn(terminalSize, 'getTerminalWidth').mockReturnValue(80);
      const line = vi.fn();
      const out = { line, raw: line, info: line, warn: line, error: line, success: line } satisfies Writer;
      const state = new SkillIdentityState({ name: 'diagnose', purpose: 'Root cause analysis', arguments: 'auth' });
      const coordinator = new CommitCoordinator();
      await state.introduce(coordinator, null, out);
      await coordinator.flushAll();
      const text = String(line.mock.calls[0]![0]);
      expect(text).not.toContain('\x1b');
      expect(stripAnsi(text)).toContain('/diagnose');
    } finally {
      chalk.level = savedLevel;
    }
  });
});
