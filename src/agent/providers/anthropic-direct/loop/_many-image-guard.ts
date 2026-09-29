/**
 * Many-image dimension guard for the Anthropic-direct provider.
 *
 * Background
 * ----------
 * Anthropic's vision API enforces TWO per-image dimension ceilings that
 * vary with the total number of image blocks in a request:
 *
 *   ≤ 20 images → 8 000 px per side   (documented, enforced by tool handlers)
 *   > 20 images → 2 000 px per side   (undocumented; triggers HTTP 400)
 *
 * The individual tool handlers (view-image, browser-screenshot, image-generate)
 * only enforce the 8 000 px ceiling because they cannot see the full message
 * history at call time. An image with width 2 001–8 000 px passes the tool-
 * level guard but causes a hard 400 once the conversation accumulates >20
 * images. The 400 is not retried (only 529/503 are), and the oversized image
 * block persists in history — so every subsequent turn re-triggers the same
 * 400 indefinitely, making the session unrecoverable.
 *
 * Fix
 * ---
 * `enforceManyImageLimit` is called in `openRound` (round-request.ts) just
 * before `buildRoundParams`. It:
 *   1. Counts all image source blocks across the FULL message list.
 *   2. When the count exceeds MANY_IMAGE_THRESHOLD (20), identifies every
 *      image block whose long side exceeds MAX_DIMENSION_MANY_IMAGES (2 000 px).
 *   3. Replaces each offending image block with a text block carrying the
 *      standard `imageOmitted` degradation message — the same pattern used by
 *      view-image and browser-screenshot, except triggered at request-build
 *      time rather than at tool execution time.
 *   4. Mutates `messages` in place (same as repairOrphanToolUses).
 *
 * The function reads dimensions from the image's raw base64 data using the
 * same zero-dep header-byte parser from `_image-dimensions.ts`, so no new
 * library dependency is introduced.
 *
 * Why mutate and not clone?
 * The messages array is the single source of truth for the ongoing turn. A
 * clone would leave a divergence between what we sent and what the session
 * stores — desirable for the cache-breakpoint stamp (ephemeral marker), but
 * wrong here (the degradation must persist so a retry of the same round does
 * not re-encounter the oversized image).
 *
 * @module agent/providers/anthropic-direct/loop/_many-image-guard
 */

import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { readImageDimensions } from '../../../tools/handlers/_image-dimensions.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Anthropic drops the per-image pixel ceiling from 8 000 px to 2 000 px once
 * a request carries more than this many image blocks.
 */
export const MANY_IMAGE_THRESHOLD = 20;

/**
 * Maximum pixels per side enforced when the request has >MANY_IMAGE_THRESHOLD
 * image blocks. Anthropic's API rejects any image exceeding this with HTTP 400
 * in a many-image request context.
 */
export const MAX_DIMENSION_MANY_IMAGES = 2000;

// ---------------------------------------------------------------------------
// Image-block helpers
// ---------------------------------------------------------------------------

/**
 * A content block with an inline base64 image source as produced by the SDK.
 */
interface Base64ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

function isBase64ImageBlock(block: unknown): block is Base64ImageBlock {
  if (!block || typeof block !== 'object') return false;
  const b = block as Record<string, unknown>;
  if (b['type'] !== 'image') return false;
  const src = b['source'];
  if (!src || typeof src !== 'object') return false;
  const s = src as Record<string, unknown>;
  return s['type'] === 'base64' && typeof s['data'] === 'string';
}

/** Returns true for ANY image block — base64 or URL — to count all toward the threshold. */
function isAnyImageBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  return (block as Record<string, unknown>)['type'] === 'image';
}

/** Map a MIME type string to the format key expected by readImageDimensions.
 * Returns null for unrecognised types — the caller skips dimension parsing for
 * those blocks rather than falling back to a wrong parser. */
function mediaTypeToFormat(mediaType: string): string | null {
  if (mediaType === 'image/jpeg' || mediaType === 'image/jpg') return 'jpeg';
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/webp') return 'webp';
  if (mediaType === 'image/gif') return 'gif';
  return null; // unknown type — skip dimension parsing
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Count ALL image blocks in a messages array — both base64 and URL sources —
 * so the threshold check reflects the true number Anthropic sees on the wire.
 */
function countAllImageBlocks(messages: MessageParam[]): number {
  let count = 0;

  for (const msg of messages) {
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (isAnyImageBlock(block)) {
        count++;
        continue;
      }
      // tool_result blocks contain a nested content array
      if (
        block &&
        typeof block === 'object' &&
        (block as unknown as Record<string, unknown>)['type'] === 'tool_result'
      ) {
        const inner = (block as unknown as Record<string, unknown>)['content'];
        if (Array.isArray(inner)) {
          for (const ib of inner) {
            if (isAnyImageBlock(ib)) count++;
          }
        }
      }
    }
  }

  return count;
}

