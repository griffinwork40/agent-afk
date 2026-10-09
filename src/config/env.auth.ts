/**
 * Auth / external API, system-prompt, and image-generation env vars.
 * A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling.
 * `env.ts` spreads this tuple into `ENV_REGISTRY` at the appropriate position.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.auth
 */

import type { EnvVarMeta } from './env.js';

export const AUTH_ENV_REGISTRY = [
  // ── System prompt ─────────────────────────────────────────────────────────
  {
    name: 'AFK_SYSTEM_PROMPT',
    description: 'Raw operator-overlay prompt. Highest-priority overlay (over afk.config.json and AFK.md). Appended on top of the framework base (system-prompt.md) under an "# Operator configuration" header — it augments, never replaces, the base.',
    type: 'string',
    required: false,
    example: 'You are a helpful agent.',
    category: 'model',
  },
  {
    name: 'AFK_DUMP_PROMPT',
    description: 'Write the resolved system prompt to a file at startup. Accepts a path or 1 for default location.',
    type: 'string',
    required: false,
    example: '/tmp/afk-prompt.txt',
    category: 'debug',
  },

  // ── Auth / external APIs ──────────────────────────────────────────────────
  {
    name: 'ANTHROPIC_API_KEY',
    description: 'Anthropic API key. Tier-1 credential — overrides keychain OAuth and CLAUDE_CODE_OAUTH_TOKEN.',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },
  {
    name: 'CLAUDE_CODE_OAUTH_TOKEN',
    description: 'Claude Code OAuth token. Tier-2 credential — used when ANTHROPIC_API_KEY is unset; falls back to keychain.',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },
  {
    name: 'OPENAI_API_KEY',
    description: 'OpenAI API key for the openai-compatible provider (gpt-*, o1*, o3*, o4* models).',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },
  {
    name: 'CODEX_API_KEY',
    description: 'Fallback OpenAI API key for the openai-compatible provider, read after OPENAI_API_KEY. Legacy name from the removed @openai/codex-sdk integration — prefer OPENAI_API_KEY.',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },
  {
    name: 'XAI_API_KEY',
    description: 'xAI API key for the xai provider (Grok models) in API-key mode. Metered; distinct from SuperGrok / SuperGrok Heavy / X Premium+ OAuth.',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },
  {
    name: 'AFK_XAI_BASE_URL',
    description: 'Base URL for xAI API-key mode. Default https://api.x.ai/v1. The OpenAI SDK appends /chat/completions.',
    type: 'string',
    required: false,
    example: 'https://api.x.ai/v1',
    category: 'model',
  },
  {
    name: 'AFK_XAI_OAUTH_BASE_URL',
    description: 'Base URL for xAI SuperGrok / SuperGrok Heavy / X Premium+ OAuth inference. Default https://cli-chat-proxy.grok.com/v1 (subscription path). Some accounts work on https://api.x.ai/v1 with OAuth — override if needed. Distinct from AFK_XAI_BASE_URL (API-key mode).',
    type: 'string',
    required: false,
    example: 'https://cli-chat-proxy.grok.com/v1',
    category: 'model',
  },
  {
    name: 'AFK_XAI_GROK_CLIENT_VERSION',
    description: 'Override the semver sent as x-grok-client-version to the xAI OAuth CLI chat proxy. Use only if the proxy raises its required Grok CLI version before agent-afk is updated; invalid values fall back to the official Grok Build version file or built-in compatible default.',
    type: 'string',
    required: false,
    example: '1.0.6',
    category: 'model',
  },
  {
    name: 'AFK_LOCAL_API_KEY',
    description: 'Placeholder API key for local Anthropic-compatible servers (vllm-mlx, etc.). Set when AFK_LOCAL_BASE_URL is configured.',
    type: 'string',
    required: false,
    default: 'local',
    example: 'local',
    category: 'auth',
    secret: true,
  },
  {
    name: 'AFK_LOCAL_BASE_URL',
    description: 'Base URL for a self-hosted Anthropic-compatible server. When set, routes traffic away from api.anthropic.com.',
    type: 'string',
    required: false,
    example: 'http://127.0.0.1:8080',
    category: 'model',
  },
  {
    name: 'OPENAI_BASE_URL',
    description: 'Standard OpenAI SDK base URL override. When set without AFK_OPENAI_BASE_URL, the OpenAI SDK routes the client to this endpoint while AFK\'s own baseURL option remains undefined. AFK reads this variable to correctly classify the effective endpoint for decisions such as compaction model selection — without it, AFK would see an undefined baseURL and incorrectly treat the session as targeting api.openai.com.',
    type: 'string',
    required: false,
    example: 'http://127.0.0.1:8000/v1',
    category: 'model',
  },
  {
    name: 'AFK_OPENAI_BASE_URL',
    description: 'Base URL override for the OpenAI-compatible provider. Used for local shims (mlx_lm.server, Ollama, vLLM, LM Studio). The OpenAI SDK appends `/chat/completions` itself — a value ending in `/chat/completions` will be stripped at config-load time with a one-shot warning.',
    type: 'string',
    required: false,
    example: 'http://127.0.0.1:8000/v1',
    category: 'model',
  },
  {
    name: 'AFK_OPENAI_USE_RESPONSES',
    description: 'Opt the OpenAI-compatible provider into the OpenAI Responses API instead of Chat Completions for API-key sessions. Truthy values: 1, true, yes, on. The ChatGPT-subscription OAuth path uses Responses automatically regardless of this flag.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'model',
  },
  {
    name: 'AFK_OPENAI_CHATGPT_OAUTH',
    description: 'Controls the tier-4 ChatGPT-subscription OAuth fallback in the openai-compatible auth chain. Unset or empty/whitespace = enabled (default). Truthy (1, true, yes, on) = explicitly enabled. Any other non-empty value (0, false, off, disabled, or a typo like "fasle") = disabled (fail-closed). Set to 0 or false to prevent AFK from automatically using a ~/.codex/auth.json ChatGPT-subscription token when no API key is configured.',
    type: 'string',
    required: false,
    example: '0',
    category: 'auth',
  },
  {
    name: 'AFK_PROVIDER',
    description: 'Force provider selection (anthropic | anthropic-direct | openai | openai-compatible | openai-codex | xai | xai-oauth). Overrides the model-name heuristic. Same surface as the --provider CLI flag; CLI flag wins when both are set.',
    type: 'string',
    required: false,
    example: 'openai-compatible',
    category: 'model',
  },
  {
    name: 'EXA_API_KEY',
    description: 'Exa (exa.ai) search API key, enabling web_scrape search mode. Free tier (20k requests/month) available at https://exa.ai. When unset, search mode returns an actionable error; markdown and raw modes are unaffected.',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },

  // ── Image generation ─────────────────────────────────────────────────────
  {
    name: 'AFK_IMAGE_API_KEY',
    description: 'Dedicated OpenAI API key for the image_generate tool. Checked before OPENAI_API_KEY to keep image billing separate from chat completions. When unset, OPENAI_API_KEY is used as a fallback. Get a key from https://platform.openai.com/api-keys.',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },
  {
    name: 'AFK_IMAGE_SESSION_LIMIT',
    description: 'Maximum number of images the image_generate tool may produce per session. Prevents runaway spend in autonomous loops. Default: 10.',
    type: 'string',
    required: false,
    category: 'misc',
  },
  {
    name: 'AFK_IMAGE_ALLOW_DAEMON',
    description: 'Set to "1" to allow image_generate in daemon/cron sessions. Blocked by default to prevent unattended API spend.',
    type: 'string',
    required: false,
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
