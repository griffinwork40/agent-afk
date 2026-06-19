import { PassThrough } from 'node:stream';
import type { Interface as ReadlineInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWithAutocomplete } from './input-box.js';
import { TerminalCompositor } from './terminal-compositor.js';
import { registerAll } from './slash/index.js';
import { resetRegistry } from './slash/registry.js';

type MockStdout = NodeJS.WriteStream & {
  isTTY: boolean;
  columns: number;
  rows: number;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: unknown[]) => void): MockStdout;
};

type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): boolean;
};

function makeMockStdout(columns = 80): MockStdout {
  const stream = new PassThrough() as unknown as MockStdout;
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = 24;
  return stream;
}

function makeMockStdin(): MockStdin {
  const stream = new PassThrough() as unknown as MockStdin;
  stream.isTTY = true;
  stream.isRaw = false;
  stream.setRawMode = vi.fn((raw: boolean) => {
    stream.isRaw = raw;
    return stream;
  });
  return stream;
}

function collectWrites(stream: MockStdout): { all: () => string; clear: () => void } {
  const chunks: string[] = [];
  stream.on('data', (chunk: unknown) => {
    chunks.push(String(chunk));
  });
  return {
    all: () => chunks.join(''),
    clear: () => {
      chunks.length = 0;
    },
  };
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function keypress(
  stdin: MockStdin,
  char: string | undefined,
  key: Record<string, unknown> = {},
): void {
  stdin.emit('keypress', char, {
    sequence: typeof char === 'string' ? char : undefined,
    ...key,
  });
}

async function withPatchedProcessStreams<T>(
  fn: (ctx: {
    stdin: MockStdin;
    stdout: MockStdout;
    writes: ReturnType<typeof collectWrites>;
  }) => Promise<T>,
): Promise<T> {
  const stdin = makeMockStdin();
  const stdout = makeMockStdout();
  const writes = collectWrites(stdout);
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout');

  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });

  try {
    return await fn({ stdin, stdout, writes });
  } finally {
    if (stdinDescriptor) {
      Object.defineProperty(process, 'stdin', stdinDescriptor);
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process, 'stdout', stdoutDescriptor);
    }
  }
}

function makeRl(): ReadlineInterface {
  return {} as ReadlineInterface;
}

afterEach(() => {
  resetRegistry();
});

describe('readWithAutocomplete interaction coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('restores raw mode and disables bracketed paste after Ctrl+C abort', async () => {
    await withPatchedProcessStreams(async ({ stdin, writes }) => {
      const pending = readWithAutocomplete({
        rl: makeRl(),
        promptFn: () => '> ',
      });

      expect(stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
      expect(writes.all()).toContain('\x1b[?2004h');

      keypress(stdin, undefined, { name: 'c', ctrl: true });

      await expect(pending).rejects.toThrow('SIGINT');
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(writes.all()).toContain('\x1b[?2004l');
    });
  });

  it('treats bracketed paste as atomic input and only submits after paste ends', async () => {
    await withPatchedProcessStreams(async ({ stdin, writes }) => {
      const pending = readWithAutocomplete({
        rl: makeRl(),
        promptFn: () => '> ',
      });

      writes.clear();

      keypress(stdin, undefined, { sequence: '\x1b[200~' });
      for (const char of 'line1') keypress(stdin, char, { name: char });
      keypress(stdin, undefined, { name: 'return' });
      for (const char of 'line2') keypress(stdin, char, { name: char });
      keypress(stdin, undefined, { sequence: '\x1b[201~' });
      await vi.advanceTimersByTimeAsync(12);
      keypress(stdin, undefined, { name: 'return' });

      await expect(pending).resolves.toEqual({ text: 'line1\nline2', attachments: [] });
      expect(stripAnsi(writes.all())).toContain('line1');
      expect(stripAnsi(writes.all())).toContain('line2');
    });
  });

  it('repaints on resize using the current terminal width', async () => {
    registerAll();

    await withPatchedProcessStreams(async ({ stdin, stdout, writes }) => {
      const pending = readWithAutocomplete({
        rl: makeRl(),
        promptFn: () => '> ',
        initialBuffer: '/h',
      });

      expect(stripAnsi(writes.all())).toContain('/help');

      writes.clear();
      stdout.columns = 30;
      stdout.emit('resize');

      expect(stripAnsi(writes.all())).not.toContain('/help');

      keypress(stdin, undefined, { name: 'c', ctrl: true });
      await expect(pending).rejects.toThrow('SIGINT');
    });
  });

  it('routes Ctrl+C through onSigint without aborting the prompt', async () => {
    await withPatchedProcessStreams(async ({ stdin }) => {
      const onSigint = vi.fn();
      const pending = readWithAutocomplete({
        rl: makeRl(),
        promptFn: () => '> ',
        onSigint,
      });

      keypress(stdin, undefined, { name: 'c', ctrl: true });
      expect(onSigint).toHaveBeenCalledTimes(1);

      keypress(stdin, 'o', { name: 'o' });
      keypress(stdin, 'k', { name: 'k' });
      await vi.advanceTimersByTimeAsync(12);
      keypress(stdin, undefined, { name: 'return' });

      await expect(pending).resolves.toEqual({ text: 'ok', attachments: [] });
    });
  });
});

describe('TerminalCompositor interaction coverage', () => {
  it('preserves queued input across streaming overlays and committed output', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    const compositor = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      promptText: '> ',
    });

    await compositor.arm();
    compositor.setOverlay('streaming chunk');

    for (const char of 'queued work') {
      keypress(stdin, char, { name: char });
    }
    keypress(stdin, undefined, { name: 'return' });

    // Buffer is committed to the FIFO (live buffer cleared) AND the visual
    // `[queued]` glyph is painted in the input row so the user has explicit
    // feedback that their Enter was registered. setInputMode('idle') drains
    // the FIFO payload as the next turn.
    expect(compositor.getBuffer()).toEqual({ text: '', queued: true });
    expect(compositor.getPendingCount()).toBe(1);
    expect(stripAnsi(writes.all())).toContain('[queued]');

    writes.clear();
    compositor.commitAbove('final block');
    compositor.setOverlay('follow-up chunk');

    expect(compositor.getBuffer()).toEqual({ text: '', queued: true });
    expect(compositor.getPendingCount()).toBe(1);
    expect(stripAnsi(writes.all())).toContain('final block');

    compositor.disarm();
  });

  it('fires Ctrl+C once while streaming and keeps the queued buffer available', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const onCancel = vi.fn();
    const compositor = new TerminalCompositor({
      stdout,
      stdin,
      onCancel,
      promptText: '> ',
    });

    await compositor.arm();
    compositor.setOverlay('thinking...');

    for (const char of 'draft') {
      keypress(stdin, char, { name: char });
    }
    keypress(stdin, undefined, { name: 'return' });

    keypress(stdin, undefined, { name: 'c', ctrl: true });
    keypress(stdin, undefined, { name: 'c', ctrl: true });

    expect(onCancel).toHaveBeenCalledTimes(1);
    // New contract: Enter committed 'draft' to the FIFO and cleared the live buffer.
    expect(compositor.getBuffer()).toEqual({ text: '', queued: true });
    expect(compositor.getPendingCount()).toBe(1);

    compositor.disarm();
  });
});
