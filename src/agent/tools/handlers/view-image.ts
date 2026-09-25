/**
 * Handler for the `view_image` tool.
 *
 * Reads a local image file from disk and returns it inline as a ToolResult.image
 * so the calling session can see images directly — no external API, no billing,
 * no browser session required.
 *
 * The same ToolResult.image plumbing already used by browser_screenshot and
 * image_generate (inspect:true) carries the pixels to the model. This handler
 * simply loads an existing file instead of capturing or generating one.
 *
 * Guards (mirroring browser-screenshot.ts and image-generate.ts):
 *   - 8000px dimension cap  → imageOmitted degradation, not isError
 *   - 2 MiB base64 byte cap → imageOmitted degradation, not isError
 *   - stat() pre-check      → avoid heap OOM on large files
 *   - resolveAndContain()   → same read-root policy as read_file
 *
 * @module agent/tools/handlers/view-image
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import type { ToolResult } from '../../providers/shared/tool-result.js';
import { resolveAndContain } from './_cwd-utils.js';
import { readImageDimensions } from './image-generate.js';

// ---------------------------------------------------------------------------
// Constants — mirror browser-screenshot.ts (L32) and image-generate.ts (L46, L51)
// ---------------------------------------------------------------------------

// Anthropic's vision API hard-rejects any image whose width OR height exceeds
// 8000px — mirrors MAX_IMAGE_DIMENSION in browser-screenshot.ts and image-generate.ts.
const MAX_IMAGE_DIMENSION = 8000;

// Base64 byte cap — 2 MiB of base64 to bound worst-case context consumption.
// Same value as MAX_BASE64_BYTES in image-generate.ts.
const MAX_BASE64_BYTES = 2 * 1024 * 1024; // 2 MiB

// ---------------------------------------------------------------------------
// MIME map
//
// Local re-definition intentionally duplicates the same 4 entries from
// src/agent/tools/subagent/attachment-resolve.ts. That module's public surface
// is resolveSubagentAttachments; importing its private const would create an
// invisible coupling across a module boundary. 4 entries, 4 lines — inline is
// the right call here. Update both if the supported set ever changes.
// ---------------------------------------------------------------------------

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const MIME_MAP = new Map<string, ImageMediaType>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

interface ParsedInput {
  filePath: string;
}

function parseInput(raw: unknown): ParsedInput | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'Invalid input: expected an object with a "file_path" field.' };
  }
  const obj = raw as Record<string, unknown>;
  const filePath = obj['file_path'];
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    return { error: 'Invalid input: "file_path" must be a non-empty string.' };
  }
  return { filePath };
}

// ---------------------------------------------------------------------------
// Handler implementation (inner function, closed over optional cwd)
// ---------------------------------------------------------------------------

async function viewImageImpl(
  input: unknown,
  _signal: AbortSignal,
  context: ToolHandlerContext | undefined,
  cwd: string | undefined,
): Promise<ToolResult> {
  // 1. Parse input
  const parsed = parseInput(input);
  if ('error' in parsed) {
    return { content: parsed.error, isError: true };
  }

  // 2. Resolve and contain path (same read-root policy as read_file)
  let filePath: string;
  try {
    filePath = resolveAndContain(parsed.filePath, context, 'read', cwd);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: msg, isError: true };
  }

  // 3. Determine MIME type from extension
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = MIME_MAP.get(ext);
  if (!mediaType) {
    const supported = [...MIME_MAP.keys()].join(', ');
    return {
      content: `Unsupported image format "${ext}". Supported extensions: ${supported}.`,
      isError: true,
    };
  }

  // 4. stat() pre-check — avoid loading a huge file into memory before we know
  //    we'd reject it anyway. stat().size is raw binary bytes; base64 inflates
  //    by ~4/3 so this is a conservative early-exit before encoding.
  let stat: { size: number };
  try {
    stat = await fs.stat(filePath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Cannot stat file: ${msg}`, isError: true };
  }

  if (stat.size > MAX_BASE64_BYTES) {
    const meta = {
      path: filePath,
      bytes: stat.size,
      mediaType,
      imageOmitted: `File size ${stat.size} bytes exceeds the ${MAX_BASE64_BYTES}-byte cap; image not loaded. Use a smaller image.`,
    };
    return { content: JSON.stringify(meta, null, 2) };
  }

  // 5. Read file
  let buf: Buffer;
  try {
    buf = await fs.readFile(filePath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Error reading file: ${msg}`, isError: true };
  }

  // 6. base64 encode
  const base64 = buf.toString('base64');

  // 7. Definitive base64 byte cap check (base64 string is ~4/3 the binary size)
  if (base64.length > MAX_BASE64_BYTES) {
    const meta = {
      path: filePath,
      bytes: buf.length,
      mediaType,
      imageOmitted: `base64 payload (${base64.length} bytes) exceeds the ${MAX_BASE64_BYTES}-byte cap; image not attached. Use a smaller image or lower resolution.`,
    };
    return { content: JSON.stringify(meta, null, 2) };
  }

  // 8. Dimension guard — map extension to format key for readImageDimensions().
  //    GIF returns null (readImageDimensions does not decode GIF headers);
  //    a null result means no dimension guard fires — image is attached as-is.
  //    This mirrors image-generate.ts L440: `if (dims !== null && ...)`.
  const formatKey = ext === '.jpg' || ext === '.jpeg' ? 'jpeg'
    : ext === '.png' ? 'png'
    : ext === '.webp' ? 'webp'
    : 'gif'; // readImageDimensions returns null for 'gif' — no guard applied

  const dims = readImageDimensions(buf, formatKey);
  if (dims !== null && (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION)) {
    const meta = {
      path: filePath,
      bytes: buf.length,
      width: dims.width,
      height: dims.height,
      mediaType,
      imageOmitted: `dimensions ${dims.width}x${dims.height}px exceed the ${MAX_IMAGE_DIMENSION}px model-vision limit; image not attached. Use a smaller or cropped version.`,
    };
    return { content: JSON.stringify(meta, null, 2) };
  }

  // 9. Success — return image inline
  const meta: Record<string, unknown> = {
    path: filePath,
    bytes: buf.length,
    mediaType,
    ...(dims !== null ? { width: dims.width, height: dims.height } : {}),
  };

  return {
    content: JSON.stringify(meta, null, 2),
    image: { mediaType, data: base64 },
  };
}

// ---------------------------------------------------------------------------
// Exports — factory pattern mirrors createReadFileHandler(cwd?)
// ---------------------------------------------------------------------------

/**
 * Create a `view_image` handler closed over a session-specific base path.
 *
 * When `cwd` is supplied (e.g. a worktree path from `afk interactive -w`),
 * relative paths anchor and are confined to that tree instead of the host
 * `process.cwd()`. Mirrors `createReadFileHandler(cwd?)` from read-file.ts.
 */
export function createViewImageHandler(cwd?: string): ToolHandler {
  return (input, signal, context) => viewImageImpl(input, signal, context, cwd);
}

/** Bare `view_image` handler with no session cwd. */
export const viewImageHandler: ToolHandler = createViewImageHandler();
