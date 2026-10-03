/**
 * Model-tier, timeout, suggestion, and legacy-alias env vars. A contiguous
 * slice of `ENV_REGISTRY` (the second half of the model/agent-runtime section).
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling.
 * `env.ts` spreads this tuple into `ENV_REGISTRY` at the appropriate position.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.model-tiers
 */

import type { EnvVarMeta } from './env.js';

export const MODEL_TIERS_ENV_REGISTRY = [
  {
    name: 'AFK_MODEL',
    description: 'Default model for agent turns. Accepts slot names (local, small, medium, large), fixed-identity aliases (opus, sonnet, haiku, fable), or full model IDs. Migration: AFK_MODEL=sonnet now pins the fixed Sonnet identity rather than following a rebound medium tier.',
    type: 'string',
    required: false,
    default: 'medium',
    example: 'claude-opus-5-5',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_TTFB_TIMEOUT_MS',
    description:
      'Per-ROUND time-to-first-token budget (ms) for the anthropic-direct streaming loop. ' +
      'Bounds how long a round may stall BEFORE its first streamed CONTENT token ' +
      '(a text/thinking delta or tool_use); the connection-level message_start and keep-alive ' +
      'pings do NOT count. Once a content token streams, the timer is cleared and the rest of ' +
      'the response is governed instead by the progress-aware AFK_MODEL_STALL_TIMEOUT_MS window, ' +
      'so a normal slow call (below the bound) and any actively-' +
      'streaming extended-thinking response are never aborted. The budget ' +
      'is divided into 3 shorter first-byte ATTEMPTS (each ~2/3 of this value, so the ' +
      'worst-case wall time per round is unchanged from the previous 2-attempt regime while a ' +
      'transient stall gets 3 chances instead of 2). NOTE: a request whose FIRST token takes ' +
      'longer than the per-attempt bound — e.g. a very large opus_1m prefill — is aborted and ' +
      're-driven, then surfaces as an error once the budget is spent (raise this value or set 0 ' +
      'for such workloads); this trims the degrading-call tail instead of a silent ~10-min hang ' +
      'on the SDK default. Default 180000 (180s ≈ 2× the measured p99 ttfb), i.e. 3 × 120s. ' +
      'Set to 0 to disable.',
    type: 'number',
    required: false,
    default: '180000',
    example: '120000',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_STALL_TIMEOUT_MS',
    description:
      'Progress-aware POST-first-byte stall window (ms) for the anthropic-direct streaming loop. ' +
      'Bounds how long a stream that has ALREADY produced content may then go completely silent. ' +
      'Every streamed output event resets the window, so this is NOT a total-round cap: a ' +
      'legitimately long, actively-streaming round (large code emission, extended thinking) ' +
      'survives indefinitely, while a stream wedged mid-flight is aborted and surfaces as a real ' +
      'terminal error instead of hanging. Complements AFK_MODEL_TTFB_TIMEOUT_MS, which governs ' +
      'only the window BEFORE the first token; this one takes over after it. Default 1200000 ' +
      '(20min) — above the 18.5min maximum post-first-byte stream duration observed across 86,076 ' +
      'rounds in 12,381 local traces (p99 122s, p99.9 234s), so no healthy round trips it. ' +
      'Set to 0 to disable (issue #762).',
    type: 'number',
    required: false,
    default: '1200000',
    example: '600000',
    category: 'model',
  },
  {
    name: 'AFK_SUBAGENT_TIMEOUT_MS',
    description:
      'Foreground forked-subagent wall-clock budget in ms; 0 disables the cap; explicit ' +
      'per-fork config.timeoutMs and the 60-min background mode still win. Bounds how long a ' +
      'single forked child turn may run before `withTimeout` aborts its controller (cascading ' +
      'through the AbortGraph to descendants) and the parent receives a legible TimeoutError ' +
      'tool_result instead of hanging. Default 2700000 (45 min ≈ headroom over the longest ' +
      'healthy review/research agent observed in production). Unset, empty, or unparseable input ' +
      'falls back to the default; a negative value is treated as invalid and also falls back. ' +
      'Set to 0 to opt a whole session back into unbounded child turns. Does NOT affect the ' +
      'background dispatch budget (SUBAGENT_BACKGROUND_TIMEOUT_MS) or a per-fork ' +
      'config.timeoutMs — both take precedence.',
    type: 'number',
    required: false,
    default: '2700000',
    example: '3600000',
    category: 'model',
  },
  {
    name: 'AFK_SUBAGENT_AUTO_RESUME_ON_USAGE_LIMIT',
    description:
      'When set to 1/true, forked sub-agents that hit an OAuth usage-limit 429 will park and ' +
      'wait (up to 2 hours) for a keychain account hot-swap before surfacing the error — the ' +
      'same behaviour as top-level interactive sessions. When false (the default), forks fail ' +
      'fast so the parent session can decide how to recover. Ignored for daemon-surface ' +
      'sessions, because no human can switch accounts there. Callers may override per-fork via ' +
      'config.autoResumeOnUsageLimit; an explicit value always wins over this env var.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'model',
  },
  {
    name: 'AFK_SUBAGENT_IDLE_TIMEOUT_MS',
    description:
      'Forked-subagent progress-aware idle-watchdog window in ms; 0 disables the watchdog; an ' +
      'explicit per-fork config.idleTimeoutMs still wins. Fires when a forked child produces no ' +
      'observable output event for this window, aborting the same controller the wall-clock ' +
      'timeout targets so partial output is preserved and the run classifies as a failure. This ' +
      'is distinct from AFK_SUBAGENT_TIMEOUT_MS, the blunt wall-clock that bounds total turn ' +
      'time: the idle watchdog is the tighter first-to-fire bound and never fires while the ' +
      'stream is legitimately parked on a provider-communicated backoff (OAuth pause, or a ' +
      'rate-limit event carrying a retry-after), extending the deadline for the pause window ' +
      'instead. Default 480000 (8 min) clears the worst-case transient-429 backoff the watchdog ' +
      'is currently blind to (about 363s) with roughly 2 min of margin, while staying ' +
      'materially tighter than the 45-min wall-clock. Unset, empty, or unparseable input falls ' +
      'back to the default; a negative value is treated as invalid and also falls back. Set to 0 ' +
      'to disable the idle watchdog for a whole session (the wall-clock still applies). v1 ' +
      'applies to forked sub-agent turns only, not top-level or daemon sessions.',
    type: 'number',
    required: false,
    default: '480000',
    example: '300000',
    category: 'model',
  },
  {
    name: 'AFK_VISION_MODELS',
    description: 'Comma-separated override for image (vision) capability detection on the openai-compatible provider. Each token force-enables a model id by exact or substring match (e.g. "qwen2.5-vl" matches a local VL id); prefix a token with "!" to force-disable. Use to send images to a local vision-language model AFK does not recognise by name, or to blacklist a mis-detected id. Built-in detection already covers gpt-4o/4.1/5.x, o1/o3/o4-mini, Claude, and common VL families.',
    type: 'string',
    required: false,
    example: 'qwen2.5-vl,!gpt-4o-mini',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_LOCAL',
    description: 'Bind the "local" capability tier (cheapest/fastest, user-configured) to a model id. Overrides afk.config.json models.local. Point at a local Ollama, LM Studio, or any OpenAI-compatible shim.',
    type: 'string',
    required: false,
    example: 'llama3.2:3b',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_LOCAL_API_KEY',
    description: 'Per-slot API key for the "local" tier. Overrides global credentials for this tier only.',
    type: 'string',
    required: false,
    category: 'model',
    secret: true,
  },
  {
    name: 'AFK_MODEL_LOCAL_BASE_URL',
    description: 'Per-slot endpoint base URL for the "local" tier. Anthropic Messages base or OpenAI-compatible base per the tier provider.',
    type: 'string',
    required: false,
    example: 'http://localhost:11434/v1',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_LARGE',
    description: 'Bind the "large" capability tier (most capable) to a model id/alias. Overrides afk.config.json models.large.',
    type: 'string',
    required: false,
    example: 'claude-opus-5-5',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_LARGE_API_KEY',
    description: 'Per-slot API key for the "large" tier (Stage 2). Overrides global credentials for this tier only.',
    type: 'string',
    required: false,
    category: 'model',
    secret: true,
  },
  {
    name: 'AFK_MODEL_LARGE_BASE_URL',
    description: 'Per-slot endpoint base URL for the "large" tier (Stage 2). Anthropic Messages base or OpenAI-compatible base per the tier provider.',
    type: 'string',
    required: false,
    example: 'http://localhost:8080/v1',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_MEDIUM',
    description: 'Bind the "medium" capability tier (general-use) to a model id/alias. Overrides afk.config.json models.medium.',
    type: 'string',
    required: false,
    example: 'claude-sonnet-5',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_MEDIUM_API_KEY',
    description: 'Per-slot API key for the "medium" tier (Stage 2). Overrides global credentials for this tier only.',
    type: 'string',
    required: false,
    category: 'model',
    secret: true,
  },
  {
    name: 'AFK_MODEL_MEDIUM_BASE_URL',
    description: 'Per-slot endpoint base URL for the "medium" tier (Stage 2). Anthropic Messages base or OpenAI-compatible base per the tier provider.',
    type: 'string',
    required: false,
    example: 'http://localhost:8080/v1',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_SMALL',
    description: 'Bind the "small" capability tier (cheap/fast) to a model id/alias. Overrides afk.config.json models.small.',
    type: 'string',
    required: false,
    example: 'gpt-4o-mini',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_SMALL_API_KEY',
    description: 'Per-slot API key for the "small" tier (Stage 2). Overrides global credentials for this tier only.',
    type: 'string',
    required: false,
    category: 'model',
    secret: true,
  },
  {
    name: 'AFK_MODEL_SMALL_BASE_URL',
    description: 'Per-slot endpoint base URL for the "small" tier (Stage 2). Anthropic Messages base or OpenAI-compatible base per the tier provider.',
    type: 'string',
    required: false,
    example: 'http://localhost:8080/v1',
    category: 'model',
  },
  {
    name: 'AFK_OVERLOAD_PAUSE_MS',
    description: 'Wall-clock ceiling (ms) for the bounded pause after a mid-stream overload (529) exhausts its retry budget. Overrides the per-surface default for ALL surfaces: 0 disables the pause (fail fast). Interactive surfaces (cli/repl/telegram) default to 600000; daemon/cron default to 0 so an always-on runner never silently parks on upstream capacity.',
    type: 'number',
    required: false,
    example: '600000',
    category: 'model',
  },
  {
    name: 'AFK_PROMPT_CACHE_TTL',
    description: 'TTL for Anthropic prompt-cache blocks. Accepts 5m or 1h.',
    type: 'string',
    required: false,
    default: '1h',
    example: '1h',
    category: 'model',
  },
  {
    name: 'AFK_SUGGEST_ENABLED',
    description: 'Enable the LLM-backed ghost-text suggestion tier in the interactive REPL. On by default. Set to 0/false/no/off to disable.',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'model',
  },
  {
    name: 'AFK_SUGGEST_PROMPT',
    description: 'Enable LLM-generated empty-prompt suggestions — a proposed next action shown as ghost text when the prompt is blank, accepted with Tab or Right-arrow. Fires only after a turn has completed in the session: the startup prompt (and the prompt right after /clear) is left clean because there is no session context to ground a proposal in. On by default. Set to 0/false/no/off to disable. Requires AFK_SUGGEST_ENABLED (it reuses the same suggestion model and provider).',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'model',
  },
  {
    name: 'AFK_SUGGEST_GHOST',
    description: 'Enable REPL ghost-text inline suggestions (Tier-1 history/dropdown + optional Tier-2 LLM). 1 = on (default), 0 = off. Set 0/false/off/no to disable all ghost text. Tier-2 LLM is separately gated by AFK_SUGGEST_ENABLED.',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'model',
  },
  {
    name: 'AFK_SUGGEST_MODEL',
    description: 'Override the small model used for REPL ghost-text suggestions. Falls back to AFK_COMPACT_MODEL or haiku-class for anthropic, or the session model for other providers.',
    type: 'string',
    required: false,
    category: 'model',
  },
  {
    name: 'AFK_TASK_BUDGET',
    description: 'Per-task token budget ceiling. Aborts when cumulative usage would exceed it.',
    type: 'number',
    required: false,
    default: '100000',
    example: '200000',
    category: 'model',
  },
  {
    name: 'AFK_TEMPERATURE',
    description: 'Numeric temperature override for model sampling. Provider default if unset.',
    type: 'number',
    required: false,
    example: '0.7',
    category: 'model',
  },
  {
    name: 'AFK_THINKING',
    description: 'Extended-thinking mode. Accepts adaptive | disabled | max | enabled:<N> | enabled:max. Defaults to the model-appropriate mode when unset (adaptive on current models).',
    type: 'string',
    required: false,
    default: 'adaptive',
    example: 'adaptive',
    category: 'model',
  },
  {
    name: 'AFK_THINKING_UI',
    description:
      'Default thinking-display mode for the interactive REPL: summary | live | digest | off. ' +
      'Display-only — controls how extended-thinking blocks render, never whether thinking runs (cost/latency unaffected). ' +
      'Overridden per-launch by --thinking-ui and mutable mid-session via /thinking. ' +
      'Precedence: --thinking-ui flag > this env > interactive.thinkingUi config > live. Invalid values are ignored.',
    type: 'string',
    required: false,
    default: 'live',
    example: 'digest',
    category: 'misc',
  },
  {
    name: 'AFK_TIMEOUT_MS',
    description: 'Per-turn timeout in milliseconds. Provider/SDK default if unset.',
    type: 'number',
    required: false,
    example: '120000',
    category: 'model',
  },
  {
    name: 'AFK_WORKSPACE_DISABLED',
    description:
      'Disable the shared agent workspace (WorkspaceStore + workspace_publish/workspace_query ' +
      'tools + preamble injection). When set to 1, subagents do not get workspace tools ' +
      'and no workspace preamble is injected at fork time — each agent works in full ' +
      'isolation as before v5.133. Used as the control arm of the file-read deduplication ' +
      'A/B experiment. Default: workspace enabled (unset or 0).',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'model',
  },
  {
    name: 'CLAUDE_MODEL',
    description: 'Legacy alias for AFK_MODEL — supported for back-compat with pre-AFK_* deployments.',
    type: 'string',
    required: false,
    example: 'sonnet',
    category: 'model',
  },
] as const satisfies readonly EnvVarMeta[];
