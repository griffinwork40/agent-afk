/**
 * Handler for the `image_edit` tool.
 *
 * Calls the OpenAI Images Edit API (`POST /v1/images/edits`) with one or more
 * local reference image files encoded as multipart/form-data.  Returns the
 * edited image saved to disk plus JSON metadata, mirroring image_generate.
 *
 * Auth resolution (same chain as image_generate, highest wins):
 *   1. `AFK_IMAGE_API_KEY`   — dedicated billing key
 *   2. `resolveOpenAIAuth()` — OPENAI_API_KEY / Codex auth.json
 *   Note: ChatGPT subscription OAuth is explicitly rejected — the Images Edit
 *   endpoint does not accept those tokens (wrong OAuth scope).
 *
 * Safety layers (identical to image_generate):
 *   - Registered in the effect ledger as ALWAYS_EXTERNAL (classifier.ts).
 *   - riskClass: 'caution' + concurrencySafe: false in the schema.
 *   - Per-session edit cap via AFK_IMAGE_SESSION_LIMIT (shared with generation).
 *   - Daemon/cron sessions blocked unless AFK_IMAGE_ALLOW_DAEMON=1.
 *
 * Reference image validation:
 *   - File must exist and be readable (uses the same read-root path policy as
 *     read_file / view_image via resolveAndContain).
 *   - Extension must be png, jpg/jpeg, or webp.
 *   - File size must be ≤ 25 MB (OpenAI API hard limit).
 *
 * @module agent/tools/handlers/image-edit
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { FormData as UndiciFormData } from 'undici';
import { env } from '../../../config/env.js';
import { resolveOpenAIAuth } from '../../providers/openai-compatible/auth.js';
import type { ToolHandler, ToolHandlerContext } from '../types.js';
import type { ToolResult } from '../../providers/shared/tool-result.js';
import { resolveAndContain, assertWriteTargetContained } from './_cwd-utils.js';
import { assertNotDenylisted } from './write-denylist.js';
import { makeSessionCounter } from './_image-operation.js';
import { h1ModelFetch } from '../../providers/shared/h1-fetch.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** OpenAI hard limit for each image uploaded to the edits endpoint. */
const MAX_REF_IMAGE_BYTES = 25 * 1024 * 1024; // 25 MiB

/** Supported reference image extensions (OpenAI Images Edit API). */
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Default session limit (shared with image_generate). */
const DEFAULT_SESSION_LIMIT = 10;

// ---------------------------------------------------------------------------
// Per-session edit counter (module-scope, keyed by session id)
//
// image_edit and image_generate share AFK_IMAGE_SESSION_LIMIT but maintain
// separate counters — an edit doesn't consume a "generate" slot and vice versa.
// Both are billed to the same API key, but the cap semantics are per-tool.
// ---------------------------------------------------------------------------

const editCounter = makeSessionCounter();

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

interface ParsedInput {
  prompt: string;
  image_paths: string[];
  model: string;
  size: string;
  quality: string;
  output_format: string;
  output_path?: string;
}

const VALID_EDIT_MODELS = new Set(['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2']);
const DEFAULT_EDIT_MODEL = 'gpt-image-1';

const VALID_EDIT_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);
const VALID_EDIT_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
const VALID_EDIT_FORMATS = new Set(['png', 'webp', 'jpeg']);

