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
 * Safety layers:
 * - Separate API key (AFK_IMAGE_API_KEY) to avoid billing collision with
 *   the openai-compatible chat provider's OPENAI_API_KEY.
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
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import type { ToolResult } from '../../providers/shared/tool-result.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

  return { prompt, model, size, quality, output_format, output_path };
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
    // 1. Check API key
    const apiKey = env.AFK_IMAGE_API_KEY;
    if (!apiKey) {
      return {
        content:
          'image_generate requires AFK_IMAGE_API_KEY to be set. ' +
          'Get an API key from https://platform.openai.com/api-keys and add it to ~/.afk/config/afk.env:\n' +
          '  AFK_IMAGE_API_KEY=sk-...\n\n' +
          'Note: this is intentionally separate from OPENAI_API_KEY (which funds chat completions) ' +
          'to prevent accidental cross-billing.',
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
    const sessionId = context?.sessionId ?? 'unknown';
    const limitStr = env.AFK_IMAGE_SESSION_LIMIT;
    const limit = limitStr ? parseInt(limitStr, 10) : DEFAULT_SESSION_LIMIT;
    const currentCount = getSessionCount(sessionId);
    if (currentCount >= limit) {
      return {
        content:
          `Image generation limit reached (${limit} per session). ` +
          `Set AFK_IMAGE_SESSION_LIMIT to increase the cap, ` +
          `or start a new session.`,
        isError: true,
      };
    }

    // 4. Parse input
    const parsed = parseInput(input);
    if ('error' in parsed) {
      return { content: parsed.error, isError: true };
    }

    // 5. Call OpenAI Images API
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
        },
        body,
        signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `OpenAI Images API request failed: ${msg}`,
        isError: true,
      };
    }

    if (!response.ok) {
      let errorDetail: string;
      try {
        const errorBody = await response.text();
        errorDetail = errorBody.slice(0, 2000);
      } catch {
        errorDetail = `HTTP ${response.status} ${response.statusText}`;
      }
      return {
        content: `OpenAI Images API returned ${response.status}: ${errorDetail}`,
        isError: true,
      };
    }

    // 6. Parse response
    let responseData: { data?: Array<{ b64_json?: string; revised_prompt?: string }> };
    try {
      responseData = (await response.json()) as typeof responseData;
    } catch {
      return {
        content: 'Failed to parse OpenAI Images API response as JSON.',
        isError: true,
      };
    }

    const imageData = responseData.data?.[0]?.b64_json;
    if (!imageData) {
      return {
        content: 'OpenAI Images API returned no image data (missing b64_json field).',
        isError: true,
      };
    }

    const revisedPrompt = responseData.data?.[0]?.revised_prompt;

    // 7. Save to disk
    const imageId = crypto.randomUUID().slice(0, 8);
    const ext = parsed.output_format;

    let savePath: string;
    if (parsed.output_path) {
      savePath = path.resolve(context?.cwd ?? process.cwd(), parsed.output_path);
    } else {
      const baseDir = context?.cwd ?? process.cwd();
      const dir = path.join(baseDir, '.afk', 'generated-images');
      await fs.mkdir(dir, { recursive: true });
      savePath = path.join(dir, `${imageId}.${ext}`);
    }

    const imageBuffer = Buffer.from(imageData, 'base64');
    try {
      await fs.mkdir(path.dirname(savePath), { recursive: true });
      await fs.writeFile(savePath, imageBuffer);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Image generated successfully but failed to save to disk: ${msg}`,
        isError: true,
      };
    }

    // 8. Increment session counter (only after successful generation + save)
    const newCount = incrementSessionCount(sessionId);

    // 9. Return metadata (no ToolResult.image to avoid context bomb)
    const meta = {
      path: savePath,
      model: parsed.model,
      size: parsed.size,
      quality: parsed.quality,
      format: parsed.output_format,
      bytes: imageBuffer.length,
      revised_prompt: revisedPrompt ?? null,
      session_images_used: newCount,
      session_images_limit: limit,
    };

    return {
      content: JSON.stringify(meta, null, 2),
    };
  };
}

export const imageGenerateHandler = createImageGenerateHandler();
