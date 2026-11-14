/**
 * Per-image pixel-ceiling guard for the Anthropic-direct provider.
 *
 * Contract: Anthropic rejects (HTTP 400, never resized) any image whose side
 * exceeds a per-request ceiling that depends on how many image blocks the
 * request carries:
 *
 *   ≤ 20 images → 8 000 px per side   (documented)
 *   > 20 images → 2 000 px per side   (undocumented; same hard 400)
 *
 * The 400 is not retried and the oversized block stays in history, so every
 * later turn re-sends it and fails the same way: the session is poisoned. The
 * tool handlers (view-image, browser-screenshot, image-generate) check 8 000 px
 * for their own output, but images also arrive from MCP tools, attachments and
 * resumed history, and the 2 000 px ceiling needs the whole request in view.
 * So this guard ALWAYS runs at request-build time (`openRound`, via
 * `round-request.image-guard.ts`) and:
 *   1. Counts every image block (base64 + URL, top level and inside
 *      tool_result content) to pick the ceiling that applies.
 *   2. Reads each base64 image's dimensions from its header bytes with the
 *      zero-dep parser in `_image-dimensions.ts`. PNG/GIF/WebP decode only an
 *      80-char base64 prefix; JPEG walks marker segments, so it decodes a
 *      64 KiB prefix and falls back to the full payload only when the SOF
 *      marker sits beyond it. Results are cached per image block object
 *      (WeakMap), so a block is measured at most once across rounds.
 *   3. Replaces every image over the ceiling (8 000 exactly is allowed) with a
 *      text block carrying the standard `imageOmitted` JSON, naming the
 *      measured size, the ceiling and what to do instead.
 *   4. Mutates `messages` in place (the repair must persist, including across
 *      a resume — the caller invalidates the journal from the earliest
 *      mutated message index reported here).
 * URL images, unknown media types and images whose dimensions cannot be read
 * are left alone. A decode/parse exception is contained per image: the block
 * is left untouched and the scan continues.
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

/**
 * Maximum pixels per side when the request has ≤MANY_IMAGE_THRESHOLD image
 * blocks. Inclusive: an 8 000 px side is accepted. Matches the tool handlers.
 */
export const MAX_DIMENSION_SINGLE_IMAGE = 8000;

/** Base64 chars decoded for PNG/GIF/WebP headers (60 raw bytes). */
const HEADER_PREFIX_CHARS = 80;
/** Base64 chars decoded on the first JPEG attempt (65 535 raw bytes). */
const JPEG_PREFIX_CHARS = 87_380;

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
 * Returns an array of objects pointing at the parent content array, the block
 * index and the owning message index so they can be mutated in place.
 */
interface ImageBlockRef {
  parent: unknown[];
  index: number;
  messageIndex: number;
  block: Base64ImageBlock;
}

function collectBase64ImageBlocks(messages: MessageParam[]): ImageBlockRef[] {
  const refs: ImageBlockRef[] = [];

  for (let m = 0; m < messages.length; m++) {
    const content = messages[m]!.content;
    if (!Array.isArray(content)) continue;

    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (isBase64ImageBlock(block)) {
        refs.push({ parent: content as unknown[], index: i, messageIndex: m, block });
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
            const innerBlock = inner[j];
            if (isBase64ImageBlock(innerBlock)) {
              refs.push({ parent: inner as unknown[], index: j, messageIndex: m, block: innerBlock });
            }
          }
        }
      }
    }
  }

  return refs;
}

type Dims = { width: number; height: number };

/**
 * Per-block dimension cache. Keyed by the image block OBJECT so an unchanged
 * history block is measured once, however many rounds re-send it. `null`
 * (undeterminable) is cached too, so an unreadable JPEG is not re-decoded.
 */
const dimensionCache = new WeakMap<object, Dims | null>();

function measure(block: Base64ImageBlock, format: string): Dims | null {
  const data = block.source.data;
  if (format !== 'jpeg') {
    return readImageDimensions(Buffer.from(data.slice(0, HEADER_PREFIX_CHARS), 'base64'), format);
  }
  // JPEG: the SOF marker follows APPn/DQT/DHT segments (an ICC profile alone
  // can be several KiB), so an 80-char prefix is not enough.
  const head = readImageDimensions(Buffer.from(data.slice(0, JPEG_PREFIX_CHARS), 'base64'), format);
  if (head !== null || data.length <= JPEG_PREFIX_CHARS) return head;
  return readImageDimensions(Buffer.from(data, 'base64'), format);
}

