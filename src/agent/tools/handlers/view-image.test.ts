/**
 * Tests for the `view_image` tool handler.
 *
 * Covers:
 *  1. Unsupported extension → isError
 *  2. Valid PNG → success with image field
 *  3. File > 2 MiB stat → imageOmitted (not isError)
 *  4. Dimension > 8000px (PNG) → imageOmitted with dimension info
 *  5. GIF dimension parsing → readImageDimensions correctly parses GIF header
 *  6. Valid GIF → success with image field
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createViewImageHandler } from './view-image.js';
import { readImageDimensions } from './image-generate.js';

// ---------------------------------------------------------------------------
// Synthetic image buffers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid PNG IHDR buffer with the given dimensions.
 * PNG structure: 8-byte signature + IHDR chunk (4 len + 4 type + 13 data + 4 CRC)
 * Width is at bytes 16-19 (BE uint32), height at bytes 20-23 (BE uint32).
 */
function makePngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(29);
  // PNG signature
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  // IHDR chunk length (13 bytes)
  buf.writeUInt32BE(13, 8);
  // IHDR chunk type
  buf.write('IHDR', 12, 'ascii');
  // Width and height
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  // bit depth, colour type, compression, filter, interlace (dummy values)
  buf[24] = 8;   // bit depth
  buf[25] = 2;   // colour type RGB
  buf[26] = 0;   // compression
  buf[27] = 0;   // filter
  buf[28] = 0;   // interlace
  return buf;
}

/**
 * Build a minimal valid GIF89a header with the given dimensions.
 * GIF structure: 6-byte header + Logical Screen Descriptor
 * Bytes 0-5: "GIF89a", bytes 6-7: width (LE uint16), bytes 8-9: height (LE uint16)
 */
function makeGifBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(13);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const signal = new AbortController().signal;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp('/tmp/afk-view-image-test-');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: Unsupported extension → isError
// ---------------------------------------------------------------------------

describe('view_image handler — unsupported extension', () => {
  it('returns isError with message listing supported formats', async () => {
    const filePath = path.join(tmpDir, 'photo.bmp');
    await fs.writeFile(filePath, Buffer.from('BM'));

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('.bmp');
    expect(result.content).toContain('.png');
    expect(result.content).toContain('.gif');
    expect(result.content).toContain('.webp');
  });

  it('returns isError for .svg extension', async () => {
    const filePath = path.join(tmpDir, 'diagram.svg');
    await fs.writeFile(filePath, '<svg/>');

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unsupported image format');
  });
});

// ---------------------------------------------------------------------------
// Test 2: Valid PNG → success with image field
// ---------------------------------------------------------------------------

