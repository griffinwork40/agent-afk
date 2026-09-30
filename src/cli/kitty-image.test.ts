/**
 * Unit tests for src/cli/kitty-image.ts.
 *
 * Covers:
 *   1. Detection matrix — all terminal/env combinations → transport verdict
 *   2. Chunk encoding — correct APC boundaries, m=0/m=1, key fields
 *   3. tmux passthrough — ESC doubling and DCS wrapper
 *   4. Non-TTY / opt-out suppression — AFK_INLINE_IMAGES=0
 *   5. emitKittyImage — success and error paths
 *   6. computeImageCellDimensions — clamping behavior
 *
 * @module cli/kitty-image.test
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import {
  detectKittySupport,
  buildKittyChunks,
  wrapForTmux,
  computeImageCellDimensions,
  emitKittyImage,
} from './kitty-image.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal 1×1 PNG buffer (valid header bytes). */
function minimalPng(width = 1, height = 1): Buffer {
  const buf = Buffer.alloc(24);
  // PNG signature
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  // IHDR length (4 bytes, big-endian)
  buf[8] = 0x00; buf[9] = 0x00; buf[10] = 0x00; buf[11] = 0x0d;
  // IHDR marker
  buf[12] = 0x49; buf[13] = 0x48; buf[14] = 0x44; buf[15] = 0x52;
  // Width at offset 16 (big-endian uint32)
  buf.writeUInt32BE(width, 16);
  // Height at offset 20 (big-endian uint32)
  buf.writeUInt32BE(height, 20);
  return buf;
}

// ---------------------------------------------------------------------------
// 1. Detection matrix
// ---------------------------------------------------------------------------