/** Cached dimension read. Throws only if decoding/parsing throws (caller contains it). */
function dimensionsOf(block: Base64ImageBlock, format: string): Dims | null {
  if (dimensionCache.has(block)) return dimensionCache.get(block) ?? null;
  const dims = measure(block, format);
  dimensionCache.set(block, dims);
  return dims;
}

/** One image block replaced by {@link enforceImageLimits}. */
export interface OmittedImage {
  width: number;
  height: number;
  mediaType: string;
  messageIndex: number;
}

/** What {@link enforceImageLimits} found and did. */
export interface ImageLimitReport {
  /** Total image blocks (base64 + URL) in the request before repair. */
  imageCount: number;
  /** Per-side ceiling that applied: 8 000 (≤20 images) or 2 000 (>20). */
  maxDimension: number;
  /** True when the >20-image ceiling applied. */
  manyImage: boolean;
  omitted: OmittedImage[];
  /** Smallest message index mutated, or null when nothing was replaced. */
  earliestMessageIndex: number | null;
}

/** Model-facing replacement text: size, ceiling, and what to do instead. */
function omittedText(dims: Dims, ceiling: number, manyImage: boolean, mediaType: string): string {
  const scope = manyImage
    ? `the ${ceiling}px per-side limit for requests with more than ${MANY_IMAGE_THRESHOLD} images`
    : `the ${ceiling}px per-side image limit`;
  const fix = manyImage
    ? `Use images of at most ${ceiling}px per side or reduce the number of images in the conversation.`
    : `Retake it at viewport size instead of full page, capture a single element, or save it to a file and view a cropped or smaller version (at most ${ceiling}px per side).`;
  return JSON.stringify({
    imageOmitted: `Image ${dims.width}x${dims.height}px exceeds ${scope}; it was removed from context to prevent an API 400. ${fix}`,
    width: dims.width,
    height: dims.height,
    maxDimension: ceiling,
    mediaType,
  });
}

/**
 * Enforce the per-image pixel ceiling on every base64 image in `messages`:
 * {@link MAX_DIMENSION_SINGLE_IMAGE} when the request carries ≤
 * {@link MANY_IMAGE_THRESHOLD} image blocks, {@link MAX_DIMENSION_MANY_IMAGES}
 * otherwise. Replaces each offending block with an `imageOmitted` text block,
 * in place. Never throws for a malformed image: that block is left alone.
 */
export function enforceImageLimits(messages: MessageParam[]): ImageLimitReport {
  // Count ALL image blocks (base64 + URL) to match what Anthropic sees on the wire.
  const imageCount = countAllImageBlocks(messages);
  const manyImage = imageCount > MANY_IMAGE_THRESHOLD;
  const ceiling = manyImage ? MAX_DIMENSION_MANY_IMAGES : MAX_DIMENSION_SINGLE_IMAGE;
  const report: ImageLimitReport = { imageCount, maxDimension: ceiling, manyImage, omitted: [], earliestMessageIndex: null };
  if (imageCount === 0) return report;

  for (const { parent, index, messageIndex, block } of collectBase64ImageBlocks(messages)) {
    const format = mediaTypeToFormat(block.source.media_type);
    // Unknown media type — skip dimension parsing entirely (don't degrade it).
    if (format === null) continue;

    let dims: Dims | null;
    try {
      dims = dimensionsOf(block, format);
    } catch {
      // Contained: a bad payload must never fail the request. Leave it alone.
      continue;
    }
    // Cannot determine dimensions → leave the block alone. Worst case the API
    // rejects it with its own 400; best case the dimensions are within limits.
    if (dims === null) continue;
    if (dims.width <= ceiling && dims.height <= ceiling) continue;

    parent[index] = { type: 'text', text: omittedText(dims, ceiling, manyImage, block.source.media_type) };
    report.omitted.push({ width: dims.width, height: dims.height, mediaType: block.source.media_type, messageIndex });
    if (report.earliestMessageIndex === null || messageIndex < report.earliestMessageIndex) {
      report.earliestMessageIndex = messageIndex;
    }
  }

  return report;
}

/**
 * Back-compat wrapper over {@link enforceImageLimits}.
 *
 * @returns The number of image blocks that were replaced (0 = no action).
 */
export function enforceManyImageLimit(messages: MessageParam[]): number {
  return enforceImageLimits(messages).omitted.length;
}
