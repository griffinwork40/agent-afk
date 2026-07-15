/**
 * Tests for src/cli/input-box.ts readWithAutocomplete() routing — focused on
 * the AFK_PLAIN_OUTPUT full render opt-out.
 *
 * On a --plain TTY the reader must downgrade to the simple non-TTY line reader
 * (`readNonTty`) instead of the raw-mode TTY reader (`readWithAutocompleteTty`,
 * which enters raw mode and owns cursor/dropdown accounting) — so a --plain
 * TTY behaves like a non-TTY surface for input, matching the renderer /
 * compositor / status-line gates. Streams are stubbed via the real
 * process.stdout/stdin.isTTY read path (not a helper), so the assertion is not
 * vacuous.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { readNonTty, readWithAutocompleteTty } = vi.hoisted(() => ({
  readNonTty: vi.fn(async () => ({ text: 'plain', attachments: [] })),
  readWithAutocompleteTty: vi.fn(async () => ({ text: 'tty', attachments: [] })),
}));

vi.mock('./input/non-tty.js', () => ({ readNonTty }));
vi.mock('./input/reader.js', () => ({ readWithAutocompleteTty }));

import { readWithAutocomplete, type ReadWithAutocompleteOpts } from './input-box.js';

const EMPTY_OPTS = {} as unknown as ReadWithAutocompleteOpts;

const origStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const origStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

function stubProcessTTY(isTTY: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
}

describe('readWithAutocomplete — AFK_PLAIN_OUTPUT full render opt-out', () => {
  beforeEach(() => {
    readNonTty.mockClear();
    readWithAutocompleteTty.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (origStdoutIsTTY) Object.defineProperty(process.stdout, 'isTTY', origStdoutIsTTY);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    if (origStdinIsTTY) Object.defineProperty(process.stdin, 'isTTY', origStdinIsTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  it('routes to the simple non-TTY reader on a real TTY when AFK_PLAIN_OUTPUT=1', async () => {
    stubProcessTTY(true);
    vi.stubEnv('AFK_PLAIN_OUTPUT', '1');
    const r = await readWithAutocomplete(EMPTY_OPTS);
    expect(readNonTty).toHaveBeenCalledTimes(1);
    expect(readWithAutocompleteTty).not.toHaveBeenCalled();
    expect(r.text).toBe('plain');
  });

  it('routes to the raw-mode TTY reader on a real TTY when AFK_PLAIN_OUTPUT is unset (no behavior change)', async () => {
    stubProcessTTY(true);
    vi.stubEnv('AFK_PLAIN_OUTPUT', undefined as unknown as string);
    const r = await readWithAutocomplete(EMPTY_OPTS);
    expect(readWithAutocompleteTty).toHaveBeenCalledTimes(1);
    expect(readNonTty).not.toHaveBeenCalled();
    expect(r.text).toBe('tty');
  });

  it('routes to the simple reader on a genuine non-TTY regardless of the flag', async () => {
    stubProcessTTY(false);
    vi.stubEnv('AFK_PLAIN_OUTPUT', undefined as unknown as string);
    const r = await readWithAutocomplete(EMPTY_OPTS);
    expect(readNonTty).toHaveBeenCalledTimes(1);
    expect(readWithAutocompleteTty).not.toHaveBeenCalled();
    expect(r.text).toBe('plain');
  });

  it('does not downgrade for unrecognized values (e.g. "0") on a real TTY', async () => {
    stubProcessTTY(true);
    vi.stubEnv('AFK_PLAIN_OUTPUT', '0');
    const r = await readWithAutocomplete(EMPTY_OPTS);
    expect(readWithAutocompleteTty).toHaveBeenCalledTimes(1);
    expect(readNonTty).not.toHaveBeenCalled();
    expect(r.text).toBe('tty');
  });
});
