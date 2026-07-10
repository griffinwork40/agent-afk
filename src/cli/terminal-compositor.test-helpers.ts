/**
 * Shared test helpers for the terminal-compositor sibling test suites.
 *
 * Extracted verbatim from terminal-compositor.test.ts when it was split
 * into sibling files (#369). Provides mock stdout/stdin streams and a
 * write-collector used across the suites.
 */

import { vi } from 'vitest';
import { PassThrough } from 'node:stream';

export type MockStdout = NodeJS.WriteStream & {
  isTTY: boolean;
  columns: number;
  rows: number;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: unknown[]) => void): MockStdout;
};

export type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): boolean;
};

export function makeMockStdout(isTTY = true): MockStdout {
  // PassThrough provides `write`, `on`, `emit`. Missing WriteStream methods
  // (cursorTo, clearLine, etc.) aren't used by the compositor; cast through
  // unknown to satisfy the NodeJS.WriteStream shape for test signatures.
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = isTTY;
  s.columns = 80;
  s.rows = 24;
  return s;
}

export function makeMockStdin(isTTY = true): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = isTTY;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

export function collectWrites(stream: MockStdout): { all: () => string; clear: () => void } {
  const chunks: string[] = [];
  stream.on('data', (c: unknown) => chunks.push(String(c)));
  return {
    all: () => chunks.join(''),
    clear: () => {
      chunks.length = 0;
    },
  };
}