describe('view_image handler — valid PNG', () => {
  it('returns success with image field containing base64 data and correct mediaType', async () => {
    const pngBuf = makePngBuffer(100, 80);
    const filePath = path.join(tmpDir, 'test.png');
    await fs.writeFile(filePath, pngBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeDefined();
    expect(result.image?.mediaType).toBe('image/png');
    expect(result.image?.data).toBe(pngBuf.toString('base64'));

    const meta = JSON.parse(result.content as string);
    expect(meta.path).toBe(filePath);
    expect(meta.bytes).toBe(pngBuf.length);
    expect(meta.mediaType).toBe('image/png');
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// Test 3: File > 2 MiB stat → imageOmitted degradation (not isError)
// ---------------------------------------------------------------------------

describe('view_image handler — file > 2 MiB', () => {
  it('returns imageOmitted degradation when stat size exceeds cap', async () => {
    // Create a file that's just over 2 MiB (binary bytes).
    const overCap = 2 * 1024 * 1024 + 1;
    const largeBuf = Buffer.alloc(overCap, 0x00);
    // Rename to .png so it passes extension check
    const filePath = path.join(tmpDir, 'large.png');
    await fs.writeFile(filePath, largeBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeUndefined();

    const meta = JSON.parse(result.content as string);
    expect(meta.imageOmitted).toBeDefined();
    expect(meta.imageOmitted).toContain('exceeds');
    expect(meta.bytes).toBe(overCap);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Dimension > 8000px (PNG) → imageOmitted with dimension info
// ---------------------------------------------------------------------------

describe('view_image handler — oversized PNG dimensions', () => {
  it('returns imageOmitted with dimension info for PNG exceeding 8000px', async () => {
    const pngBuf = makePngBuffer(8001, 100);
    const filePath = path.join(tmpDir, 'big.png');
    await fs.writeFile(filePath, pngBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeUndefined();

    const meta = JSON.parse(result.content as string);
    expect(meta.imageOmitted).toBeDefined();
    expect(meta.width).toBe(8001);
    expect(meta.height).toBe(100);
    expect(meta.imageOmitted).toContain('8001');
  });

  it('returns imageOmitted when height exceeds 8000px', async () => {
    const pngBuf = makePngBuffer(100, 9000);
    const filePath = path.join(tmpDir, 'tall.png');
    await fs.writeFile(filePath, pngBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    const meta = JSON.parse(result.content as string);
    expect(meta.imageOmitted).toBeDefined();
    expect(meta.height).toBe(9000);
  });
});

// ---------------------------------------------------------------------------
// Test 5: GIF dimension parsing — readImageDimensions parses GIF header
// ---------------------------------------------------------------------------

describe('readImageDimensions — GIF header parsing', () => {
  it('parses GIF89a width and height from header', () => {
    const buf = makeGifBuffer(320, 240);
    const dims = readImageDimensions(buf, 'gif');
    expect(dims).not.toBeNull();
    expect(dims?.width).toBe(320);
    expect(dims?.height).toBe(240);
  });

  it('parses GIF87a (also starts with GIF8)', () => {
    const buf = makeGifBuffer(640, 480);
    // Overwrite byte 4-5 to make it GIF87a
    buf.write('7a', 4, 'ascii');
    const dims = readImageDimensions(buf, 'gif');
    expect(dims).not.toBeNull();
    expect(dims?.width).toBe(640);
    expect(dims?.height).toBe(480);
  });

  it('returns null for buffer shorter than 10 bytes', () => {
    const buf = Buffer.alloc(9);
    buf.write('GIF89a', 0, 'ascii');
    const dims = readImageDimensions(buf, 'gif');
    expect(dims).toBeNull();
  });

  it('returns null when signature does not start with GIF8', () => {
    const buf = Buffer.alloc(13);
    buf.write('NOTG', 0, 'ascii');
    const dims = readImageDimensions(buf, 'gif');
    expect(dims).toBeNull();
  });

  it('handles large GIF dimensions (near uint16 max)', () => {
    const buf = makeGifBuffer(65535, 32768);
    const dims = readImageDimensions(buf, 'gif');
    expect(dims?.width).toBe(65535);
    expect(dims?.height).toBe(32768);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Valid GIF → success with image field
// ---------------------------------------------------------------------------

describe('view_image handler — valid GIF', () => {
  it('returns success with image field for a small GIF', async () => {
    const gifBuf = makeGifBuffer(100, 80);
    const filePath = path.join(tmpDir, 'anim.gif');
    await fs.writeFile(filePath, gifBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeDefined();
    expect(result.image?.mediaType).toBe('image/gif');
    expect(result.image?.data).toBe(gifBuf.toString('base64'));

    const meta = JSON.parse(result.content as string);
    expect(meta.mediaType).toBe('image/gif');
    // GIF dimensions are now parsed by readImageDimensions
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(80);
  });

  it('returns imageOmitted for an oversized GIF (>8000px)', async () => {
    const bigGifBuf = makeGifBuffer(8001, 200);
    const filePath = path.join(tmpDir, 'big.gif');
    await fs.writeFile(filePath, bigGifBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeUndefined();

    const meta = JSON.parse(result.content as string);
    expect(meta.imageOmitted).toBeDefined();
    expect(meta.width).toBe(8001);
    expect(meta.imageOmitted).toContain('8001');
  });
});
