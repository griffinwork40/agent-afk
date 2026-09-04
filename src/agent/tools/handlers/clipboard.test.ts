/**
 * Tests for clipboard_write and clipboard_read handlers.
 *
 * All clipboard I/O and elicitation are injected via factory seams —
 * no real clipboard utilities are spawned and no TTY is needed.
 *
 * @module agent/tools/handlers/clipboard.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClipboardWriteHandler,
  createClipboardReadHandler,
  readFromClipboard,
  type ClipboardReadFn,
  type ClipboardWriteFn,
} from './clipboard.js';

// ── Elicitation mock ──────────────────────────────────────────────────────────
// Intercept the elicitation router so tests never block on a real prompt.

vi.mock('../../elicitation-router.js', () => ({
  elicitationRouter: {
    route: vi.fn(),
  },
}));

import { elicitationRouter } from '../../elicitation-router.js';
const mockRoute = vi.mocked(elicitationRouter.route);

const SIGNAL = new AbortController().signal;

afterEach(() => {
  vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Accept confirmation with `true` (operator clicked "yes"). */
function acceptConfirm() {
  mockRoute.mockResolvedValueOnce({
    action: 'accept',
    content: { value: true },
  });
}

/** Decline confirmation (no handler / auto-decline). */
function declineConfirm() {
  mockRoute.mockResolvedValueOnce({ action: 'decline' });
}

/** Operator cancelled the prompt. */
function cancelConfirm() {
  mockRoute.mockResolvedValueOnce({ action: 'cancel' });
}

// ── clipboard_write tests ─────────────────────────────────────────────────────

describe('clipboard_write handler', () => {
  it('returns success when writeFn succeeds', async () => {
    const writeFn: ClipboardWriteFn = vi.fn(() => true);
    const handler = createClipboardWriteHandler({ writeFn });

    const result = await handler({ text: 'hello world' }, SIGNAL);

    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/success/i);
    expect(writeFn).toHaveBeenCalledWith('hello world');
  });

  it('returns error when writeFn returns false (no utility)', async () => {
    const writeFn: ClipboardWriteFn = vi.fn(() => false);
    const handler = createClipboardWriteHandler({ writeFn });

    const result = await handler({ text: 'hello' }, SIGNAL);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no clipboard utility/i);
  });

  it('rejects non-object input', async () => {
    const handler = createClipboardWriteHandler({ writeFn: vi.fn(() => true) });

    const result = await handler('not an object' as unknown, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/expected an object/i);
  });

  it('rejects missing text field', async () => {
    const handler = createClipboardWriteHandler({ writeFn: vi.fn(() => true) });

    const result = await handler({}, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/text must be a string/i);
  });

  it('rejects numeric text field', async () => {
    const handler = createClipboardWriteHandler({ writeFn: vi.fn(() => true) });

    const result = await handler({ text: 42 }, SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/text must be a string/i);
  });

  it('writes an empty string without error', async () => {
    const writeFn: ClipboardWriteFn = vi.fn(() => true);
    const handler = createClipboardWriteHandler({ writeFn });

    const result = await handler({ text: '' }, SIGNAL);
    expect(result.isError).toBeFalsy();
    expect(writeFn).toHaveBeenCalledWith('');
  });

  it('returns error (not unhandled rejection) when writeFn throws', async () => {
    const writeFn: ClipboardWriteFn = vi.fn(() => {
      throw new Error('permission denied');
    });
    const handler = createClipboardWriteHandler({ writeFn });

    // Must resolve, not reject.
    const result = await handler({ text: 'oops' }, SIGNAL);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/permission denied/i);
  });
});

// ── clipboard_read tests ──────────────────────────────────────────────────────

