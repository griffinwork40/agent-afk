/**
 * UTF-8 boundary tests for readTraceSafe (witness.query.io.ts).
 *
 * readTraceSafe keeps the TAIL of an over-cap file, so the cap can only split
 * a codepoint at the START of the retained window. Those orphaned continuation
 * bytes decode to a LEADING U+FFFD, which the newline realignment discards.
 * A TRAILING U+FFFD can only come from the file itself ending mid-codepoint
 * (e.g. a torn final append); that is the case the trailing-U+FFFD guard
 * covers, and the tests below place the incomplete sequence there.
 *
 * Issue #4770 — advisory finding: truncation tests used ASCII-only payloads.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readTraceSafe, MAX_READ_BYTES } from './witness.query.io.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'afk-witness-utf8-test-'));
});

afterEach(async () => {
  try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/**
 * Write a trace file and return its path.
 */
async function writeTrace(name: string, content: Buffer): Promise<string> {
  const dir = join(tmpDir, name);
  await mkdir(dir, { recursive: true });
  const p = join(dir, 'trace.jsonl');
  await writeFile(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// U+FFFD guard: multi-byte codepoint at truncation boundary
// ---------------------------------------------------------------------------

describe('readTraceSafe — U+FFFD guard at multi-byte boundary', () => {
  it('strips trailing U+FFFD when an over-cap file ends with a torn 2-byte sequence', async () => {
    // Layout (totalSize = MAX_READ_BYTES + 10):
    //   [ 'a' × 20 ] [ '\n' ] [ 'a' × … ] [ 0xC3 ]
    // The tail window starts at byte 10, realigns past the newline at byte 20,
    // and ends with the lone lead byte 0xC3 (first byte of U+00E9 'é') whose
    // continuation byte was never written. It decodes to a trailing U+FFFD
    // that the guard must strip.
    const totalSize = MAX_READ_BYTES + 10;
    const buf = Buffer.alloc(totalSize, 0x61);
    buf[20] = 0x0a;
    buf[totalSize - 1] = 0xc3;

    const tracePath = await writeTrace('utf8-2byte', buf);
    const { content, truncated } = await readTraceSafe(tracePath);

    // 21 = bytes consumed by the prefix up to and including the realignment newline
    const PREFIX_BYTES = 21;
    expect(truncated).toBe(true);
    expect(content).toBe('a'.repeat(totalSize - 1 - PREFIX_BYTES));
  });

  it('strips trailing U+FFFD when an over-cap file ends with a torn 3-byte sequence', async () => {
    // Same shape, but the file ends with a complete 'é' followed by the first
    // two bytes of U+4E2D '中' (0xE4 0xB8; the third byte 0xAD is missing).
    // Only the replacement character may be stripped: the complete 'é' stays.
    const totalSize = MAX_READ_BYTES + 10;
    const buf = Buffer.alloc(totalSize, 0x61);
    buf[20] = 0x0a;
    buf[totalSize - 4] = 0xc3; // é (complete)
    buf[totalSize - 3] = 0xa9;
    buf[totalSize - 2] = 0xe4; // 中, torn after two of three bytes
    buf[totalSize - 1] = 0xb8;

    const tracePath = await writeTrace('utf8-3byte', buf);
    const { content, truncated } = await readTraceSafe(tracePath);

    // 21 = bytes consumed by the prefix up to and including the realignment newline
    const PREFIX_BYTES = 21;
    expect(truncated).toBe(true);
    expect(content).toBe('a'.repeat(totalSize - 4 - PREFIX_BYTES) + '\u00e9');
  });

  it('drops a codepoint split at the window START via newline realignment', async () => {
    // This is the only split the tail slice itself can produce. Layout
    // (totalSize = MAX_READ_BYTES + 1, so the window starts at byte 1):
    //   [ 0xE4 0xB8 0xAD ] [ '\n' ] [ 'a' × … ]
    // The window begins with the orphaned continuation bytes 0xB8 0xAD
    // (a leading U+FFFD if decoded); realignment past the newline at byte 3
    // must discard them so no replacement character survives anywhere.
    const totalSize = MAX_READ_BYTES + 1;
    const buf = Buffer.alloc(totalSize, 0x61);
    buf[0] = 0xe4;
    buf[1] = 0xb8;
    buf[2] = 0xad;
    buf[3] = 0x0a;

    const tracePath = await writeTrace('utf8-window-start', buf);
    const { content, truncated } = await readTraceSafe(tracePath);

    expect(truncated).toBe(true);
    expect(content).not.toContain('\uFFFD');
    expect(content).toBe('a'.repeat(totalSize - 4));
  });

  it('does NOT strip content when no multi-byte boundary split occurs', async () => {
    // A file just over the cap whose tail window ends on a clean ASCII byte.
    // No U+FFFD should appear; the stripped content should equal the raw tail.
    const totalSize = MAX_READ_BYTES + 10;
    const buf = Buffer.alloc(totalSize, 0x61); // pure ASCII

    const tracePath = await writeTrace('utf8-ascii', buf);
    const { content, truncated } = await readTraceSafe(tracePath);

    expect(truncated).toBe(true);
    expect(content).not.toContain('\uFFFD');
    // All remaining bytes must be 'a'.
    expect(/^a+$/.test(content.trim())).toBe(true);
  });

  it('returns full content without U+FFFD for small files with multi-byte characters', async () => {
    // A file well under the cap that contains multi-byte characters must
    // decode cleanly without any U+FFFD (non-truncated path).
    const japanese = '日本語テスト\n'.repeat(10); // well under 2 MB
    const buf = Buffer.from(japanese, 'utf-8');

    const tracePath = await writeTrace('utf8-small', buf);
    const { content, truncated } = await readTraceSafe(tracePath);

    expect(truncated).toBe(false);
    expect(content).not.toContain('\uFFFD');
    expect(content).toContain('日本語テスト');
  });
});
