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
 *  7. JPEG success + oversized handler tests
 *  8. WebP VP8 + VP8L success + oversized handler tests
 *  9. Error-path tests: nonexistent file, empty file_path, read-root rejection
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createViewImageHandler } from './view-image.js';
import { readImageDimensions } from './_image-dimensions.js';

// ---------------------------------------------------------------------------
// Synthetic image buffers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid JPEG buffer containing a SOF0 segment with the given
 * dimensions. Structure:
 *   [0-1]  SOI marker (0xFF 0xD8)
 *   [2-3]  SOF0 marker (0xFF 0xC0)
 *   [4-5]  segment length = 11 (BE uint16)
 *   [6]    precision = 8
 *   [7-8]  height (BE uint16)
 *   [9-10] width  (BE uint16)
 *   [11]   component count = 3
 *
 * The _image-dimensions parser starts scanning at byte 2 and reads segLen
 * from bytes i+2 (here bytes 4-5 = 11), then checks marker at i+1 = 0xC0.
 * Height is at i+5 = 7, width at i+7 = 9.
 */
function makeJpegBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(12);
  // SOI
  buf[0] = 0xff;
  buf[1] = 0xd8;
  // SOF0
  buf[2] = 0xff;
  buf[3] = 0xc0;
  // Segment length (covers precision + height + width + components = 2+1+2+2+1 = 8... actually standard is 11)
  buf.writeUInt16BE(11, 4);
  // Precision
  buf[6] = 8;
  // Height and width
  buf.writeUInt16BE(height, 7);
  buf.writeUInt16BE(width, 9);
  // Component count
  buf[11] = 3;
  return buf;
}

/**
 * Build a minimal VP8 (lossy) WebP buffer with the given dimensions.
 * WebP VP8 layout (30+ bytes):
 *   [0-3]   'RIFF'
 *   [4-7]   file size (LE uint32) — dummy
 *   [8-11]  'WEBP'
 *   [12-15] 'VP8 '  (note trailing space)
 *   [16-19] chunk size (LE uint32) — dummy
 *   [20-22] VP8 bitstream tag bytes (0x9d 0x01 0x2a for sync code)
 *   [23-25] padding / ignored
 *   [26-27] (width-1) as 14-bit LE uint16
 *   [28-29] (height-1) as 14-bit LE uint16
 */
function makeWebpVP8Buffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);  // dummy file size
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(10, 16); // dummy chunk size
  // VP8 payload: parser reads (width-1) at bytes 26-27 and (height-1) at 28-29
  buf.writeUInt16LE((width - 1) & 0x3fff, 26);
  buf.writeUInt16LE((height - 1) & 0x3fff, 28);
  return buf;
}

/**
 * Build a minimal VP8L (lossless) WebP buffer with the given dimensions.
 * VP8L layout:
 *   [0-3]   'RIFF'
 *   [4-7]   file size
 *   [8-11]  'WEBP'
 *   [12-15] 'VP8L'
 *   [16-19] chunk size
 *   [20]    VP8L signature byte (0x2f)
 *   [21-24] packed: (width-1) in bits 0-13, (height-1) in bits 14-27 (LE uint32)
 */
function makeWebpVP8LBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf[20] = 0x2f; // VP8L signature
  // Pack (width-1) and (height-1) into LE uint32 starting at byte 21
  const packed = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  buf.writeUInt32LE(packed, 21);
  return buf;
}

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

// ---------------------------------------------------------------------------
// Test 7: JPEG handler tests — success + oversized
// ---------------------------------------------------------------------------

describe('readImageDimensions — JPEG header parsing', () => {
  it('parses width and height from a minimal SOF0 JPEG header', () => {
    const buf = makeJpegBuffer(320, 240);
    const dims = readImageDimensions(buf, 'jpeg');
    expect(dims).not.toBeNull();
    expect(dims?.width).toBe(320);
    expect(dims?.height).toBe(240);
  });
});

