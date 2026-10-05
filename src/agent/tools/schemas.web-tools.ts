/**
 * Tool schemas for web/network built-ins:
 * send_telegram, web_scrape, web_request, image_generate.
 *
 * Extracted into its own file to satisfy the 350-code-line ratchet on
 * `schemas.ts` (baselined files may shrink, never grow). Imported and
 * re-exported from `schemas.ts` so callers import from the primary module.
 *
 * @module agent/tools/schemas.web-tools
 */

import type { AnthropicToolDef } from './types.js';

export const sendTelegramTool: AnthropicToolDef = {
  name: 'send_telegram',
  category: 'web',
  concurrencySafe: false,
  riskClass: 'caution',
  description:
    'Send a Telegram message to the operator. ' +
    'Use to surface terminal-state notifications, blocking questions, or important status ' +
    'updates when the user is away from keyboard (AFK). The message is delivered through the ' +
    'same Telegram bot the operator uses to drive this session. By default the message goes to ' +
    'your primary chat (the first private chat in `AFK_TELEGRAM_ALLOWED_CHAT_IDS`, or ' +
    '`AFK_TELEGRAM_PRIMARY_CHAT_ID` if set); set `telegram.notify` in afk.config.json to ' +
    'broadcast to all allowed chats or target a custom set.\n\n' +
    'Markdown is rendered as Telegram HTML, with plain-text fallback on formatting errors — Telegram\'s 4096-character limit per message is enforced. ' +
    'Returns an error if Telegram is not configured (missing `TELEGRAM_BOT_TOKEN` or empty ' +
    'allowlist) so the tool is safe to attempt unconditionally.\n\n' +
    'Use sparingly: this is a real push notification to a human. Reserve for terminal states ' +
    '(Done/Blocked/Asking) and material progress, not running commentary. ' +
    'When running inside the Telegram bot, prefer replying normally — your response already ' +
    'reaches the operator through the bot. Use this tool only from CLI or daemon sessions.\n\n' +
    'Optionally set `chat` to route to a SPECIFIC chat instead of the default primary target: ' +
    'pass a numeric chat id (e.g. -1001234567890 for a group) or a chat alias name defined in ' +
    'afk.config.json `telegram.chatAliases` (e.g. "ops"). An explicitly-targeted chat must be ' +
    'in the inbound allowlist (AFK_TELEGRAM_ALLOWED_CHAT_IDS) — a non-allowlisted target is ' +
    'rejected (fail-closed). Omit `chat` for the default behavior (unchanged).\n\n' +
    'For supergroups with topics enabled, set `thread_id` alongside `chat` to send to a ' +
    'specific topic thread.',
  input_schema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description:
          'Plain-text message body to send to the operator. ' +
          'Markdown is rendered as Telegram HTML (bold, italic, code, links); ' +
          'plain-text fallback is used if Telegram rejects the formatting. ' +
          'Max 4096 characters (Telegram API limit). Must be non-empty.',
      },
      chat: {
        type: ['number', 'string'],
        description:
          'Optional. Target a specific chat instead of the default primary target. ' +
          'A number (or numeric string) is a raw Telegram chat id; a non-numeric string is ' +
          'looked up as a name in afk.config.json `telegram.chatAliases`. The resolved chat ' +
          'must be allowlisted (AFK_TELEGRAM_ALLOWED_CHAT_IDS) or the send is rejected. ' +
          'Omit to send to the configured default (primary DM chat / notify targets).',
      },
      thread_id: {
        type: 'number',
        description:
          'Optional. Telegram message_thread_id for sending to a specific topic ' +
          'in a supergroup with topics enabled. Pass the numeric thread/topic ID. ' +
          'Ignored when the target chat is not a supergroup with topics. ' +
          'Requires `chat` to be set explicitly (thread targeting without a chat target is ambiguous).',
      },
    },
    required: ['message'],
  },
};