describe('detectKittySupport — detection matrix', () => {
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(vars: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(vars)) {
      savedEnv[k] = process.env[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  afterEach(() => {
    // Restore saved values.
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    // Clear savedEnv for next test.
    for (const k of Object.keys(savedEnv)) {
      delete savedEnv[k];
    }
  });

  it('returns native for Kitty (KITTY_WINDOW_ID)', () => {
    setEnv({ KITTY_WINDOW_ID: '1', TMUX: undefined, WEZTERM_PANE: undefined, GHOSTTY_RESOURCES_DIR: undefined, TERM: undefined, TERM_PROGRAM: undefined });
    expect(detectKittySupport().transport).toBe('native');
  });

  it('returns native for Ghostty (GHOSTTY_RESOURCES_DIR)', () => {
    setEnv({ GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty', KITTY_WINDOW_ID: undefined, TMUX: undefined, WEZTERM_PANE: undefined, TERM: undefined, TERM_PROGRAM: undefined });
    expect(detectKittySupport().transport).toBe('native');
  });

  it('returns native for Ghostty (TERM=xterm-ghostty)', () => {
    setEnv({ TERM: 'xterm-ghostty', KITTY_WINDOW_ID: undefined, TMUX: undefined, WEZTERM_PANE: undefined, GHOSTTY_RESOURCES_DIR: undefined, TERM_PROGRAM: undefined });
    expect(detectKittySupport().transport).toBe('native');
  });

  it('returns native for WezTerm (WEZTERM_PANE)', () => {
    setEnv({ WEZTERM_PANE: '0', KITTY_WINDOW_ID: undefined, TMUX: undefined, GHOSTTY_RESOURCES_DIR: undefined, TERM: undefined, TERM_PROGRAM: undefined });
    expect(detectKittySupport().transport).toBe('native');
  });

  it('returns native for WezTerm (TERM_PROGRAM=WezTerm)', () => {
    setEnv({ TERM_PROGRAM: 'WezTerm', WEZTERM_PANE: undefined, KITTY_WINDOW_ID: undefined, TMUX: undefined, GHOSTTY_RESOURCES_DIR: undefined, TERM: undefined });
    expect(detectKittySupport().transport).toBe('native');
  });

  it('returns tmux when TMUX set + KITTY_WINDOW_ID present', () => {
    setEnv({ TMUX: '/tmp/tmux-501/default,12345,0', KITTY_WINDOW_ID: '1', GHOSTTY_RESOURCES_DIR: undefined, WEZTERM_PANE: undefined, TERM: undefined, TERM_PROGRAM: undefined });
    expect(detectKittySupport().transport).toBe('tmux');
  });

  it('returns tmux when TMUX set + GHOSTTY_RESOURCES_DIR present', () => {
    setEnv({ TMUX: '/tmp/tmux-501/default,12345,0', GHOSTTY_RESOURCES_DIR: '/usr/share/ghostty', KITTY_WINDOW_ID: undefined, WEZTERM_PANE: undefined, TERM: undefined, TERM_PROGRAM: undefined });
    expect(detectKittySupport().transport).toBe('tmux');
  });

  it('returns tmux when TMUX set + TERM=xterm-ghostty present', () => {
    setEnv({ TMUX: '/tmp/tmux-501/default,12345,0', TERM: 'xterm-ghostty', KITTY_WINDOW_ID: undefined, GHOSTTY_RESOURCES_DIR: undefined, WEZTERM_PANE: undefined, TERM_PROGRAM: undefined });
    expect(detectKittySupport().transport).toBe('tmux');
  });

  it('returns unsupported for iTerm2 (TERM_PROGRAM=iTerm.app)', () => {
    setEnv({ TERM_PROGRAM: 'iTerm.app', KITTY_WINDOW_ID: undefined, TMUX: undefined, WEZTERM_PANE: undefined, GHOSTTY_RESOURCES_DIR: undefined, TERM: undefined });
    expect(detectKittySupport().transport).toBe('unsupported');
  });

  it('returns unsupported when no terminal vars set', () => {
    setEnv({ KITTY_WINDOW_ID: undefined, TMUX: undefined, WEZTERM_PANE: undefined, GHOSTTY_RESOURCES_DIR: undefined, TERM: undefined, TERM_PROGRAM: undefined });
    expect(detectKittySupport().transport).toBe('unsupported');
  });

  it('returns unsupported when TMUX set but no supported outer terminal', () => {
    setEnv({ TMUX: '/tmp/tmux-501/default,12345,0', KITTY_WINDOW_ID: undefined, WEZTERM_PANE: undefined, GHOSTTY_RESOURCES_DIR: undefined, TERM: 'xterm-256color', TERM_PROGRAM: undefined });
    expect(detectKittySupport().transport).toBe('unsupported');
  });
});

// ---------------------------------------------------------------------------
// 2. AFK_INLINE_IMAGES=0 opt-out
// ---------------------------------------------------------------------------

describe('detectKittySupport — AFK_INLINE_IMAGES=0 opt-out', () => {
  const saved = {
    inlineImages: process.env['AFK_INLINE_IMAGES'],
    kitty: process.env['KITTY_WINDOW_ID'],
    tmux: process.env['TMUX'],
  };

  afterEach(() => {
    if (saved.inlineImages === undefined) delete process.env['AFK_INLINE_IMAGES'];
    else process.env['AFK_INLINE_IMAGES'] = saved.inlineImages;
    if (saved.kitty === undefined) delete process.env['KITTY_WINDOW_ID'];
    else process.env['KITTY_WINDOW_ID'] = saved.kitty;
    if (saved.tmux === undefined) delete process.env['TMUX'];
    else process.env['TMUX'] = saved.tmux;
  });

  it('returns unsupported when AFK_INLINE_IMAGES=0, even in Kitty', () => {
    process.env['AFK_INLINE_IMAGES'] = '0';
    process.env['KITTY_WINDOW_ID'] = '1';
    delete process.env['TMUX'];
    expect(detectKittySupport().transport).toBe('unsupported');
  });

  it('does not suppress when AFK_INLINE_IMAGES=1 (native, no tmux)', () => {
    process.env['AFK_INLINE_IMAGES'] = '1';
    process.env['KITTY_WINDOW_ID'] = '1';
    delete process.env['TMUX'];
    expect(detectKittySupport().transport).toBe('native');
  });

  it('does not suppress when AFK_INLINE_IMAGES is unset (native, no tmux)', () => {
    delete process.env['AFK_INLINE_IMAGES'];
    process.env['KITTY_WINDOW_ID'] = '1';
    delete process.env['TMUX'];
    expect(detectKittySupport().transport).toBe('native');
  });
});

// ---------------------------------------------------------------------------
// 3. Chunk encoding
// ---------------------------------------------------------------------------

describe('buildKittyChunks', () => {
  it('single chunk when data fits in 4096 bytes', () => {
    const b64 = 'A'.repeat(100);
    const chunks = buildKittyChunks(b64, { f: 100, a: 'T', c: 80, r: 10 });
    expect(chunks).toHaveLength(1);
    // Single chunk must have m=0 (last/only).
    expect(chunks[0]).toContain('m=0');
    // Must include the control keys.
    expect(chunks[0]).toContain('f=100');
    expect(chunks[0]).toContain('a=T');
    // Payload is the full b64.
    expect(chunks[0]).toContain(b64);
  });

  it('APC framing: starts with ESC _G, ends with ESC \\', () => {
    const chunks = buildKittyChunks('AAAA', { f: 100, a: 'T', c: 4, r: 1 });
    expect(chunks[0]!.startsWith('\x1b_G')).toBe(true);
    expect(chunks[0]!.endsWith('\x1b\\')).toBe(true);
  });

  it('multiple chunks when data exceeds 4096 bytes', () => {
    const b64 = 'X'.repeat(9000);
    const chunks = buildKittyChunks(b64, { f: 100, a: 'T', c: 80, r: 10 });
    expect(chunks.length).toBe(3); // 4096 + 4096 + 808

    // First chunk: m=1 (more follow), has f/a keys.
    expect(chunks[0]).toContain('m=1');
    expect(chunks[0]).toContain('f=100');
    expect(chunks[0]).toContain('a=T');

    // Middle chunk: m=1, no f/a keys.
    expect(chunks[1]).toContain('m=1');
    expect(chunks[1]).not.toContain('f=100');

    // Last chunk: m=0, no f/a keys.
    expect(chunks[2]).toContain('m=0');
    expect(chunks[2]).not.toContain('f=100');
  });

  it('reconstructs full payload from chunks', () => {
    const b64 = 'Z'.repeat(8000);
    const chunks = buildKittyChunks(b64, { f: 100, a: 'T' });
    // Extract payload from each chunk: part between ';' and '\x1b\\'
    const payloads = chunks.map((c) => {
      const semi = c.indexOf(';');
      const end = c.lastIndexOf('\x1b\\');
      return c.slice(semi + 1, end);
    });
    expect(payloads.join('')).toBe(b64);
  });

  it('empty b64 produces one chunk with m=0', () => {
    const chunks = buildKittyChunks('', { f: 100, a: 'T' });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('m=0');
  });
});

// ---------------------------------------------------------------------------
// 4. tmux passthrough wrapping
// ---------------------------------------------------------------------------

describe('wrapForTmux', () => {
  it('wraps in DCS tmux passthrough (ESC P tmux; ... ESC \\)', () => {
    const apc = '\x1b_Gf=100,a=T;AAAA\x1b\\';
    const wrapped = wrapForTmux(apc);
    expect(wrapped.startsWith('\x1bPtmux;')).toBe(true);
    expect(wrapped.endsWith('\x1b\\')).toBe(true);
  });

  it('doubles all ESC characters inside the payload', () => {
    const apc = '\x1b_Gf=100;AAAA\x1b\\';
    const wrapped = wrapForTmux(apc);
    // The original has 2 ESC bytes; after wrapping they are each doubled.
    // Outer wrapper adds 2 more ESC bytes (ESC P ... ESC \).
    // Total inner ESC = 4 (doubled), outer = 2, so total = 6.
    const escCount = [...wrapped].filter((c) => c === '\x1b').length;
    expect(escCount).toBe(6);
  });

  it('round-trip: wrapped output contains doubled inner ESC', () => {
    const inner = '\x1b_GA;AAAA\x1b\\';
    const wrapped = wrapForTmux(inner);
    // The doubled-ESC inner payload must be present between the DCS prefix and suffix.
    expect(wrapped).toContain('\x1b\x1b_GA');
    expect(wrapped).toContain('\x1b\x1b\\');
  });
});

// ---------------------------------------------------------------------------
// 5. computeImageCellDimensions
// ---------------------------------------------------------------------------

describe('computeImageCellDimensions', () => {
  it('clamps columns to MAX_COLS (80)', () => {
    const { c } = computeImageCellDimensions(2000, 1000, 200);
    expect(c).toBeLessThanOrEqual(80);
  });

  it('clamps columns to termCols when smaller than MAX_COLS', () => {
    const { c } = computeImageCellDimensions(2000, 1000, 40);
    expect(c).toBeLessThanOrEqual(40);
  });

  it('clamps rows to MAX_ROWS (20)', () => {
    const { r } = computeImageCellDimensions(1000, 5000, 200);
    expect(r).toBeLessThanOrEqual(20);
  });

  it('returns sensible defaults for zero dimensions', () => {
    const { c, r } = computeImageCellDimensions(0, 0, 80);
    expect(c).toBeGreaterThan(0);
    expect(r).toBeGreaterThan(0);
  });

  it('returns at least 1 column and 1 row for tiny images', () => {
    const { c, r } = computeImageCellDimensions(1, 1, 80);
    expect(c).toBeGreaterThanOrEqual(1);
    expect(r).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 6. emitKittyImage — integration (file I/O + chunk emission)
// ---------------------------------------------------------------------------

describe('emitKittyImage', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `kitty-image-test-${Math.random().toString(36).slice(2)}`);
    await mkdir(tmpDir, { recursive: true });
  });

  it('returns false for unsupported transport', async () => {
    const result = await emitKittyImage('/nonexistent.png', vi.fn(), 'unsupported', 80);
    expect(result).toBe(false);
  });

  it('returns false when file does not exist', async () => {
    const writeFn = vi.fn();
    const result = await emitKittyImage('/no/such/file.png', writeFn, 'native', 80);
    expect(result).toBe(false);
    expect(writeFn).not.toHaveBeenCalled();
  });

  it('emits APC chunks and trailing newline for a valid PNG', async () => {
    const pngPath = join(tmpDir, 'test.png');
    await writeFile(pngPath, minimalPng(64, 64));

    const written: string[] = [];
    const writeFn = (data: string): void => { written.push(data); };
    const result = await emitKittyImage(pngPath, writeFn, 'native', 80);

    expect(result).toBe(true);
    // At least one write call.
    expect(written.length).toBeGreaterThan(0);

    // Trailing newline.
    expect(written.at(-1)).toBe('\n');

    // First write is an APC sequence.
    const first = written[0]!;
    expect(first.startsWith('\x1b_G')).toBe(true);
    expect(first.endsWith('\x1b\\')).toBe(true);
    // Must contain f=100 and a=T.
    expect(first).toContain('f=100');
    expect(first).toContain('a=T');
  });

  it('wraps chunks in DCS passthrough for tmux transport', async () => {
    const pngPath = join(tmpDir, 'test.png');
    await writeFile(pngPath, minimalPng(32, 32));

    const written: string[] = [];
    const writeFn = (data: string): void => { written.push(data); };
    await emitKittyImage(pngPath, writeFn, 'tmux', 80);

    // The image chunks (not the trailing newline) should be DCS-wrapped.
    const imageWrites = written.slice(0, -1); // exclude trailing '\n'
    expect(imageWrites.length).toBeGreaterThan(0);
    for (const w of imageWrites) {
      expect(w.startsWith('\x1bPtmux;')).toBe(true);
      expect(w.endsWith('\x1b\\')).toBe(true);
    }
  });

  it('emits multiple chunks for large PNG data', async () => {
    // A file whose base64 is > 4096 bytes requires >1 chunk.
    // 4096 * 3/4 = 3072 raw bytes of data → 4096 b64 chars (boundary).
    // 3073 raw bytes → 4096+4 b64 chars → 2 chunks.
    const bigData = Buffer.alloc(3073, 0x00);
    const pngPath = join(tmpDir, 'big.png');
    await writeFile(pngPath, bigData);

    const written: string[] = [];
    const writeFn = (data: string): void => { written.push(data); };
    // non-PNG data won't parse dimensions — that's fine for this test.
    await emitKittyImage(pngPath, writeFn, 'native', 80);

    // Should be >1 APC write (+ trailing newline).
    expect(written.length).toBeGreaterThan(2);
  });
});