function parseInput(input: unknown): ParsedInput | { error: string } {
  if (!input || typeof input !== 'object') {
    return { error: 'Invalid input: expected an object with at least "prompt" and "image_paths" fields.' };
  }

  const obj = input as Record<string, unknown>;

  const prompt = obj['prompt'];
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { error: 'Invalid input: "prompt" must be a non-empty string.' };
  }

  const rawPaths = obj['image_paths'];
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    return { error: 'Invalid input: "image_paths" must be a non-empty array of file path strings.' };
  }
  if (rawPaths.length > 16) {
    return { error: 'Invalid input: "image_paths" may contain at most 16 file paths.' };
  }
  for (let i = 0; i < rawPaths.length; i++) {
    if (typeof rawPaths[i] !== 'string' || (rawPaths[i] as string).trim().length === 0) {
      return { error: `Invalid input: "image_paths[${i}]" must be a non-empty string.` };
    }
  }
  const image_paths = rawPaths as string[];

  const model =
    typeof obj['model'] === 'string' ? obj['model'] : DEFAULT_EDIT_MODEL;
  if (!VALID_EDIT_MODELS.has(model)) {
    return {
      error: `Invalid model "${model}". Valid models: ${[...VALID_EDIT_MODELS].join(', ')}.`,
    };
  }

  const size =
    typeof obj['size'] === 'string' ? obj['size'] : '1024x1024';
  if (!VALID_EDIT_SIZES.has(size)) {
    return {
      error: `Invalid size "${size}". Valid sizes: ${[...VALID_EDIT_SIZES].join(', ')}.`,
    };
  }

  const quality =
    typeof obj['quality'] === 'string' ? obj['quality'] : 'auto';
  if (!VALID_EDIT_QUALITIES.has(quality)) {
    return {
      error: `Invalid quality "${quality}". Valid values: ${[...VALID_EDIT_QUALITIES].join(', ')}.`,
    };
  }

  const output_format =
    typeof obj['output_format'] === 'string' ? obj['output_format'] : 'png';
  if (!VALID_EDIT_FORMATS.has(output_format)) {
    return {
      error: `Invalid output_format "${output_format}". Valid values: ${[...VALID_EDIT_FORMATS].join(', ')}.`,
    };
  }

  const output_path =
    typeof obj['output_path'] === 'string' ? obj['output_path'] : undefined;

  return { prompt, image_paths, model, size, quality, output_format, output_path };
}

// ---------------------------------------------------------------------------
// Reference image loader
// ---------------------------------------------------------------------------

interface RefImage {
  name: string;
  buf: Buffer;
  ext: string;
}

/**
 * Resolves, validates (extension + size), and loads each reference image path.
 * Returns the loaded images or an error string on the first failure.
 */
async function loadRefImages(
  rawPaths: string[],
  context: ToolHandlerContext | undefined,
  cwd: string,
): Promise<RefImage[] | { error: string }> {
  const images: RefImage[] = [];

  for (const rawPath of rawPaths) {
    // Path containment — same read-root policy as read_file/view_image.
    let resolvedPath: string;
    try {
      resolvedPath = resolveAndContain(rawPath, context, 'read', cwd);
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    // Extension check.
    const ext = path.extname(resolvedPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        error:
          `Reference image "${rawPath}" has unsupported extension "${ext}". ` +
          `Supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}.`,
      };
    }

    // Size pre-check via stat() to avoid loading a huge file.
    let statResult: { size: number };
    try {
      statResult = await fs.stat(resolvedPath);
    } catch (err: unknown) {
      return { error: `Cannot stat reference image "${rawPath}": ${err instanceof Error ? err.message : String(err)}` };
    }

    if (statResult.size > MAX_REF_IMAGE_BYTES) {
      return {
        error:
          `Reference image "${rawPath}" is ${statResult.size} bytes, which exceeds the ` +
          `${MAX_REF_IMAGE_BYTES}-byte (25 MiB) limit per image.`,
      };
    }

    // Load file.
    let buf: Buffer;
    try {
      buf = Buffer.from(await fs.readFile(resolvedPath));
    } catch (err: unknown) {
      return { error: `Failed to read reference image "${rawPath}": ${err instanceof Error ? err.message : String(err)}` };
    }

    images.push({ name: path.basename(resolvedPath), buf, ext });
  }

  return images;
}

// ---------------------------------------------------------------------------
// Output saver
// ---------------------------------------------------------------------------

/**
 * Resolves the output path (custom or auto-generated) and writes the image.
 * Returns the save path or an error string.
 */
