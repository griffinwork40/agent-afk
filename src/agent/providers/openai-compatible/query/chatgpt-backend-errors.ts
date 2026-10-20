/**
 * Actionable error messages for the private ChatGPT/Codex subscription
 * backend (chatgpt.com/backend-api/codex). Extracted verbatim from
 * `query.ts` (OpenAICompatibleQuery.clarifyResponsesError + the Claude-model
 * fail-fast guard) so that file stays under its size ratchet.
 *
 * @module agent/providers/openai-compatible/query/chatgpt-backend-errors
 */

import { ensureError } from '../../../../utils/errors.js';
import { ModelRejectedError } from '../../shared/model-rejected-error.js';

/**
 * Error for a Claude-family model routed to the ChatGPT backend. That backend
 * serves only OpenAI gpt-5.x and rejects other model families with an opaque
 * 400 (no body), so the query fails fast with this instead.
 */
export function chatGptClaudeModelError(model: string): Error {
  return new ModelRejectedError(
    `Model "${model}" can't run on a ChatGPT subscription — the ChatGPT/Codex ` +
      `backend only supports OpenAI gpt-5.x models. This usually means a subagent or skill ` +
      `requested a Claude model. Pass a gpt-5.x model to it (e.g. model: "gpt-5.5"); for an ` +
      `auto-dispatched agent you can't pass a model to (e.g. git-investigator), set ` +
      `AFK_DEFAULT_SUBAGENT_MODEL to a gpt-5.x id. Or run it on a provider configured with ` +
      `the matching API key.`,
    model,
    undefined,
    'openai-compatible',
  );
}

/**
 * Turn an opaque ChatGPT-backend failure into an actionable message. That
 * backend returns 400 for unsupported models, and the OpenAI SDK often
 * surfaces it as "400 status code (no body)". Only rewrites 400s on the
 * ChatGPT backend; every other error passes through unchanged.
 */
export function clarifyResponsesError(err: unknown, isChatGptBackend: boolean, model: string): Error {
  const e = ensureError(err);
  if (!isChatGptBackend) return e;
  const status =
    err && typeof err === 'object' && 'status' in err
      ? (err as { status?: number }).status
      : undefined;
  if (status !== 400 && !/\b400\b/.test(e.message)) return e;
  let detail: string | undefined;
  const inner = (err as { error?: unknown } | null)?.error;
  if (inner && typeof inner === 'object') {
    const d = inner as { detail?: unknown; message?: unknown };
    if (typeof d.detail === 'string') detail = d.detail;
    else if (typeof d.message === 'string') detail = d.message;
  }
  // Contract: only a body-less 400 (the backend's documented response to an
  // unsupported model) or a body that is ABOUT THE MODEL is typed as a
  // ModelRejectedError — the signal the subagent default-tier fallback keys
  // on. A 400 with any other body (context length, tool schema, ...) keeps
  // the generic actionable message and is never fallback-eligible.
  const aboutModel = detail === undefined || (/\bmodel\b/i.test(detail) || detail.includes(model));
  const message =
    `ChatGPT/Codex backend rejected model "${model}" (HTTP 400). ` +
    `This is a ChatGPT-subscription backend restriction, not an API-key error. ` +
    `To use models your ChatGPT plan does not serve, set an API key (OPENAI_API_KEY) and ` +
    `route to the standard OpenAI API instead, or pick a model your ChatGPT plan supports. ` +
    (detail ? `Backend said: ${detail}` : `No error body was returned.`);
  if (!aboutModel) return new Error(`ChatGPT/Codex backend returned HTTP 400 for model "${model}". Backend said: ${detail ?? ''}`, { cause: err });
  return new ModelRejectedError(message, model, 400, 'openai-compatible', { cause: err });
}