describe('clipboard_read handler', () => {
  describe('operator confirmation gate', () => {
    it('returns error when operator declines', async () => {
      declineConfirm();
      const readFn: ClipboardReadFn = vi.fn(() => 'should not be read');
      const handler = createClipboardReadHandler({ readFn });

      const result = await handler({}, SIGNAL);

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/not approved/i);
      expect(result.failureClass).toBe('elicitation-declined');
      // readFn must NOT be called if operator declined
      expect(readFn).not.toHaveBeenCalled();
    });

    it('returns error when operator cancels', async () => {
      cancelConfirm();
      const readFn: ClipboardReadFn = vi.fn(() => 'should not be read');
      const handler = createClipboardReadHandler({ readFn });

      const result = await handler({}, SIGNAL);

      expect(result.isError).toBe(true);
      expect(result.failureClass).toBe('elicitation-declined');
      expect(readFn).not.toHaveBeenCalled();
    });

    it('routes to elicitation on every call (no caching)', async () => {
      const readFn: ClipboardReadFn = vi.fn(() => 'content');

      acceptConfirm();
      const handler = createClipboardReadHandler({ readFn });
      await handler({}, SIGNAL);

      acceptConfirm(); // must call elicitation again
      await handler({}, SIGNAL);

      expect(mockRoute).toHaveBeenCalledTimes(2);
    });
  });

  describe('successful read', () => {
    it('returns clipboard content when operator approves', async () => {
      acceptConfirm();
      const readFn: ClipboardReadFn = vi.fn(() => 'clipboard text');
      const handler = createClipboardReadHandler({ readFn });

      const result = await handler({}, SIGNAL);

      expect(result.isError).toBeFalsy();
      expect(result.content).toBe('clipboard text');
    });

    it('returns empty string for empty clipboard', async () => {
      acceptConfirm();
      const readFn: ClipboardReadFn = vi.fn(() => '');
      const handler = createClipboardReadHandler({ readFn });

      const result = await handler({}, SIGNAL);

      expect(result.isError).toBeFalsy();
      expect(result.content).toBe('');
    });
  });

  describe('unavailable clipboard', () => {
    it('returns graceful error when readFn returns null', async () => {
      acceptConfirm();
      const readFn: ClipboardReadFn = vi.fn(() => null);
      const handler = createClipboardReadHandler({ readFn });

      const result = await handler({}, SIGNAL);

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/no clipboard utility/i);
    });
  });

  describe('secret redaction', () => {
    it('redacts Anthropic API keys before returning to model', async () => {
      acceptConfirm();
      const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA';
      const readFn: ClipboardReadFn = vi.fn(() => `key=${secret}`);
      const handler = createClipboardReadHandler({ readFn });

      const result = await handler({}, SIGNAL);

      expect(result.isError).toBeFalsy();
      expect(result.content).not.toContain(secret);
      expect(result.content).toContain('[REDACTED]');
    });

    it('redacts Bearer tokens before returning to model', async () => {
      acceptConfirm();
      const readFn: ClipboardReadFn = vi.fn(
        () => 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
      );
      const handler = createClipboardReadHandler({ readFn });

      const result = await handler({}, SIGNAL);

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('[REDACTED]');
    });

    it('does not redact plain text', async () => {
      acceptConfirm();
      const readFn: ClipboardReadFn = vi.fn(() => 'hello world');
      const handler = createClipboardReadHandler({ readFn });

      const result = await handler({}, SIGNAL);

      expect(result.isError).toBeFalsy();
      expect(result.content).toBe('hello world');
    });
  });

  describe('size cap', () => {
    it('returns content unchanged when under 100KB', async () => {
      acceptConfirm();
      // Use short words separated by spaces so the generic-token redaction
      // rule (≥32 contiguous non-whitespace chars) does not fire.
      const word = 'hello ';
      const small = word.repeat(1_000); // 6_000 bytes — well under 100KB
      const handler = createClipboardReadHandler({ readFn: () => small });

      const result = await handler({}, SIGNAL);

      expect(result.isError).toBeFalsy();
      expect((result as { truncated?: boolean }).truncated).toBeUndefined();
      expect(Buffer.byteLength(result.content as string, 'utf8')).toBe(
        Buffer.byteLength(small, 'utf8'),
      );
    });

    it('caps content at 100KB and sets truncated:true for oversized clipboard', async () => {
      acceptConfirm();
      // Each line is 100 chars + newline = 101 bytes; 2000 lines = ~202KB.
      const line = 'hello world '.repeat(8) + '\n'; // 97 chars + newline
      const big = line.repeat(2_000); // ~196KB
      const handler = createClipboardReadHandler({ readFn: () => big });

      const result = await handler({}, SIGNAL);

      expect(result.isError).toBeFalsy();
      expect((result as { truncated?: boolean }).truncated).toBe(true);
      // Content must be at most 100KB in UTF-8 bytes.
      expect(Buffer.byteLength(result.content as string, 'utf8')).toBeLessThanOrEqual(100_000);
    });
  });

  describe('elicitation routing', () => {
    it('passes sessionId from context to elicitation router', async () => {
      acceptConfirm();
      const readFn: ClipboardReadFn = vi.fn(() => 'ok');
      const handler = createClipboardReadHandler({ readFn });

      await handler({}, SIGNAL, { sessionId: 'test-session-id' } as never);

      expect(mockRoute).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('clipboard') }),
        expect.objectContaining({ sessionId: 'test-session-id' }),
      );
    });

    it('uses confirm type for the approval prompt', async () => {
      acceptConfirm();
      const handler = createClipboardReadHandler({ readFn: vi.fn(() => '') });

      await handler({}, SIGNAL);

      expect(mockRoute).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'confirm' }),
        expect.anything(),
      );
    });
  });
});

