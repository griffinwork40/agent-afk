/**
 * Handler for the `image_generate` tool.
 *
 * Calls the OpenAI Images API to generate images from text prompts.
 * Returns the generated image as a file on disk plus JSON metadata in the
 * tool result. The base64 image is NOT injected into ToolResult.image by
 * default to avoid a context-window bomb (~333K-484K tokens per 1024x1024
 * PNG). The model can read the saved file via read_file if it needs to
 * inspect the image in a follow-up turn.
 *
 * Auth resolution (highest wins):
 *   1. `AFK_IMAGE_API_KEY` env var (dedicated billing separation)
 *   2. `resolveOpenAIAuth()` from the openai-compatible provider, which
 *      covers OPENAI_API_KEY, CODEX_API_KEY, ~/.codex/auth.json (API-key
 *      mode), and ChatGPT-subscription OAuth (when AFK_OPENAI_CHATGPT_OAUTH
 *      is truthy). ChatGPT OAuth tokens route through the ChatGPT backend
 *      Responses API (see image-generate.chatgpt.ts) instead of the standard
 *      Images API, which rejects the OAuth token's limited scopes.
 *
 * Safety layers:
 * - Registered in the effect ledger as ALWAYS_EXTERNAL (classifier.ts).
 * - riskClass: 'caution' + concurrencySafe: false in the schema.
 * - Per-session generation cap via AFK_IMAGE_SESSION_LIMIT (default 10).
 * - Daemon/cron sessions blocked unless AFK_IMAGE_ALLOW_DAEMON=1.
 *
 * @module agent/tools/handlers/image-generate
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { env } from '../../../config/env.js';
import { resolveOpenAIAuth } from '../../providers/openai-compatible/auth.js';
import { generateImageViaChatGpt } from './image-generate.chatgpt.js';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import type { ToolResult } from '../../providers/shared/tool-result.js';
import { resolveAndContain } from './_cwd-utils.js';
import { assertNotDenylisted } from './write-denylist.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Anthropic's vision API hard-rejects any image whose width OR height exceeds
// 8000px — mirroring the guard in browser-screenshot.ts.
const MAX_IMAGE_DIMENSION = 8000;

// Base64 byte cap: 2 MB of base64 ≈ 1.5 MB of binary, well within Anthropic's
// 5 MB sidecar limit but bounded to prevent worst-case context bombs on
// unexpectedly large API payloads.
const MAX_BASE64_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Models available on the OpenAI Images API (Sept 2026). */
const VALID_MODELS = new Set([
  'gpt-image-1',
  'gpt-image-1-mini',
  'gpt-image-1.5',
  'gpt-image-2',
]);

const DEFAULT_MODEL = 'gpt-image-1';

const VALID_SIZES = new Set([
  '1024x1024',
  '1024x1536',
  '1536x1024',
  'auto',
]);

const VALID_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);

const VALID_FORMATS = new Set(['png', 'webp', 'jpeg']);

const DEFAULT_SESSION_LIMIT = 10;

// ---------------------------------------------------------------------------
// Per-session generation counter (module-scope, keyed by session id)
// ---------------------------------------------------------------------------

const sessionCounters = new Map<string, number>();

function getSessionCount(sessionId: string): number {
  return sessionCounters.get(sessionId) ?? 0;
}

function incrementSessionCount(sessionId: string): number {
  const next = getSessionCount(sessionId) + 1;
  sessionCounters.set(sessionId, next);
  return next;
}

