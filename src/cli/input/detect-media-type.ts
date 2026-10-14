/**
 * Detect image format by inspecting magic bytes at the start of a buffer.
 *
 * Shared by `clipboard-image.ts` (macOS) and `clipboard-image-linux.ts`.
 * Covers the four formats the Anthropic API accepts: PNG, JPEG, GIF, WebP.
 *
 * @returns The MIME type string, or `null` when the buffer does not start with
 *   a recognised magic-byte sequence.
 *
 * @module cli/input/detect-media-type
 */

import type { ImageAttachment } from './attachments.js';

/**
 * Return the MIME type implied by the magic bytes at the beginning of
 * `buffer`, or `null` when the format is not recognised.
 *
 * Magic-byte references:
 *   - PNG:  `89 50 4E 47 0D 0A 1A 0A`
 *   - JPEG: `FF D8 FF`
 *   - GIF:  `47 49 46 38` ("GIF8")
 *   - WebP: `52 49 46 46 <4 size bytes> 57 45 42 50` ("RIFF....WEBP")
 */
export function detectMediaType(buffer: Buffer): ImageAttachment['mediaType'] | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: 47 49 46 38 ("GIF8")
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38
  ) {
    return 'image/gif';
  }

  // WebP: 52 49 46 46 <4 size bytes> 57 45 42 50 ("RIFF....WEBP")
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}
