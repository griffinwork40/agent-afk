/**
 * Cheap-default model resolver for the openai-compatible compaction handler.
 *
 * When `AFK_COMPACT_MODEL` is unset, the anthropic-direct provider defaults to
 * `claude-haiku-4-5-20251001` — a cheap model — rather than the session model.
 * This module provides the equivalent logic for openai-compatible sessions.
 *
 * ## Decision table
 *
 * | Condition                               | Resolved model         |
 * |-----------------------------------------|------------------------|
 * | `AFK_COMPACT_MODEL` is set              | `AFK_COMPACT_MODEL`    |
 * | `baseURL === undefined` (real OpenAI)   | `OPENAI_CHEAP_COMPACT_DEFAULT` |
 * | `authSource === 'chatgpt-oauth'`        | `currentModel`         |
 * | custom baseURL (local / proxy)          | `currentModel`         |
 *
 * **Real OpenAI endpoint:** unset `baseURL` means the SDK connects to
 * `api.openai.com` (the default). That endpoint reliably serves every model in
 * the OpenAI catalogue, including the cheap mini/nano tier, so substituting a
 * cheap default is safe and saves money.
 *
 * **ChatGPT-subscription (chatgpt-oauth):** the ChatGPT subscription backend
 * (`chatgpt.com/backend-api/codex`) has its own model availability — a cheap
 * API model may not be subscribed there. Keep the current model to avoid a
 * guaranteed 404 mid-compaction.
 *
 * **Custom baseURL (local / proxy):** an MLX, llama.cpp, vLLM, ollama, or
 * OpenRouter endpoint may serve only the session model. Substituting a mini
 * model id would likely 404. Keep the current model.
 *
 * ## Choice of default
 *
 * `gpt-4.1-nano` is the cheapest model in the repo's pricing table
 * (`openai-compatible/pricing.ts`, $0.10/$0.40 per MTok), present in
 * `model-capabilities.ts`, and capable of producing a compact session summary
 * (the output is capped at 1,024 tokens, well within any model's ability).
 *
 * @module agent/providers/openai-compatible/query/compact-model-resolver
 */

/**
 * Cheapest-available OpenAI API model for compaction.
 *
 * Chosen from the repo's pricing table (openai-compatible/pricing.ts):
 * `gpt-4.1-nano` at $0.10/$0.40 per MTok is the lowest-cost entry —
 * cheaper than `gpt-4o-mini` ($0.15/$0.60) and `gpt-4.1-mini` ($0.40/$1.60).
 * It is also present in `model-capabilities.ts` (confirmed in the repo catalog)
 * and adequate for generating a 1,024-token session summary.
 */
export const OPENAI_CHEAP_COMPACT_DEFAULT = 'gpt-4.1-nano';

/**
 * Resolve the model to use for openai-compatible compaction.
 *
 * Pure function — no env reads, no side effects. The caller supplies the raw
 * `AFK_COMPACT_MODEL` value, the current session's base URL, the auth source,
 * and the current model as inputs so this function can be tested without
 * manipulating `process.env`.
 *
 * @param compactModelEnv  Raw `env.AFK_COMPACT_MODEL` value (string or undefined).
 * @param baseURL          Session `opts.baseURL` (undefined = real OpenAI).
 * @param authSource       Auth source string from `opts.auth.source`.
 * @param currentModel     The session's live current model id.
 * @returns The model id to use for the compaction summarize call.
 */
export function resolveOpenAICompactModel(
  compactModelEnv: string | undefined,
  baseURL: string | undefined,
  authSource: string,
  currentModel: string,
): string {
  // Explicit override always wins.
  if (compactModelEnv !== undefined && compactModelEnv.length > 0) {
    return compactModelEnv;
  }

  // ChatGPT-subscription backend: model availability is subscription-scoped —
  // a cheap API model may not be available there. Keep the current model.
  if (authSource === 'chatgpt-oauth') {
    return currentModel;
  }

  // Custom base URL: local runner (MLX, llama.cpp, vLLM, ollama) or proxy.
  // These endpoints only know the model the session is already using.
  if (baseURL !== undefined) {
    return currentModel;
  }

  // Default case: real OpenAI API key against api.openai.com.
  // Use the cheapest model in the catalog.
  return OPENAI_CHEAP_COMPACT_DEFAULT;
}