function decrementSessionCount(sessionId: string): void {
  const current = getSessionCount(sessionId);
  if (current > 0) {
    sessionCounters.set(sessionId, current - 1);
  }
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

interface ParsedInput {
  prompt: string;
  model: string;
  size: string;
  quality: string;
  output_format: string;
  output_path?: string;
  inspect: boolean;
}

function parseInput(
  input: unknown,
): ParsedInput | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'Invalid input: expected an object with at least a "prompt" field.' };
  }

  const obj = input as Record<string, unknown>;
  const prompt = obj['prompt'];
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { error: 'Invalid input: "prompt" must be a non-empty string.' };
  }

  const model = typeof obj['model'] === 'string' ? obj['model'] : DEFAULT_MODEL;
  if (!VALID_MODELS.has(model)) {
    return {
      error: `Invalid model "${model}". Valid models: ${[...VALID_MODELS].join(', ')}.`,
    };
  }

  const size = typeof obj['size'] === 'string' ? obj['size'] : '1024x1024';
  if (!VALID_SIZES.has(size)) {
    return {
      error: `Invalid size "${size}". Valid sizes: ${[...VALID_SIZES].join(', ')}.`,
    };
  }

  const quality = typeof obj['quality'] === 'string' ? obj['quality'] : 'auto';
  if (!VALID_QUALITIES.has(quality)) {
    return {
      error: `Invalid quality "${quality}". Valid values: ${[...VALID_QUALITIES].join(', ')}.`,
    };
  }

  const output_format =
    typeof obj['output_format'] === 'string' ? obj['output_format'] : 'png';
  if (!VALID_FORMATS.has(output_format)) {
    return {
      error: `Invalid output_format "${output_format}". Valid values: ${[...VALID_FORMATS].join(', ')}.`,
    };
  }

  const output_path =
    typeof obj['output_path'] === 'string' ? obj['output_path'] : undefined;

  const inspect = obj['inspect'] === true;

  return { prompt, model, size, quality, output_format, output_path, inspect };
}

// ---------------------------------------------------------------------------
// Dimension reading (header-only, no external deps)
// ---------------------------------------------------------------------------

