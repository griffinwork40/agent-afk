/**
 * ChatGPT-subscription image generation via the Codex Responses endpoint.
 *
 * When the auth source is `chatgpt-oauth`, the standard OpenAI Images API
 * (`api.openai.com/v1/images/generations`) rejects the token because its
 * OAuth scopes exclude `api.model.images.request`. This module routes image
 * generation through the ChatGPT backend's Responses API instead, using a
 * chat model (e.g. `gpt-5.5`) with the `image_generation` tool forced via
 * `tool_choice`. The request bills against the user's ChatGPT subscription
 * (Plus / Pro / Team), not API credits.
 *
 * Wire protocol:
 *   POST https://chatgpt.com/backend-api/codex/responses
 *   Headers: Authorization, chatgpt-account-id, OpenAI-Beta, originator
 *   Body:   Responses API format with `stream: true` (mandatory)
 *   Response: SSE stream containing `response.image_generation_call.*` events
 *
 * The SSE stream emits events typed as:
 *   - `response.image_generation_call.partial_image` (optional progressive)
 *   - `response.image_generation_call.completed` (missing from some models)
 *   - `response.completed` (final event, carries `output[]` with the result)
 *
 * @module agent/tools/handlers/image-generate.chatgpt
 */

import {
  CHATGPT_BACKEND_BASE_URL,
  buildChatGptOAuthHeaders,
} from '../../providers/openai-compatible/responses-config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESPONSES_URL = `${CHATGPT_BACKEND_BASE_URL}/responses`;

/**
 * Chat model that hosts the `image_generation` tool on the ChatGPT backend.
 * The backend only serves chat models that have the image_generation tool
 * wired; image-specific models (gpt-image-1, dall-e-3) are rejected with a
 * 400, and older chat models (gpt-4o) lack the tool entirely. gpt-4.1 is the
 * lightest model confirmed to support it.
 */
const CHATGPT_IMAGE_HOST_MODEL = 'gpt-6-sol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatGptImageResult {
  b64_json: string;
  revised_prompt: string | null;
}

interface ImageGenCallOutput {
  type: string;
  /** Bare base64 string on newer backends, or object with b64_json on older. */
  result?: string | { b64_json?: string; revised_prompt?: string };
  b64_json?: string;
  revised_prompt?: string;
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

/**
 * Parse an SSE stream from the Codex Responses endpoint and extract the
 * base64 image data from the `image_generation_call` output.
 */
async function parseSseForImage(response: Response): Promise<ChatGptImageResult | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;

  const decoder = new TextDecoder();
  let buffer = '';
  let imageB64: string | null = null;
  let revisedPrompt: string | null = null;

