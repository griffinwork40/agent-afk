/**
 * Image dimension reader — pure header-byte utility, no external deps.
 *
 * Extracted from image-generate.ts so it can be shared by view-image.ts
 * without pulling in the image-generate handler's auth, API, and session
 * concerns. image-generate.ts re-exports this via:
 *   `export { readImageDimensions } from './_image-dimensions.js';`
 *
 * @module agent/tools/handlers/_image-dimensions
 */

/**
 * Reads width × height from a PNG, JPEG, WebP, or GIF buffer by inspecting the
 * file header bytes. Returns null when the format is unrecognised or the
 * buffer is too short. Used to enforce MAX_IMAGE_DIMENSION without a lib dep.
 */
export function readImageDimensions(
  buf: Buffer,
  format: string,
): { width: number; height: number } | null {
  try {
    if (format === 'png') {
      // PNG: IHDR chunk starts at byte 16. Width (4 bytes) then height (4 bytes).
      if (buf.length < 24) return null;
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      return { width, height };
    }

    if (format === 'jpeg') {
      // JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 / 0xFF 0xC2).
      let i = 2;
      while (i < buf.length - 8) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1]!;
        const segLen = buf.readUInt16BE(i + 2);
        if (marker === 0xc0 || marker === 0xc2) {
          // Precision (1), height (2), width (2)
          const height = buf.readUInt16BE(i + 5);
          const width = buf.readUInt16BE(i + 7);
          return { width, height };
        }
        i += 2 + segLen;
      }
      return null;
    }

    if (format === 'webp') {
      // WebP: 'RIFF' at 0, 'WEBP' at 8, VP8 chunk at 12.
      if (buf.length < 30) return null;
      const vp8Tag = buf.toString('ascii', 12, 16);
      if (vp8Tag === 'VP8 ') {
        // Lossy: skip 6 bytes after VP8 chunk header → 10 bytes payload header
        // Width and height are 14-bit values at bytes 26-27 and 28-29.
        const width = (buf.readUInt16LE(26) & 0x3fff) + 1;
        const height = (buf.readUInt16LE(28) & 0x3fff) + 1;
        return { width, height };
      }
      if (vp8Tag === 'VP8L') {
        // Lossless: 4-byte signature, then packed width-1 (14 bits) + height-1 (14 bits)
        const bits = buf.readUInt32LE(21);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >> 14) & 0x3fff) + 1;
        return { width, height };
      }
      return null;
    }

    if (format === 'gif') {
      // GIF87a/GIF89a: Logical Screen Descriptor starts at byte 6.
      // Bytes 6-7: width (LE uint16), bytes 8-9: height (LE uint16).
      if (buf.length < 10) return null;
      const sig = buf.toString('ascii', 0, 4);
      if (sig !== 'GIF8') return null;
      const width = buf.readUInt16LE(6);
      const height = buf.readUInt16LE(8);
      return { width, height };
    }
  } catch {
    // Ignore parse errors — guard degrades gracefully to no-attach.
  }
  return null;
}