/**
 * Reads width × height from a PNG, JPEG, or WebP buffer by inspecting the
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
  } catch {
    // Ignore parse errors — guard degrades gracefully to no-attach.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createImageGenerateHandler(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): ToolHandler {
  return async (
    input: unknown,
    signal: AbortSignal,
    context?: ToolHandlerContext,
  ): Promise<ToolResult> => {
    // 1. Resolve auth — prefer dedicated AFK_IMAGE_API_KEY, then fall through
    //    to the full openai-compatible auth chain (OPENAI_API_KEY, CODEX_API_KEY,
    //    ~/.codex/auth.json API-key mode, and ChatGPT-subscription OAuth).
    const dedicatedKey = env.AFK_IMAGE_API_KEY;
    let apiKey: string | undefined;
    let authSource: string | undefined;
    let extraHeaders: Record<string, string> | undefined;

    if (dedicatedKey) {
      apiKey = dedicatedKey;
      authSource = 'AFK_IMAGE_API_KEY';
    } else {
      const resolved = resolveOpenAIAuth(undefined);
      if (resolved.apiKey) {
        apiKey = resolved.apiKey;
        authSource = resolved.source;
        // ChatGPT OAuth tokens need the account id header for billing.
        if (resolved.source === 'chatgpt-oauth' && resolved.accountId) {
          extraHeaders = { 'chatgpt-account-id': resolved.accountId };
        }
      } else if (resolved.source === 'chatgpt-oauth-expired') {
        return {
          content:
            'ChatGPT subscription token from ~/.codex/auth.json is expired. ' +
            'Re-run `codex` to refresh the token, then retry. ' +
            '(AFK reads the token but does not refresh it.)',
          isError: true,
        };
      }
    }

    if (!apiKey) {
      return {
        content:
          'image_generate requires OpenAI auth. Options (checked in order):\n' +
          '  1. AFK_IMAGE_API_KEY in ~/.afk/config/afk.env (dedicated image billing)\n' +
          '  2. OPENAI_API_KEY env var\n' +
          '  3. `codex login --api-key` (writes ~/.codex/auth.json)\n' +
          '  4. ChatGPT subscription OAuth (set AFK_OPENAI_CHATGPT_OAUTH=1)\n\n' +
          'No usable auth was found from any source.',
        isError: true,
      };
    }

    // 2. Daemon gate — AFK_DAEMON_TASK_ID is set when running inside a
    //    daemon/cron scheduled task (see src/config/env.ts).
    const allowDaemon = env.AFK_IMAGE_ALLOW_DAEMON;
    const isDaemon = Boolean(env.AFK_DAEMON_TASK_ID);
    if (isDaemon && allowDaemon !== '1') {
      return {
        content:
          'image_generate is blocked in daemon/cron sessions to prevent unattended API spend. ' +
          'Set AFK_IMAGE_ALLOW_DAEMON=1 to allow autonomous image generation.',
        isError: true,
      };
    }

    // 3. Per-session rate limit
    // F-3: Fail closed when sessionId is absent — no shared 'unknown' bucket.
    const sessionId = context?.sessionId;
    if (!sessionId) {
      return {
        content: 'image_generate requires a session context (sessionId missing)',
        isError: true,
      };
    }
    const limitStr = env.AFK_IMAGE_SESSION_LIMIT;
    // F-2: Guard against NaN from non-numeric AFK_IMAGE_SESSION_LIMIT values.
    const parsedLimit = limitStr ? parseInt(limitStr, 10) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_SESSION_LIMIT;

    // 4. Optimistically increment before the API call to close the TOCTOU race
    //    (F-4); decrement on any failure path so the counter stays accurate.
    incrementSessionCount(sessionId);
    if (getSessionCount(sessionId) > limit) {
      decrementSessionCount(sessionId);
      return {
        content:
          `Image generation limit reached (${limit} per session). ` +
          `Set AFK_IMAGE_SESSION_LIMIT to increase the cap, ` +
          `or start a new session.`,
        isError: true,
      };
    }

    // 5. Parse input
    const parsed = parseInput(input);
    if ('error' in parsed) {
      decrementSessionCount(sessionId);
      return { content: parsed.error, isError: true };
    }

    // 6. Generate image — route through ChatGPT subscription backend when
    //    auth is chatgpt-oauth (the standard Images API rejects the token),
    //    otherwise use the public OpenAI Images API.
    let imageData: string;
    let revisedPrompt: string | null;

    if (authSource === 'chatgpt-oauth' && extraHeaders?.['chatgpt-account-id']) {
      const chatgptResult = await generateImageViaChatGpt({
        prompt: parsed.prompt,
        size: parsed.size,
        quality: parsed.quality,
        output_format: parsed.output_format,
        apiKey: apiKey!,
        accountId: extraHeaders['chatgpt-account-id'],
        signal,
        fetchFn,
      });
      if ('error' in chatgptResult) {
        decrementSessionCount(sessionId);
        return { content: chatgptResult.error, isError: true };
      }
      imageData = chatgptResult.b64_json;
      revisedPrompt = chatgptResult.revised_prompt;
    } else {
      const result = await callImagesApi(
        fetchFn, apiKey!, parsed, extraHeaders, signal,
      );
      if ('error' in result) {
        decrementSessionCount(sessionId);
        return { content: result.error, isError: true };
      }
      imageData = result.b64_json;
      revisedPrompt = result.revised_prompt;
    }

    // 7. Save to disk
    const imageId = crypto.randomUUID().slice(0, 8);
    const ext = parsed.output_format;
    const cwd = context?.cwd ?? process.cwd();

    let savePath: string;
    if (parsed.output_path) {
      // F-1: Apply the same path containment + denylist guards as write_file
      // to prevent path traversal (e.g. ../../.ssh/authorized_keys).
      try {
        savePath = resolveAndContain(parsed.output_path, context, 'write', cwd);
        assertNotDenylisted(savePath, 'image_generate');
      } catch (err: unknown) {
        decrementSessionCount(sessionId);
        const msg = err instanceof Error ? err.message : String(err);
        return { content: msg, isError: true };
      }
    } else {
      const dir = path.join(cwd, '.afk', 'generated-images');
      await fs.mkdir(dir, { recursive: true });
      savePath = path.join(dir, `${imageId}.${ext}`);
    }

    const imageBuffer = Buffer.from(imageData, 'base64');
    try {
      await fs.mkdir(path.dirname(savePath), { recursive: true });
      await fs.writeFile(savePath, imageBuffer);
    } catch (err: unknown) {
      decrementSessionCount(sessionId);
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Image generated successfully but failed to save to disk: ${msg}`,
        isError: true,
      };
    }

    // 8. Session counter was incremented optimistically before the API call (F-4).
    const newCount = getSessionCount(sessionId);

    // 9. Build metadata (always returned in content regardless of inspect flag)
    const meta: Record<string, unknown> = {
      path: savePath,
      model: parsed.model,
      size: parsed.size,
      quality: parsed.quality,
      format: parsed.output_format,
      bytes: imageBuffer.length,
      revised_prompt: revisedPrompt ?? null,
      auth_source: authSource,
      session_images_used: newCount,
      session_images_limit: limit,
    };

    // 10. Optionally attach image for same-turn vision feedback.
    if (parsed.inspect) {
      const formatToMediaType: Record<string, 'image/png' | 'image/jpeg' | 'image/webp'> = {
        png: 'image/png',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
      };
      const mediaType = formatToMediaType[parsed.output_format] ?? 'image/png';

      // Byte cap guard — 2 MiB base64 to bound worst-case context consumption.
      if (imageData.length > MAX_BASE64_BYTES) {
        meta['imageOmitted'] =
          `inspect:true requested but base64 payload (${imageData.length} bytes) exceeds the ` +
          `${MAX_BASE64_BYTES}-byte cap; image saved to disk only. Use a smaller size or lower quality.`;
        return { content: JSON.stringify(meta, null, 2) };
      }

      // Dimension guard — mirrors browser-screenshot.ts MAX_IMAGE_DIMENSION check.
      const dims = readImageDimensions(imageBuffer, parsed.output_format);
      if (dims !== null && (dims.width > MAX_IMAGE_DIMENSION || dims.height > MAX_IMAGE_DIMENSION)) {
        meta['imageOmitted'] =
          `inspect:true requested but image dimensions ${dims.width}x${dims.height}px exceed ` +
          `the ${MAX_IMAGE_DIMENSION}px model-vision limit; image saved to disk only.`;
        return { content: JSON.stringify(meta, null, 2) };
      }

      return {
        content: JSON.stringify(meta, null, 2),
        image: { mediaType, data: imageData },
      };
    }

    return {
      content: JSON.stringify(meta, null, 2),
    };
  };
}

export const imageGenerateHandler = createImageGenerateHandler();

// ---------------------------------------------------------------------------
// OpenAI Images API (standard path for API-key auth)
// ---------------------------------------------------------------------------

interface ImagesApiResult {
  b64_json: string;
  revised_prompt: string | null;
}

async function callImagesApi(
  fetchFn: typeof globalThis.fetch,
  apiKey: string,
  parsed: ParsedInput,
  extraHeaders: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<ImagesApiResult | { error: string }> {
  const body = JSON.stringify({
    model: parsed.model,
    prompt: parsed.prompt,
    size: parsed.size,
    quality: parsed.quality,
    output_format: parsed.output_format,
    n: 1,
  });

  let response: Response;
  try {
    response = await fetchFn('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body,
      signal,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `OpenAI Images API request failed: ${msg}` };
  }

  if (!response.ok) {
    let detail: string;
    try {
      const errorBody = await response.text();
      detail = errorBody.slice(0, 2000);
    } catch {
      detail = `HTTP ${response.status} ${response.statusText}`;
    }
    return { error: `OpenAI Images API returned ${response.status}: ${detail}` };
  }

  let responseData: { data?: Array<{ b64_json?: string; revised_prompt?: string }> };
  try {
    responseData = (await response.json()) as typeof responseData;
  } catch {
    return { error: 'Failed to parse OpenAI Images API response as JSON.' };
  }

  const b64 = responseData.data?.[0]?.b64_json;
  if (!b64) {
    return { error: 'OpenAI Images API returned no image data (missing b64_json field).' };
  }

  return {
    b64_json: b64,
    revised_prompt: responseData.data?.[0]?.revised_prompt ?? null,
  };
}