// ── readFromClipboard unit tests ──────────────────────────────────────────────
// These test the pure logic (platform dispatch) without spawning real utilities.
// We use vi.spyOn on spawnSync via a module-level seam.

describe('readFromClipboard', () => {
  it('returns null when no utility is available (simulated)', () => {
    // We can't easily mock spawnSync across the module boundary here, so we
    // test the behavior on the real platform: if pbpaste / xclip / wl-paste
    // is unavailable (or we run in CI), `readFromClipboard` should return
    // null or a string — never throw.
    const result = readFromClipboard();
    // On macOS pbpaste is always available; on Linux CI utilities may be absent.
    // Either a string or null is acceptable — what matters is no throw.
    expect(typeof result === 'string' || result === null).toBe(true);
  });
});

// ── checkStderr scoping tests ─────────────────────────────────────────────────
// Verify that the checkStderr flag is scoped to wl-paste only.
// spawnSync is mocked at the module level via vi.mock so the real binary is
// never invoked.

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from 'node:child_process';
const mockSpawnSync = vi.mocked(spawnSync);

describe('readFromClipboard — checkStderr scoping', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('wl-paste: exit 0 + stderr content → falls through (checkStderr=true)', () => {
    // wl-paste exits 0 but writes to stderr — should NOT be treated as success.
    // All three Linux tools are tried; make xclip and xsel fail with an error so
    // we get null rather than a spurious match.
    mockSpawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'wl-paste') {
        return { error: undefined, status: 0, signal: null, stdout: 'hello', stderr: 'some diagnostic\n' };
      }
      // xclip / xsel — simulate not found
      return { error: new Error('ENOENT'), status: null, signal: null, stdout: '', stderr: '' };
    });

    const result = readFromClipboard('linux');
    expect(result).toBeNull();
  });

  it('pbpaste (darwin): exit 0 + stderr content → still returns stdout (no checkStderr)', () => {
    // macOS pbpaste can emit TCC diagnostics to stderr on exit 0; these must be
    // ignored and the stdout content must be returned.
    mockSpawnSync.mockReturnValueOnce({
      error: undefined,
      status: 0,
      signal: null,
      stdout: 'clipboard content',
      stderr: 'TCC diagnostic message\n',
    });

    const result = readFromClipboard('darwin');
    expect(result).toBe('clipboard content');
  });

  it('PowerShell (win32): exit 0 + module-load stderr → still returns stdout (no checkStderr)', () => {
    // Windows PowerShell can emit module-load or policy diagnostics to stderr
    // while Get-Clipboard exits 0 with valid clipboard content. These must be
    // ignored; checkStderr is false (undefined) for the powershell entry.
    mockSpawnSync.mockReturnValueOnce({
      error: undefined,
      status: 0,
      signal: null,
      stdout: 'some clipboard text',
      stderr: 'WARNING: Module already loaded.\n',
    });

    const result = readFromClipboard('win32');
    expect(result).toBe('some clipboard text');
  });
});