/**
 * Collect every BASE64 image block (across all message roles and content arrays).
 * URL image blocks are excluded from the result — they cannot be decoded for
 * dimension inspection and must remain unchanged in the replacement pass.
 *
 * Returns an array of objects pointing at the parent content array and the
 * block index so they can be mutated in place.
 */
interface ImageBlockRef {
  parent: unknown[];
  index: number;
  block: Base64ImageBlock;
}

function collectBase64ImageBlocks(messages: MessageParam[]): ImageBlockRef[] {
  const refs: ImageBlockRef[] = [];

  for (const msg of messages) {
    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (isBase64ImageBlock(block)) {
        refs.push({ parent: content as unknown[], index: i, block });
        continue;
      }

      // tool_result blocks contain a nested content array
      if (
        block &&
        typeof block === 'object' &&
        (block as unknown as Record<string, unknown>)['type'] === 'tool_result'
      ) {
        const inner = (block as unknown as Record<string, unknown>)['content'];
        if (Array.isArray(inner)) {
          for (let j = 0; j < inner.length; j++) {
            const inner_block = inner[j];
            if (isBase64ImageBlock(inner_block)) {
              refs.push({ parent: inner as unknown[], index: j, block: inner_block });
            }
          }
        }
      }
    }
  }

  return refs;
}

/**
 * When a request carries more than {@link MANY_IMAGE_THRESHOLD} image blocks,
 * any image whose long side exceeds {@link MAX_DIMENSION_MANY_IMAGES} would
 * cause an Anthropic API HTTP 400. Replace each such block with a text block
 * carrying an `imageOmitted` notice — the same degradation pattern used by the
 * individual tool handlers.
 *
 * Mutates `messages` in place. No-op when the image count is ≤ the threshold
 * or when all images are within the 2 000 px ceiling.
 *
 * @returns The number of image blocks that were downgraded (0 = no action).
 */
export function enforceManyImageLimit(messages: MessageParam[]): number {
  // Count ALL image blocks (base64 + URL) to match what Anthropic sees on the wire.
  // URL blocks count toward the threshold but cannot be decoded — skip them in the
  // replacement pass (they stay unchanged regardless of their dimensions).
  const totalImageCount = countAllImageBlocks(messages);

  // Fast path: fewer than the threshold — no action needed.
  if (totalImageCount <= MANY_IMAGE_THRESHOLD) return 0;

  const refs = collectBase64ImageBlocks(messages);

  let degraded = 0;

  for (const { parent, index, block } of refs) {
    const base64 = block.source.data;
    // Decode only the first 80 base64 chars (~60 raw bytes) to read header bytes.
    // PNG needs bytes 0-23 (32 chars), WebP needs bytes 0-29 (40 chars), GIF
    // needs bytes 0-9 (16 chars) — 80 chars covers all three formats without
    // decoding the entire payload (which can be several MiB per image).
    // JPEG's SOF0/SOF2 marker may sit beyond this prefix; readImageDimensions
    // returns null in that case and we conservatively leave the block alone.
    const buf = Buffer.from(base64.slice(0, 80), 'base64');
    const format = mediaTypeToFormat(block.source.media_type);

    // Unknown media type — skip dimension parsing entirely (don't degrade it).
    if (format === null) continue;

    const dims = readImageDimensions(buf, format);

    // Cannot determine dimensions → leave the block alone. Worst case the API
    // rejects it with its own 400; best case the dimensions are within limits.
    if (dims === null) continue;

    if (dims.width <= MAX_DIMENSION_MANY_IMAGES && dims.height <= MAX_DIMENSION_MANY_IMAGES) {
      continue;
    }

    // Replace the image block with a text block carrying a degradation notice.
    // This mirrors the imageOmitted pattern in view-image.ts and browser-screenshot.ts.
    parent[index] = {
      type: 'text',
      text: JSON.stringify({
        imageOmitted: `Image ${dims.width}x${dims.height}px exceeds the ${MAX_DIMENSION_MANY_IMAGES}px many-image limit (request has >20 images); image was removed from context to prevent an API 400. Use a smaller image or reduce the number of images in the conversation.`,
        width: dims.width,
        height: dims.height,
        mediaType: block.source.media_type,
      }),
    };
    degraded++;
  }

  return degraded;
}
