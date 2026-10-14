import { describe, it, expect } from 'vitest';
import { detectMediaType } from './detect-media-type.js';

/** Build a Buffer whose first bytes match the pattern, rest are zeros. */
function buf(bytes: number[], totalLength = bytes.length): Buffer {
  const b = Buffer.alloc(totalLength, 0);
  bytes.forEach((v, i) => { b[i] = v; });
  return b;
}

describe('detectMediaType', () => {
  it('recognises PNG by magic bytes 89 50 4E 47', () => {
    expect(detectMediaType(buf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
  });

  it('recognises JPEG by magic bytes FF D8 FF', () => {
    expect(detectMediaType(buf([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
  });

  it('recognises GIF by magic bytes 47 49 46 38 (GIF8)', () => {
    expect(detectMediaType(buf([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
  });

  it('recognises WebP by RIFF....WEBP pattern', () => {
    const b = Buffer.alloc(12, 0);
    // RIFF
    b[0] = 0x52; b[1] = 0x49; b[2] = 0x46; b[3] = 0x46;
    // size (4 bytes, ignored)
    // WEBP
    b[8] = 0x57; b[9] = 0x45; b[10] = 0x42; b[11] = 0x50;
    expect(detectMediaType(b)).toBe('image/webp');
  });

  it('returns null for an empty buffer', () => {
    expect(detectMediaType(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for an unrecognised format', () => {
    expect(detectMediaType(buf([0xde, 0xad, 0xbe, 0xef]))).toBeNull();
  });

  it('returns null when the buffer is too short for WebP', () => {
    // RIFF magic but only 11 bytes — cannot read WEBP at offset 8
    const b = Buffer.alloc(11, 0);
    b[0] = 0x52; b[1] = 0x49; b[2] = 0x46; b[3] = 0x46;
    expect(detectMediaType(b)).toBeNull();
  });
});
