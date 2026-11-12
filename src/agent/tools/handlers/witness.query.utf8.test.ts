/**
 * UTF-8 boundary tests for readTraceSafe (witness.query.io.ts).
 *
 * The existing witness.query.test.ts uses only ASCII payloads in its
 * truncation scenarios. This file verifies that the U+FFFD replacement-
 * character guard works correctly when the byte-cap boundary lands mid-way
 * through a multi-byte UTF-8 codepoint.
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
  it('strips trailing U+FFFD when slice lands mid 2-byte sequence (U+00C0–U+07FF range)', async () => {
    // Build a buffer that is exactly MAX_READ_BYTES + 1 bytes so truncation
    // fires, then arrange the final bytes of the tail window to be the first
    // byte of a 2-byte UTF-8 sequence (0xC3 = start of é, â, etc.) with the
    // continuation byte just outside the window.
    //
    // Layout:
    //   [ ASCII padding × (MAX_READ_BYTES - 1) ] [ 0xC3 ] [ 0xA9 ]
    //   ^--- fits in MAX_READ_BYTES tail window ---^        ^-- outside
    //
    // After slicing the tail, the buffer ends with 0xC3 alone, which
    // Buffer.toString('utf8') converts to U+FFFD. The guard must strip it.

    const totalSize = MAX_READ_BYTES + 1;
    const buf = Buffer.alloc(totalSize, 0x61); // 'a' × totalSize
    // Place the 2-byte sequence at the very end: last two bytes of the full buf.
    buf[totalSize - 2] = 0xc3; // first byte of U+00E9 (é)
    buf[totalSize - 1] = 0xa9; // second byte — will be OUTSIDE the tail window

    const tracePath = await writeTrace('utf8-2byte', buf);
    const { content, truncated } = await readTraceSafe(tracePath);

    expect(truncated).toBe(true);
    // The trailing replacement character must have been stripped.
    expect(content).not.toMatch(/\uFFFD$/);
    // The content must still be non-empty (the ASCII head survives).
    expect(content.length).toBeGreaterThan(0);
  });

  it('strips trailing U+FFFD when slice lands mid 3-byte sequence (U+0800–U+FFFF range)', async () => {
    // A 3-byte UTF-8 sequence: e.g. U+4E2D (中, 0xE4 0xB8 0xAD).
    // Place all three bytes at the tail of the full buffer so the slice
    // captures only the first byte (0xE4), producing U+FFFD.
    const totalSize = MAX_READ_BYTES + 2;
    const buf = Buffer.alloc(totalSize, 0x61);
    buf[totalSize - 3] = 0xe4; // first byte of 中
    buf[totalSize - 2] = 0xb8; // second byte — outside tail window
    buf[totalSize - 1] = 0xad; // third byte  — outside tail window

    const tracePath = await writeTrace('utf8-3byte', buf);
    const { content, truncated } = await readTraceSafe(tracePath);

    expect(truncated).toBe(true);
    expect(content).not.toMatch(/\uFFFD$/);
    expect(content.length).toBeGreaterThan(0);
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
