import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { installConsoleBridge } from './console-bridge.js';
import { TerminalCompositor } from '../../terminal-compositor.js';

function fakeConsole() {
  const warn = vi.fn();
  const error = vi.fn();
  return { target: { warn, error } as Pick<Console, 'warn' | 'error'>, warn, error };
}

describe('installConsoleBridge', () => {
  it('routes warn and error through commitAbove, formatted like console', () => {
    const { target, warn, error } = fakeConsole();
    const commitAbove = vi.fn();
    installConsoleBridge({ commitAbove }, target);

    target.warn('[hooks] exited with code %d: %s', 1, 'node x.ts');
    target.error(new Error('boom').message, { code: 'E' });

    expect(commitAbove).toHaveBeenNthCalledWith(1, '[hooks] exited with code 1: node x.ts');
    expect(commitAbove).toHaveBeenNthCalledWith(2, "boom { code: 'E' }");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('drops trailing newlines so the commit adds no blank row', () => {
    const { target } = fakeConsole();
    const commitAbove = vi.fn();
    installConsoleBridge({ commitAbove }, target);
    target.warn('line one\nline two\n\n');
    expect(commitAbove).toHaveBeenCalledWith('line one\nline two');
  });

  it('falls back to the original method when the sink throws', () => {
    const { target, warn } = fakeConsole();
    installConsoleBridge({ commitAbove: () => { throw new Error('dead tty'); } }, target);
    target.warn('still visible');
    expect(warn).toHaveBeenCalledWith('still visible');
  });

  it('does not recurse when the sink itself warns', () => {
    const { target, warn } = fakeConsole();
    const commitAbove = vi.fn((text: string) => { target.warn(`inner: ${text}`); });
    installConsoleBridge({ commitAbove }, target);
    target.warn('outer');
    expect(commitAbove).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('inner: outer');
  });

  it('cross-method re-entrancy: a warn inside an error sink falls back without recursing', () => {
    // The inBridge flag is shared across warn and error. If commitAbove calls
    // target.warn while handling a target.error call (or vice-versa), the
    // inner call must fall back to the original rather than recurse back into
    // commitAbove. This covers the "cross-method" variant of the re-entrancy
    // guard described in the contract comment.
    const { target, warn } = fakeConsole();
    const commitAbove = vi.fn((_text: string) => {
      // Sink calls warn while handling an error — cross-method re-entrancy.
      target.warn('re-entrant-warn');
    });
    installConsoleBridge({ commitAbove }, target);

    target.error('trigger');

    // commitAbove was called once for the original error.
    expect(commitAbove).toHaveBeenCalledTimes(1);
    expect(commitAbove).toHaveBeenCalledWith('trigger');
    // The re-entrant warn must have bypassed commitAbove and gone to the
    // original warn directly (inBridge was still true).
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('re-entrant-warn');
  });

  it('restore reinstates the originals, is idempotent, and never clobbers a later wrapper', () => {
    const { target, warn, error } = fakeConsole();
    const restore = installConsoleBridge({ commitAbove: vi.fn() }, target);
    const laterSpy = vi.fn();
    target.error = laterSpy;

    restore();
    restore();

    expect(target.warn).toBe(warn);
    expect(target.error).toBe(laterSpy);
    expect(target.error).not.toBe(error);
  });
});

describe('installConsoleBridge + real compositor (hook-error wrap repro)', () => {
  it('puts a hook warning on its own rows instead of appending to the parked rule row', async () => {
    const COLS = 80;
    const ROWS = 24;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream & { isTTY: boolean; columns: number; rows: number };
    stdout.isTTY = true;
    stdout.columns = COLS;
    stdout.rows = ROWS;
    const chunks: string[] = [];
    stdout.on('data', (d: unknown) => chunks.push(String(d)));
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean; isRaw: boolean; setRawMode: (r: boolean) => unknown };
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (r: boolean) => { stdin.isRaw = r; return stdin; };

    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), anchorRow: 1, contentHug: true });
    await c.arm();
    const { target } = fakeConsole();
    const restore = installConsoleBridge(c, target);
    try {
      const rule = '─'.repeat(60);
      c.commitAbove(rule);
      target.warn('[hooks] command exited with code 1: node stop-sweep.ts\nError: Cannot find module');

      const term = new HeadlessTerminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true, convertEol: true });
      await new Promise<void>((r) => term.write(chunks.join(''), r));
      const b = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true).replace(/\s+$/, '') ?? '');
      term.dispose();

      const ruleIdx = lines.findIndex((l) => l.includes(rule));
      expect(ruleIdx).toBeGreaterThanOrEqual(0);
      expect(lines[ruleIdx]).toBe(rule);
      expect(lines[ruleIdx + 1]).toBe('[hooks] command exited with code 1: node stop-sweep.ts');
      expect(lines[ruleIdx + 2]).toBe('Error: Cannot find module');
    } finally {
      restore();
      c.disarm();
    }
  });
});