async function saveEditedImage(
  b64: string,
  outputFormat: string,
  outputPath: string | undefined,
  context: ToolHandlerContext | undefined,
  cwd: string,
): Promise<{ savePath: string; imageBuffer: Buffer } | { error: string }> {
  const imageId = crypto.randomUUID().slice(0, 8);

  let savePath: string;
  if (outputPath) {
    // F-2823: Also re-validate the symlink target — a dangling link inside the
    // write root can point outside it, bypassing containment and denylist checks.
    try {
      savePath = resolveAndContain(outputPath, context, 'write', cwd);
      assertNotDenylisted(savePath, 'image_edit');
      assertWriteTargetContained(savePath, context, 'image_edit', cwd);
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    const dir = path.join(cwd, '.afk', 'generated-images');
    await fs.mkdir(dir, { recursive: true });
    savePath = path.join(dir, `edited-${imageId}.${outputFormat}`);
  }

  const imageBuffer = Buffer.from(b64, 'base64');
  try {
    await fs.mkdir(path.dirname(savePath), { recursive: true });
    await fs.writeFile(savePath, imageBuffer);
  } catch (err: unknown) {
    return { error: `Image edited successfully but failed to save to disk: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { savePath, imageBuffer };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createImageEditHandler(
  fetchFn: typeof globalThis.fetch = h1ModelFetch,
): ToolHandler {
  return async (
    input: unknown,
    signal: AbortSignal,
    context?: ToolHandlerContext,
  ): Promise<ToolResult> => {
    // 1. Auth — same chain as image_generate.
    const dedicatedKey = env.AFK_IMAGE_API_KEY;
    let apiKey: string | undefined;
    let authSource: string | undefined;

    if (dedicatedKey) {
      apiKey = dedicatedKey;
      authSource = 'AFK_IMAGE_API_KEY';
    } else {
      const resolved = resolveOpenAIAuth(undefined);
      if (resolved.source === 'chatgpt-oauth') {
        // The standard Images Edit endpoint does not accept ChatGPT OAuth tokens
        // (their OAuth scopes exclude api.model.images.request). Unlike
        // image_generate, there is no ChatGPT backend path for image editing.
        // Reject early with actionable guidance rather than sending an invalid
        // token to the API.
        return {
          content:
            'image_edit does not support ChatGPT subscription OAuth credentials. ' +
            'The Images Edit endpoint requires an API key. ' +
            'Use one of the supported credential sources:\n' +
            '  1. AFK_IMAGE_API_KEY in ~/.afk/config/afk.env (dedicated image billing)\n' +
            '  2. OPENAI_API_KEY env var\n' +
            '  3. `codex login --api-key` (writes ~/.codex/auth.json)',
          isError: true,
        };
      } else if (resolved.apiKey) {
        apiKey = resolved.apiKey;
        authSource = resolved.source;
      } else if (resolved.source === 'chatgpt-oauth-expired') {
        return {
          content:
            'ChatGPT subscription token from ~/.codex/auth.json is expired. ' +
            'Re-run `codex` to refresh the token, then retry.',
          isError: true,
        };
      }
    }

    if (!apiKey) {
      return {
        content:
          'image_edit requires OpenAI auth. Options (checked in order):\n' +
          '  1. AFK_IMAGE_API_KEY in ~/.afk/config/afk.env (dedicated image billing)\n' +
          '  2. OPENAI_API_KEY env var\n' +
          '  3. `codex login --api-key` (writes ~/.codex/auth.json)\n\n' +
          'No usable auth was found from any source.',
        isError: true,
      };
    }

    // 2. Daemon gate.
    if (Boolean(env.AFK_DAEMON_TASK_ID) && env.AFK_IMAGE_ALLOW_DAEMON !== '1') {
      return {
        content:
          'image_edit is blocked in daemon/cron sessions to prevent unattended API spend. ' +
          'Set AFK_IMAGE_ALLOW_DAEMON=1 to allow autonomous image editing.',
        isError: true,
      };
    }

    // 3. Session id required.
    const sessionId = context?.sessionId;
    if (!sessionId) {
      return { content: 'image_edit requires a session context (sessionId missing)', isError: true };
    }

    // 4. Per-session cap.
    const limitStr = env.AFK_IMAGE_SESSION_LIMIT;
    const parsedLimit = limitStr ? parseInt(limitStr, 10) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_SESSION_LIMIT;

    // Optimistic increment before the API call (closes the TOCTOU race).
    editCounter.increment(sessionId);
    if (editCounter.get(sessionId) > limit) {
      editCounter.decrement(sessionId);
      return {
        content:
          `Image edit limit reached (${limit} per session). ` +
          `Set AFK_IMAGE_SESSION_LIMIT to increase the cap, or start a new session.`,
        isError: true,
      };
    }

    // 5. Parse input.
    const parsed = parseInput(input);
    if ('error' in parsed) {
      editCounter.decrement(sessionId);
      return { content: parsed.error, isError: true };
    }

    // 6. Load reference images.
    const cwd = context?.resolveBase ?? process.cwd();
    const loadResult = await loadRefImages(parsed.image_paths, context, cwd);
    if ('error' in loadResult) {
      editCounter.decrement(sessionId);
      return { content: loadResult.error, isError: true };
    }

    // 7. Call the OpenAI Images Edit API.
    const apiResult = await callImagesEditApi(fetchFn, apiKey, parsed, loadResult, signal);
    if ('error' in apiResult) {
      editCounter.decrement(sessionId);
      return { content: apiResult.error, isError: true };
    }

    // 8. Save edited image to disk.
    const saveResult = await saveEditedImage(
      apiResult.b64_json, parsed.output_format, parsed.output_path, context, cwd,
    );
    if ('error' in saveResult) {
      editCounter.decrement(sessionId);
      return { content: saveResult.error, isError: true };
    }

    const { savePath, imageBuffer } = saveResult;
    const newCount = editCounter.get(sessionId);

    return {
      content: JSON.stringify({
        path: savePath,
        model: parsed.model,
        size: parsed.size,
        format: parsed.output_format,
        bytes: imageBuffer.length,
        source_images: parsed.image_paths,
        auth_source: authSource,
        session_edits_used: newCount,
        session_edits_limit: limit,
      }, null, 2),
    };
  };
}

export const imageEditHandler = createImageEditHandler();

// ---------------------------------------------------------------------------
// OpenAI Images Edit API
// ---------------------------------------------------------------------------

interface ImagesEditApiResult {
  b64_json: string;
}

async function callImagesEditApi(
  fetchFn: typeof globalThis.fetch,
  apiKey: string,
  parsed: ParsedInput,
  imageBuffers: Array<{ name: string; buf: Buffer; ext: string }>,
  signal: AbortSignal,
): Promise<ImagesEditApiResult | { error: string }> {
  // Build multipart/form-data payload using undici's FormData (not
  // globalThis.FormData). npm undici 8 brand-checks the body object via
  // webidl.is.FormData before serializing it; passing globalThis.FormData
  // fails that check when the body is processed by h1ModelFetch (which uses
  // undici's own fetch internally). globalThis.Blob is accepted as file parts
  // — undici uses webidl.is.Blob which resolves to the same built-in Blob
  // class on Node 22+. See issue #3345.
  const form = new UndiciFormData();

  // image field: single file or first file (API accepts one primary image).
  // Additional images are passed as extra `image[]` fields.
  const extToMime: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };

  for (const { name, buf, ext } of imageBuffers) {
    const mime = extToMime[ext] ?? 'application/octet-stream';
    // Use Uint8Array to satisfy the BlobPart type constraint on Node's Buffer.
    form.append('image[]', new Blob([new Uint8Array(buf)], { type: mime }), name);
  }

  form.append('prompt', parsed.prompt);
  form.append('model', parsed.model);
  form.append('size', parsed.size);
  form.append('quality', parsed.quality);
  form.append('response_format', 'b64_json');
  form.append('n', '1');

  let response: Response;
  try {
    // Cast required: undici's FormData and globalThis.FormData are nominally
    // distinct types. At runtime h1ModelFetch (undici's own fetch) deserializes
    // the body correctly because it accepts its own FormData instance. For an
    // injectable fetchFn the same cast is safe: any fetch implementation that
    // handles multipart MUST accept a FormData-like body — the brand-check issue
    // only affects undici's body extraction, not the wire format.
    response = await fetchFn('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // Do NOT set Content-Type — fetch sets it automatically with the
        // correct multipart boundary when the body is FormData.
      },
      body: form as unknown as BodyInit,
      signal,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `OpenAI Images Edit API request failed: ${msg}` };
  }

  if (!response.ok) {
    let detail: string;
    try {
      const errorBody = await response.text();
      detail = errorBody.slice(0, 2000);
    } catch {
      detail = `HTTP ${response.status} ${response.statusText}`;
    }
    return { error: `OpenAI Images Edit API returned ${response.status}: ${detail}` };
  }

  let responseData: { data?: Array<{ b64_json?: string }> };
  try {
    responseData = (await response.json()) as typeof responseData;
  } catch {
    return { error: 'Failed to parse OpenAI Images Edit API response as JSON.' };
  }

  const b64 = responseData.data?.[0]?.b64_json;
  if (!b64) {
    return { error: 'OpenAI Images Edit API returned no image data (missing b64_json field).' };
  }

  return { b64_json: b64 };
}