export const webScrapeTool: AnthropicToolDef = {
  name: 'web_scrape',
  category: 'web',
  concurrencySafe: true,
  description:
    'Scrape a web page or run a web search and return text content suitable ' +
    'for reasoning over. Three modes:\n\n' +
    '- `markdown` (default): fetches the URL and extracts the main content as ' +
    'clean markdown (Readability + Turndown). Handles JS-rendered pages: if the ' +
    'plain fetch yields thin content, it escalates to a headless-browser render ' +
    'and re-extracts. Use this for articles, docs, blog posts, and most "I want ' +
    'to read this page" cases. No API key required (the render fallback needs ' +
    'the Playwright chromium binary; if it is absent the error names the exact ' +
    'install command for this installation).\n' +
    '- `raw`: GETs the URL directly and returns the response body as decoded ' +
    'text, with no markdown transformation. Use for JSON APIs, robots.txt, RSS, ' +
    'or plain-text endpoints. Not byte-preserving — binary payloads are decoded ' +
    'as text, so do not rely on this for exact bytes. No API key required.\n' +
    '- `search`: runs a web search and returns ranked markdown results. Use when ' +
    'you need to FIND a URL, not read one. Provide `query` instead of `url`. ' +
    'Requires `EXA_API_KEY` (free tier at https://exa.ai); ' +
    'the handler returns a clear error if it is unset.\n\n' +
    'Outputs are capped at `max_bytes` UTF-8 bytes (default 100KB, ceiling 1MB); ' +
    'content over the cap is reduced to head+tail with a `… [N bytes truncated: …] …` ' +
    'marker so both ends survive. The request is aborted after `timeout_ms` ' +
    '(default 30000, ceiling 120000).',
  input_schema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['markdown', 'raw', 'search'],
        description: 'Fetch mode. Defaults to "markdown".',
      },
      url: {
        type: 'string',
        description:
          'Absolute http(s) URL. Required for markdown and raw modes. Ignored in search mode.',
      },
      query: {
        type: 'string',
        description: 'Search query string. Required for search mode. Ignored otherwise.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Request timeout in milliseconds (default 30000, clamped to 120000).',
      },
      max_bytes: {
        type: 'number',
        description:
          'Maximum UTF-8 bytes returned. Content beyond this is reduced to head+tail ' +
          'with a truncation marker (both ends preserved). Default 100000, clamped to 1000000.',
      },
    },
    required: [],
  },
};

export const webRequestTool: AnthropicToolDef = {
  name: 'web_request',
  category: 'web',
  concurrencySafe: true,
  description:
    'Make a structured HTTP request with any method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS). ' +
    'Unlike `web_scrape` (GET-only read), `web_request` supports mutating methods and returns a ' +
    'structured `{ status, headers, body, timing_ms }` response. ' +
    'SSRF-guarded: all private/internal IP ranges blocked by default (see AFK_WEB_ALLOW_PRIVATE_HOSTS). ' +
    'Respects AFK_BROWSER_ALLOWED_DOMAINS / BLOCKED_DOMAINS when domain policy is configured.\n\n' +
    'Risk levels: GET/HEAD/OPTIONS = low; POST/PUT/PATCH = medium; DELETE = high. ' +
    'Only idempotent methods (GET, HEAD, OPTIONS, PUT, DELETE) are auto-retried on transient failures; ' +
    'POST and PATCH are NEVER auto-retried.\n\n' +
    'Body is auto-serialized: objects/arrays → JSON with Content-Type: application/json; ' +
    'strings → text/plain. Caller-supplied Content-Type overrides inference.\n\n' +
    'Response body is truncated to `max_response_bytes` (default 100KB, ceiling 1MB). ' +
    'JSON responses are auto-parsed when not truncated.\n\n' +
    'Credential injection: pass `credential: "ENV_VAR_NAME"` to resolve an env var at runtime ' +
    'and inject it as a Bearer token. The raw value is never logged or returned to the model.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Absolute http(s) URL.',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        description: 'HTTP method. GET/HEAD/OPTIONS = low risk; POST/PUT/PATCH = medium; DELETE = high.',
      },
      body: {
        description:
          'Request body. Strings are sent as text/plain; objects/arrays are JSON-serialized ' +
          'with Content-Type: application/json. Ignored for GET, HEAD, OPTIONS.',
      },
      headers: {
        type: 'object',
        description:
          'Request headers as a string-keyed object. Secret values (Authorization, token patterns) ' +
          'are redacted from traces but sent on the wire.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Request timeout in milliseconds (default 30000, clamped to 120000).',
      },
      max_response_bytes: {
        type: 'number',
        description:
          'Maximum response body bytes (default 100000, clamped to 1000000). ' +
          'Content over the cap is truncated head+tail with a marker.',
      },
      credential: {
        type: 'string',
        description:
          'Name of an environment variable whose value is injected as a Bearer token ' +
          '(Authorization: Bearer <value>). Use instead of hardcoding secrets in headers. ' +
          'Returns an error if the env var is not set.',
      },
    },
    required: ['url', 'method'],
  },
};

