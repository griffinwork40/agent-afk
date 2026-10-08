/**
 * Actionable error messages for the private ChatGPT/Codex subscription
 * backend (chatgpt.com/backend-api/codex). Extracted verbatim from
 * `query.ts` (OpenAICompatibleQuery.clarifyResponsesError + the Claude-model
 * fail-fast guard) so that file stays under its size ratchet.
 *
 * @module agent/providers/openai-compatible/query/chatgpt-backend-errors
 */

/**
 * Error for a Claude-family model routed to the ChatGPT backend. That backend
 * serves only OpenAI gpt-5.x and rejects other model families with an opaque
 * 400 (no body), so the query fails fast with this instead.
 */
export function chatGptClaudeModelError(model: string): Error {
  return new Error(
    `Model "${model}" can't run on a ChatGPT subscription — the ChatGPT/Codex ` +
      `backend only supports OpenAI gpt-5.x models. This usually means a subagent or skill ` +
      `requested a Claude model. Pass a gpt-5.x model to it (e.g. model: "gpt-5.5"); for an ` +
      `auto-dispatched agent you can't pass a model to (e.g. git-investigator), set ` +
      `AFK_DEFAULT_SUBAGENT_MODEL to a gpt-5.x id. Or run it on a provider configured with ` +
      `the matching API key.`,
  );
}

/**
 * Turn an opaque ChatGPT-backend failure into an actionable message. That
 * backend returns 400 for unsupported models, and the OpenAI SDK often
 * surfaces it as "400 status code (no body)". Only rewrites 400s on the
 * ChatGPT backend; every other error passes through unchanged.
 */
export function clarifyResponsesError(err: unknown, isChatGptBackend: boolean, model: string): Error {
  const e = err instanceof Error ? err : new Error(String(err));
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
  return new Error(
    `ChatGPT/Codex backend rejected model "${model}" (HTTP 400). ` +
      `This is a ChatGPT-subscription backend restriction, not an API-key error. ` +
      `To use models your ChatGPT plan does not serve, set an API key (OPENAI_API_KEY) and ` +
      `route to the standard OpenAI API instead, or pick a model your ChatGPT plan supports. ` +
      (detail ? `Backend said: ${detail}` : `No error body was returned.`),
  );
}
