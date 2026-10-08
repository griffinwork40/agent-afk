/**
 * Tests for readImageDimensions — header-byte dimension parser.
 *
 * Covers: VP8X extended WebP (#2348), VP8 lossy, VP8L lossless, PNG, JPEG, GIF,
 * short-buffer safety, and unknown format fallback.
 */

import { describe, it, expect } from 'vitest';
import { readImageDimensions } from './_image-dimensions.js';

// ---------------------------------------------------------------------------
// Buffer builders
// ---------------------------------------------------------------------------

/** Minimal PNG buffer encoding the IHDR chunk with the given dimensions. */
function makePngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(29);
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buf.writeUInt32BE(13, 8);  // chunk length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** Minimal VP8 lossy WebP buffer for the given dimensions. */
function makeVp8Buffer(width: number, height: number): Buffer {
  // RIFF(4) + fileSize(4) + WEBP(4) + 'VP8 '(4) + chunkSize(4) = 20 bytes header
  // VP8 bitstream frame tag(3) + start code(3) + width/height(4) = 10 bytes
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(10, 16); // chunk data size
  // Frame tag + start code at bytes 20-25 (skip), then width/height at 26-29
  // width stored as (width - 1) in low 14 bits of LE uint16 at offset 26
  buf.writeUInt16LE(width - 1, 26);
  buf.writeUInt16LE(height - 1, 28);
  return buf;
}

/** Minimal VP8L lossless WebP buffer for the given dimensions.
 * Must be ≥30 bytes because readImageDimensions does a global length guard
 * at the start of the webp branch before inspecting the chunk tag. */
function makeVp8lBuffer(width: number, height: number): Buffer {
  // RIFF(4) + fileSize(4) + WEBP(4) + 'VP8L'(4) + chunkSize(4) = 20 bytes header
  // VP8L: signature byte at 20, then packed bits at 21–24 (4 bytes)
  // Pad to 30 bytes to pass the global buf.length < 30 guard in the webp branch.
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(9, 16); // chunk data size
  buf[20] = 0x2f; // VP8L signature
  // width-1 in bits 0-13, height-1 in bits 14-27 of a 32-bit LE word at byte 21
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  buf.writeUInt32LE(bits, 21);
  return buf;
}

/**
 * Minimal VP8X extended WebP buffer for the given canvas dimensions.
 *
 * Layout:
 *   0–3:   'RIFF'
 *   4–7:   file size (LE uint32)
 *   8–11:  'WEBP'
 *   12–15: 'VP8X'
 *   16–19: chunk size = 10 (LE uint32)
 *   20:    flags byte
 *   21–23: reserved (3 bytes)
 *   24–26: canvas_width_minus_one (24-bit LE)
 *   27–29: canvas_height_minus_one (24-bit LE)
 */
function makeVp8xBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16); // chunk data size
  // flags at 20, reserved at 21-23
  buf.writeUIntLE(width - 1, 24, 3);
  buf.writeUIntLE(height - 1, 27, 3);
  return buf;
}

/** Minimal GIF89a buffer for the given dimensions. */
function makeGifBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10);
  buf.write('GIF8', 0, 'ascii');
  buf[4] = 0x39; // '9' (GIF89a)
  buf[5] = 0x61; // 'a'
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** Minimal JPEG buffer encoding a SOF0 marker at the start. */
function makeJpegBuffer(width: number, height: number): Buffer {
  // SOI(2) + SOF0 marker(2) + length(2) + precision(1) + height(2) + width(2)
  const buf = Buffer.alloc(12);
  buf[0] = 0xff; buf[1] = 0xd8;  // SOI
  buf[2] = 0xff; buf[3] = 0xc0;  // SOF0 marker
  buf.writeUInt16BE(9, 4);         // segment length (includes the 2 length bytes)
  buf[6] = 8;                      // precision
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  return buf;
}

// ---------------------------------------------------------------------------
// VP8X tests (new in #2348)
// ---------------------------------------------------------------------------

describe('readImageDimensions — VP8X extended WebP', () => {
  it('returns correct dimensions for a 1280×720 VP8X buffer', () => {
    const buf = makeVp8xBuffer(1280, 720);
    const result = readImageDimensions(buf, 'webp');
    expect(result).toEqual({ width: 1280, height: 720 });
  });

  it('returns correct dimensions for a 100×200 VP8X buffer', () => {
    const buf = makeVp8xBuffer(100, 200);
    const result = readImageDimensions(buf, 'webp');
    expect(result).toEqual({ width: 100, height: 200 });
  });

  it('returns null for a VP8X buffer that is too short (< 30 bytes)', () => {
    const buf = Buffer.alloc(28);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WEBP', 8, 'ascii');
    buf.write('VP8X', 12, 'ascii');
    const result = readImageDimensions(buf, 'webp');
    expect(result).toBeNull();
  });

  it('returns correct dimensions for a large VP8X image (16383×16383 max 14-bit)', () => {
    // 24-bit LE can store up to 2^24-1, but we use a realistic large value
    const buf = makeVp8xBuffer(8000, 6000);
    const result = readImageDimensions(buf, 'webp');
    expect(result).toEqual({ width: 8000, height: 6000 });
  });
});

// ---------------------------------------------------------------------------
// VP8 lossy regression
// ---------------------------------------------------------------------------

describe('readImageDimensions — VP8 lossy WebP', () => {
  it('returns correct dimensions for a 1920×1080 VP8 buffer', () => {
    const buf = makeVp8Buffer(1920, 1080);
    const result = readImageDimensions(buf, 'webp');
    expect(result).toEqual({ width: 1920, height: 1080 });
  });
});

// ---------------------------------------------------------------------------
// VP8L lossless regression
// ---------------------------------------------------------------------------

describe('readImageDimensions — VP8L lossless WebP', () => {
  it('returns correct dimensions for a 640×480 VP8L buffer', () => {
    const buf = makeVp8lBuffer(640, 480);
    const result = readImageDimensions(buf, 'webp');
    expect(result).toEqual({ width: 640, height: 480 });
  });
});

// ---------------------------------------------------------------------------
// PNG, JPEG, GIF regressions
// ---------------------------------------------------------------------------

describe('readImageDimensions — PNG', () => {
  it('returns correct dimensions for a 2210×700 PNG', () => {
    const buf = makePngBuffer(2210, 700);
    expect(readImageDimensions(buf, 'png')).toEqual({ width: 2210, height: 700 });
  });

  it('returns null for a PNG buffer shorter than 24 bytes', () => {
    expect(readImageDimensions(Buffer.alloc(10), 'png')).toBeNull();
  });
});

describe('readImageDimensions — JPEG', () => {
  it('returns correct dimensions for a 800×600 JPEG', () => {
    const buf = makeJpegBuffer(800, 600);
    expect(readImageDimensions(buf, 'jpeg')).toEqual({ width: 800, height: 600 });
  });
});

describe('readImageDimensions — GIF', () => {
  it('returns correct dimensions for a 320×240 GIF', () => {
    const buf = makeGifBuffer(320, 240);
    expect(readImageDimensions(buf, 'gif')).toEqual({ width: 320, height: 240 });
  });
});

// ---------------------------------------------------------------------------
// Unknown / null format
// ---------------------------------------------------------------------------

describe('readImageDimensions — unknown format', () => {
  it('returns null for an unknown format string', () => {
    const buf = makePngBuffer(100, 100);
    expect(readImageDimensions(buf, 'avif')).toBeNull();
  });
});