  // Invariant: the stream may deliver partial chunks that split across SSE
  // event boundaries. We accumulate into `buffer` and process complete lines.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    // Keep the last (possibly incomplete) line in the buffer.
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const dataStr = trimmed.slice(6);
      if (dataStr === '[DONE]') continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(dataStr) as Record<string, unknown>;
      } catch {
        continue;
      }

      const eventType = event['type'] as string | undefined;

      // Extract from response.output_item.done — the primary path for ChatGPT
      // backend models (gpt-6-sol, gpt-4.1, etc.). The image data arrives as:
      //   item.result: string (bare base64) | { b64_json: string }
      //   item.revised_prompt: string
      if (eventType === 'response.output_item.done') {
        const item = event['item'] as Record<string, unknown> | undefined;
        if (item?.['type'] === 'image_generation_call') {
          const result = item['result'];
          // result is a bare base64 string on newer backends, or an object
          // with a b64_json field on older ones.
          if (typeof result === 'string' && result.length > 0) {
            imageB64 = result;
          } else if (result && typeof result === 'object') {
            const resultObj = result as Record<string, unknown>;
            const nested = resultObj['b64_json'];
            if (typeof nested === 'string') imageB64 = nested;
            const nestedRp = resultObj['revised_prompt'];
            if (typeof nestedRp === 'string') revisedPrompt = nestedRp;
          }
          // revised_prompt at item level takes precedence (production format)
          const rp = item['revised_prompt'];
          if (typeof rp === 'string') revisedPrompt = rp;
        }
      }

      // Extract from completed event (some models emit this with inline data)
      if (eventType === 'response.image_generation_call.completed') {
        const b64 = (event['b64_json'] as string) ??
          ((event['result'] as Record<string, unknown> | undefined)?.['b64_json'] as string | undefined);
        if (b64) imageB64 = b64;
        const rp = (event['revised_prompt'] as string) ??
          ((event['result'] as Record<string, unknown> | undefined)?.['revised_prompt'] as string | undefined);
        if (rp) revisedPrompt = rp;
      }

      // Extract from response.completed output array (fallback — some backends
      // populate response.output[] with the full item data)
      if (eventType === 'response.completed') {
        const resp = event['response'] as Record<string, unknown> | undefined;
        const output = (resp?.['output'] ?? event['output']) as ImageGenCallOutput[] | undefined;
        if (Array.isArray(output)) {
          for (const item of output) {
            if (item.type !== 'image_generation_call') continue;
            const r = item.result;
            if (typeof r === 'string' && r.length > 0) {
              imageB64 = r;
            } else if (r && typeof r === 'object') {
              const b64 = r.b64_json ?? item.b64_json;
              if (b64) imageB64 = b64;
              if (r.revised_prompt) revisedPrompt = r.revised_prompt;
            }
            if (typeof item.revised_prompt === 'string') {
              revisedPrompt = item.revised_prompt;
            }
          }
        }
      }
    }
  }

  if (!imageB64) return null;
  return { b64_json: imageB64, revised_prompt: revisedPrompt };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ChatGptImageRequest {
  prompt: string;
  size: string;
  quality: string;
  output_format: string;
  apiKey: string;
  accountId: string;
  signal: AbortSignal;
  fetchFn?: typeof globalThis.fetch;
}

/**
 * Generate an image via the ChatGPT subscription Responses endpoint.
 *
 * Uses a chat model with the `image_generation` tool forced, streaming the
 * response and extracting the base64 image data from the SSE events.
 *
 * @returns The base64 image data and optional revised prompt, or an error string.
 */
export async function generateImageViaChatGpt(
  req: ChatGptImageRequest,
): Promise<ChatGptImageResult | { error: string }> {
  const doFetch = req.fetchFn ?? globalThis.fetch;
  const oauthHeaders = buildChatGptOAuthHeaders(req.accountId);

  const payload = {
    model: CHATGPT_IMAGE_HOST_MODEL,
    store: false,
    stream: true,
    instructions: 'Generate the requested image.',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: req.prompt }],
      },
    ],
    tools: [
      {
        type: 'image_generation',
        quality: req.quality === 'auto' ? 'medium' : req.quality,
        size: req.size,
        output_format: req.output_format,
      },
    ],
    tool_choice: {
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'image_generation' }],
    },
  };

  let response: Response;
  try {
    response = await doFetch(RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${req.apiKey}`,
        'Accept': 'text/event-stream',
        ...oauthHeaders,
        // Invariant: originator must be codex_cli_rs for the backend to accept
        // image generation requests. buildChatGptOAuthHeaders sets 'agent-afk'
        // which works for chat but is rejected for images. Override last.
        'originator': 'codex_cli_rs',
      },
      body: JSON.stringify(payload),
      signal: req.signal,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `ChatGPT image request failed: ${msg}` };
  }

  if (!response.ok) {
    let detail: string;
    try {
      const body = await response.text();
      detail = body.slice(0, 2000);
    } catch {
      detail = `HTTP ${response.status} ${response.statusText}`;
    }
    return { error: `ChatGPT backend returned ${response.status}: ${detail}` };
  }

  const result = await parseSseForImage(response);
  if (!result) {
    return { error: 'ChatGPT backend returned no image data in the SSE stream.' };
  }
  return result;
}
