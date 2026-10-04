import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillIdentityState } from './skill-identity-state.js';
import { sanitizeSkillIdentity } from './skill-identity-format.js';
import { CommitCoordinator } from './commit-coordinator.js';
import { displayWidth } from '../display.js';
import * as terminalSize from '../terminal-size.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { Writer } from '../slash/types.js';

afterEach(() => vi.restoreAllMocks());

describe('committed skill identity', () => {
  describe.each(['writer', 'compositor'] as const)('%s sink', (sink) => {
    it.each([20, 40, 80])('retains sanitized field budgets once at width %i', async (width) => {
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
      // Ignore layout whitespace: wrapping must not discard any budgeted field.
      const compact = (value: string) => value.replace(/\s/gu, '');
      expect(compact(text)).toBe(compact(`/${expected.name}${expected.purpose}args: ${expected.arguments}`));
      expect(text).not.toContain('\x1b');
      for (const row of text.split('\n')) expect(displayWidth(row)).toBeLessThanOrEqual(width);
    });
  });
});
