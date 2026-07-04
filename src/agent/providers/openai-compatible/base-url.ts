/**
 * Effective baseURL resolution for the OpenAI-compatible client.
 *
 * Precedence: per-session `config.openaiBaseUrl` > construction-time
 * `providerOpts.baseURL` > global `AFK_OPENAI_BASE_URL` (normalized) >
 * undefined (→ the OpenAI SDK default `https://api.openai.com/v1`).
 *
 * The env tier is a safety net. A deep child/grandchild session dispatched
 * through the skill / subagent / compose executors inherits a child config that
 * does NOT thread `openaiBaseUrl` (SubagentExecutorContext.defaultConfig is
 * `Pick<AgentConfig,'apiKey'|'systemPrompt'|'baseUrl'>` — no openaiBaseUrl).
 * Without this fallback such a session silently POSTs to api.openai.com and a
 * non-OpenAI key (e.g. an opencode key) is rejected as "Incorrect API key".
 * Reading the env here — not only at config load — makes the endpoint resilient
 * to that gap. A trailing `/chat/completions` is stripped (the SDK appends it);
 * this mirrors `normalizeOpenAIBaseUrl` (cli/config.ts) but is kept local to
 * avoid an agent→cli import cycle, and without the config-time stderr warning.
 *
 * @module agent/providers/openai-compatible/base-url
 */

/**
 * Pick the baseURL to hand the OpenAI SDK, or `undefined` to let it use its
 * own default. See the module docstring for the precedence rationale.
 */
export function resolveEffectiveOpenAIBaseUrl(
  configOpenaiBaseUrl: string | undefined,
  ctorBaseUrl: string | undefined,
  envBaseUrl: string | undefined,
): string | undefined {
  if (configOpenaiBaseUrl !== undefined) return configOpenaiBaseUrl;
  if (ctorBaseUrl !== undefined) return ctorBaseUrl;
  return normalizeEnvBaseUrl(envBaseUrl);
}

/** Trim + drop a redundant trailing `/chat/completions`; empty → undefined. */
function normalizeEnvBaseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const suffix = '/chat/completions';
  return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
}