describe('view_image handler — valid JPEG', () => {
  it('returns success with image field for a small JPEG', async () => {
    const jpegBuf = makeJpegBuffer(200, 150);
    const filePath = path.join(tmpDir, 'photo.jpg');
    await fs.writeFile(filePath, jpegBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeDefined();
    expect(result.image?.mediaType).toBe('image/jpeg');
    expect(result.image?.data).toBe(jpegBuf.toString('base64'));

    const meta = JSON.parse(result.content as string);
    expect(meta.mediaType).toBe('image/jpeg');
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(150);
  });

  it('accepts .jpeg extension as image/jpeg', async () => {
    const jpegBuf = makeJpegBuffer(100, 80);
    const filePath = path.join(tmpDir, 'photo.jpeg');
    await fs.writeFile(filePath, jpegBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    expect(result.image?.mediaType).toBe('image/jpeg');
  });

  it('returns imageOmitted for an oversized JPEG (>8000px width)', async () => {
    const bigJpegBuf = makeJpegBuffer(8001, 100);
    const filePath = path.join(tmpDir, 'big.jpg');
    await fs.writeFile(filePath, bigJpegBuf);

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

// ---------------------------------------------------------------------------
// Test 8: WebP VP8 + VP8L handler tests — success + oversized
// ---------------------------------------------------------------------------

describe('readImageDimensions — WebP VP8 (lossy) parsing', () => {
  it('parses width and height from a VP8 header', () => {
    const buf = makeWebpVP8Buffer(640, 480);
    const dims = readImageDimensions(buf, 'webp');
    expect(dims).not.toBeNull();
    expect(dims?.width).toBe(640);
    expect(dims?.height).toBe(480);
  });
});

describe('readImageDimensions — WebP VP8L (lossless) parsing', () => {
  it('parses width and height from a VP8L header', () => {
    const buf = makeWebpVP8LBuffer(800, 600);
    const dims = readImageDimensions(buf, 'webp');
    expect(dims).not.toBeNull();
    expect(dims?.width).toBe(800);
    expect(dims?.height).toBe(600);
  });
});

describe('view_image handler — valid WebP VP8', () => {
  it('returns success with image field for a small VP8 WebP', async () => {
    const webpBuf = makeWebpVP8Buffer(320, 240);
    const filePath = path.join(tmpDir, 'image.webp');
    await fs.writeFile(filePath, webpBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeDefined();
    expect(result.image?.mediaType).toBe('image/webp');
    expect(result.image?.data).toBe(webpBuf.toString('base64'));

    const meta = JSON.parse(result.content as string);
    expect(meta.mediaType).toBe('image/webp');
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
  });

  it('returns imageOmitted for an oversized VP8 WebP (>8000px height)', async () => {
    const bigWebpBuf = makeWebpVP8Buffer(100, 9000);
    const filePath = path.join(tmpDir, 'tall.webp');
    await fs.writeFile(filePath, bigWebpBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeUndefined();

    const meta = JSON.parse(result.content as string);
    expect(meta.imageOmitted).toBeDefined();
    expect(meta.height).toBe(9000);
  });
});

describe('view_image handler — valid WebP VP8L', () => {
  it('returns success with image field for a small VP8L WebP', async () => {
    const webpBuf = makeWebpVP8LBuffer(400, 300);
    const filePath = path.join(tmpDir, 'lossless.webp');
    await fs.writeFile(filePath, webpBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeDefined();
    expect(result.image?.mediaType).toBe('image/webp');

    const meta = JSON.parse(result.content as string);
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
  });

  it('returns imageOmitted for an oversized VP8L WebP (>8000px width)', async () => {
    const bigWebpBuf = makeWebpVP8LBuffer(8001, 200);
    const filePath = path.join(tmpDir, 'wide.webp');
    await fs.writeFile(filePath, bigWebpBuf);

    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: filePath }, signal);

    expect(result.isError).toBeUndefined();
    expect(result.image).toBeUndefined();

    const meta = JSON.parse(result.content as string);
    expect(meta.imageOmitted).toBeDefined();
    expect(meta.width).toBe(8001);
  });
});

// ---------------------------------------------------------------------------
// Test 9: Error-path tests
// ---------------------------------------------------------------------------

describe('view_image handler — error paths', () => {
  it('returns isError when file_path is an empty string', async () => {
    const handler = createViewImageHandler(tmpDir);
    const result = await handler({ file_path: '' }, signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('non-empty string');
  });

  it('returns isError when file_path is missing (no key)', async () => {
    const handler = createViewImageHandler(tmpDir);
    const result = await handler({}, signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('file_path');
  });

  it('returns isError when input is not an object', async () => {
    const handler = createViewImageHandler(tmpDir);
    const result = await handler('not-an-object', signal);

    expect(result.isError).toBe(true);
  });

  it('returns isError for a nonexistent file path (stat failure)', async () => {
    const handler = createViewImageHandler(tmpDir);
    const nonexistent = path.join(tmpDir, 'does-not-exist.png');
    const result = await handler({ file_path: nonexistent }, signal);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Cannot stat file');
  });

  it('returns isError when file is outside the allowed read root', async () => {
    // Create a file outside the cwd that the handler is confined to
    const outsideDir = await fs.mkdtemp('/tmp/afk-view-image-outside-');
    try {
      const outsideFile = path.join(outsideDir, 'secret.png');
      await fs.writeFile(outsideFile, makePngBuffer(10, 10));

      // Handler confined to tmpDir — outsideFile is outside that root
      const handler = createViewImageHandler(tmpDir);
      const result = await handler({ file_path: outsideFile }, signal);

      expect(result.isError).toBe(true);
      expect(result.content).toContain('outside the allowed');
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