export const imageGenerateTool: AnthropicToolDef = {
  name: 'image_generate',
  category: 'web',
  concurrencySafe: false,
  riskClass: 'caution',
  description:
    'Generate an image from a text prompt using the OpenAI Images API (GPT Image models). ' +
    'The generated image is saved to disk and the file path is returned. ' +
    'Uses AFK_IMAGE_API_KEY when set (keeps image billing separate from chat completions); ' +
    'falls back to the full OpenAI auth chain (OPENAI_API_KEY, Codex CLI, ChatGPT OAuth). ' +
    'Each generation costs real money via the OpenAI API.\n\n' +
    'By default the image is NOT returned inline in the tool result to avoid consuming ~300K-500K context tokens per image. ' +
    'To inspect the generated image in the same turn, set inspect:true (see below). ' +
    'Otherwise, read the file at the returned path in a follow-up turn.\n\n' +
    'Safety: blocked in daemon/cron sessions unless AFK_IMAGE_ALLOW_DAEMON=1. ' +
    'Per-session generation cap controlled by AFK_IMAGE_SESSION_LIMIT (default 10); ' +
    'with inspect:true each image is substantially more expensive so the cap matters more. ' +
    'Every call is recorded in the effect ledger for audit.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Text description of the image to generate. Be specific about style, composition, colors, and details.',
      },
      model: {
        type: 'string',
        enum: ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2'],
        description: 'Image model to use. gpt-image-1 (default) has strong text rendering; gpt-image-2 is flagship; gpt-image-1-mini is cheapest.',
      },
      size: {
        type: 'string',
        enum: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
        description: 'Image dimensions. Default: 1024x1024. Use 1024x1536 for portrait, 1536x1024 for landscape.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'auto'],
        description: 'Generation quality. Higher quality costs more. Default: auto.',
      },
      output_format: {
        type: 'string',
        enum: ['png', 'webp', 'jpeg'],
        description: 'Output image format. Default: png.',
      },
      output_path: {
        type: 'string',
        description: 'Optional file path to save the image to. When omitted, saves to <cwd>/.afk/generated-images/<id>.<format>.',
      },
      inspect: {
        type: 'boolean',
        description:
          'When true, the generated image is returned inline in ToolResult.image so you can see it in the same turn. ' +
          'WARNING: this consumes ~333K-484K context tokens per image (≈$1-3 extra per call at current rates). ' +
          'Use only for generate→inspect→iterate workflows where same-turn vision feedback is required. ' +
          'Images exceeding 8000px in either dimension or 2 MB base64 are saved to disk only (inspect:true is silently degraded). ' +
          'Default: false.',
      },
    },
    required: ['prompt'],
  },
};

export const imageEditTool: AnthropicToolDef = {
  name: 'image_edit',
  category: 'web',
  concurrencySafe: false,
  riskClass: 'caution',
  description:
    'Edit one or more local images via the OpenAI Images Edit API (`POST /v1/images/edits`). ' +
    'Accepts one or more existing image files on disk as reference images (png, jpg/jpeg, webp, ≤25 MiB each) ' +
    'and a text prompt describing the desired modification. ' +
    'The edited image is saved to disk and the file path is returned.\n\n' +
    'Uses AFK_IMAGE_API_KEY when set (keeps image billing separate from chat completions); ' +
    'falls back to the full OpenAI auth chain (OPENAI_API_KEY, Codex CLI). ' +
    'Each edit costs real money via the OpenAI API.\n\n' +
    'Safety: blocked in daemon/cron sessions unless AFK_IMAGE_ALLOW_DAEMON=1. ' +
    'Per-session edit cap controlled by AFK_IMAGE_SESSION_LIMIT (default 10); ' +
    'edits and generates each maintain their own separate counter (an edit does not consume a generate slot). ' +
    'Every call is recorded in the effect ledger for audit.\n\n' +
    'Reference images: must exist on disk and be readable under the session read-root policy ' +
    '(same path containment rules as read_file). ' +
    'Extension must be .png, .jpg, .jpeg, or .webp. Each file must be ≤ 25 MiB.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Text description of the desired edit. Be specific about what to change, add, or remove.',
      },
      image_paths: {
        type: 'array',
        items: { type: 'string' },
        description:
          'One or more absolute or relative file paths to the reference images. ' +
          'Supported formats: .png, .jpg, .jpeg, .webp. Each file must be ≤ 25 MiB. ' +
          'Paths are resolved against the session read-root policy (same rules as read_file). ' +
          'Maximum 16 images.',
      },
      model: {
        type: 'string',
        enum: ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2'],
        description: 'Image model to use. Default: gpt-image-1.',
      },
      size: {
        type: 'string',
        enum: ['1024x1024', '1024x1536', '1536x1024', 'auto'],
        description: 'Output image dimensions. Default: 1024x1024.',
      },
      quality: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'auto'],
        description: 'Generation quality. Higher quality costs more. Default: auto.',
      },
      output_format: {
        type: 'string',
        enum: ['png', 'webp', 'jpeg'],
        description: 'Output image format. Default: png.',
      },
      output_path: {
        type: 'string',
        description: 'Optional file path to save the edited image to. When omitted, saves to <cwd>/.afk/generated-images/edited-<id>.<format>.',
      },
    },
    required: ['prompt', 'image_paths'],
  },
};
