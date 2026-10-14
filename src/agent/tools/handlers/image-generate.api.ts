/**
 * OpenAI Images API call and output-path resolution for image_generate.
 *
 * Extracted from image-generate.ts to keep the main handler file under the
 * 350-code-line file ceiling (issue #3478). The public surface of
 * image-generate.ts is unchanged; this sibling is an internal concern.
 *
 * @module agent/tools/handlers/image-generate.api
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveAndContain, assertWriteTargetContained } from './_cwd-utils.js';
import { assertNotDenylisted } from './write-denylist.js';
import { errorMessage } from '../../../utils/errors.js';
import type { ToolHandlerContext } from '../types.js';

// ---------------------------------------------------------------------------
// Output path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve (and validate) the output path for a generated image.
 *
 * Contract: for a custom path, enforces write-root containment, denylist, and
 * symlink-target re-validation (fix #2823). For the default path, creates the
 * generated-images dir and returns a unique filename. Returns `{ savePath }`
 * on success, `{ error }` on any validation failure.
 */
export async function resolveGenSavePath(
  outputPath: string | undefined,
  context: ToolHandlerContext | undefined,
  cwd: string,
  imageId: string,
  ext: string,
): Promise<{ savePath: string } | { error: string }> {
  if (outputPath) {
    try {
      const savePath = resolveAndContain(outputPath, context, 'write', cwd);
      assertNotDenylisted(savePath, 'image_generate');
      assertWriteTargetContained(savePath, context, 'image_generate', cwd);
      return { savePath };
    } catch (err: unknown) {
      return { error: errorMessage(err) };
    }
  }
  const dir = path.join(cwd, '.afk', 'generated-images');
  await fs.mkdir(dir, { recursive: true });
  return { savePath: path.join(dir, `${imageId}.${ext}`) };
}

// ---------------------------------------------------------------------------
// OpenAI Images API (standard path for API-key auth)
// ---------------------------------------------------------------------------

export interface ImagesApiResult {
  b64_json: string;
  revised_prompt: string | null;
}

/** Subset of ParsedInput consumed by the API call. */
export interface ImagesApiParams {
  model: string;
  prompt: string;
  size: string;
  quality: string;
  output_format: string;
}

/**
 * Call the OpenAI Images API and return the raw b64_json payload.
 *
 * Contract: `apiKey` must be non-empty (caller-validated). Returns
 * `{ error }` on any network, HTTP, or parse failure so the caller can
 * propagate the message directly without rethrowing.
 */
export async function callImagesApi(
  fetchFn: typeof globalThis.fetch,
  apiKey: string,
  params: ImagesApiParams,
  extraHeaders: Record<string, string> | undefined,
  signal: AbortSignal,
): Promise<ImagesApiResult | { error: string }> {
  const body = JSON.stringify({
    model: params.model,
    prompt: params.prompt,
    size: params.size,
    quality: params.quality,
    output_format: params.output_format,
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
    return { error: `OpenAI Images API request failed: ${errorMessage(err)}` };
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
