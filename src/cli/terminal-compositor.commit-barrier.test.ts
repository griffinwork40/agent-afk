/**
 * TerminalCompositor.setCommitBarrier: a one-shot hook that runs before the
 * next scrollback write so held content always lands above later commits.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';

type MockStdout = NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };

function make(): { c: TerminalCompositor; written: () => string } {
  const stdout = new PassThrough() as unknown as MockStdout;
  stdout.isTTY = true; stdout.columns = 80; stdout.rows = 24;
  const chunks: string[] = [];
  stdout.on('data', (x) => chunks.push(String(x)));
  // Unarmed: commitAbove takes the raw-write path, so output order is plain text.
  const c = new TerminalCompositor({ stdout, stdin: new PassThrough() as unknown as NodeJS.ReadStream, onCancel: vi.fn() });
  return { c, written: () => chunks.join('') };
}

describe('TerminalCompositor commit barrier', () => {
  it('runs once, before the next commit, and may itself commit without recursing', () => {
    const { c, written } = make();
    const barrier = vi.fn(() => c.commitAbove('HELD'));
    c.setCommitBarrier(barrier);
    c.commitAbove('LATER');
    c.commitAbove('LAST');
    expect(barrier).toHaveBeenCalledTimes(1);
    expect(written()).toBe('HELD\nLATER\nLAST\n');
  });

  it('is withdrawn by setCommitBarrier(null)', () => {
    const { c, written } = make();
    const barrier = vi.fn();
    c.setCommitBarrier(barrier);
    c.setCommitBarrier(null);
    c.commitAbove('X');
    expect(barrier).not.toHaveBeenCalled();
    expect(written()).toBe('X\n');
  });

  it('runs on endTurn and disarm when nothing else committed', () => {
    for (const end of ['endTurn', 'disarm'] as const) {
      const { c, written } = make();
      c.setCommitBarrier(() => c.commitAbove('HELD'));
      c[end]();
      expect(written()).toContain('HELD\n');
    }
  });
});
