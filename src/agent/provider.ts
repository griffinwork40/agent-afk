/**
 * Model provider abstraction.
 *
 * Decouples `AgentSession` from any single model SDK. A provider owns a
 * single backend session (an Anthropic Claude Agent SDK query, an OpenAI
 * Codex thread, etc.) and translates its native event stream into the
 * harness-native {@link ProviderEvent} shape. The shared stream consumer
 * (`src/agent/session/stream-consumer.ts`) only understands these normalized
 * events — the Anthropic Zod schemas, the Codex `ThreadEvent` union, etc.
 * are entirely internal to each adapter.
 *
 * Two bundled providers live under `src/agent/providers/`:
 *   - `anthropic-direct/` — wraps `@anthropic-ai/sdk` Messages API (default).
 *   - `openai-compatible/` — wraps the official `openai` npm package and
 *     supports any OpenAI-compatible endpoint via `baseURL`.
 *
 * Selection is model-based by default (see `resolveProvider`). A caller
 * may still inject a fully custom `ModelProvider` via `AgentConfig.provider`.
 *
 * @module agent/provider
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { AgentConfig } from './types/config-types.js';

/**
 * Normalized session identity emitted on the synthetic `session.init` event.
 *
 * Fields that the underlying provider does not surface are optional; the
 * consumer merges them onto {@link SessionMetadata} as-is.
 */
export interface ProviderSessionInfo {
  sessionId: string;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  tools?: string[];
  slashCommands?: string[];
  skills?: string[];
  plugins?: Array<{ name: string; path: string }>;
  mcpServers?: Array<{ name: string; status: string }>;
  apiKeySource?: string;
  /** Provider version string (e.g. `claude_code_version`, codex CLI version). */
  version?: string;
  outputStyle?: string;
}

/**
 * Normalized token / cost usage for a single completed turn.
 *
 * Providers that don't surface a particular field leave it undefined. The
 * `raw` escape hatch carries the provider's full usage object for callers
 * that want provider-specific extensions.
 */
export interface ProviderUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * The model's context-window occupancy after the MOST RECENT model call of
   * the turn (the last tool-loop round) — i.e. "how full is the window right
   * now", used for the context-usage % and auto-compaction.
   *
   * Distinct from `inputTokens`/`outputTokens`, which `sumProviderUsage`
   * accumulates CUMULATIVELY across rounds (billing). The footprint is a
   * single-round measurement and must NOT be summed: each round re-sends the
   * whole prior conversation as `cache_read`, so adding cumulative input on
   * top of the latest `cache_read` double-counts everything already cached.
   *
   * Computed per-provider because the cache accounting differs:
   *   - Anthropic: `input_tokens` EXCLUDES cache (docs: "tokens which were not
   *     read from or used to create a cache"), so
   *     footprint = input + cache_read + cache_creation + output.
   *   - OpenAI-compatible: `prompt_tokens` already INCLUDES cached tokens
   *     (`cached_tokens` is a subset), so footprint = prompt + completion
   *     (= input + output); adding cache would double-count.
   *
   * Optional: consumers fall back to `computeUsedTokens` (input + output) when
   * a provider has not populated it.
   */
  contextWindowTokens?: number;
  totalCostUsd?: number;
  stopReason?: string | null;
  durationMs?: number;
  durationApiMs?: number;
  isError?: boolean;
  resultSubtype?: string;
  modelUsage?: Record<string, unknown>;
  permissionDenials?: unknown[];
  errors?: string[];
  raw?: Record<string, unknown>;
}

/** Provider-native progress event (long subagent / tool run summaries). */
export interface ProviderProgress {
  taskId: string;
  description: string;
  summary?: string;
  lastToolName?: string;
  totalTokens: number;
  toolUses: number;
  durationMs: number;
}

/** Harness-native event lane emitted by every `ProviderQuery`. */
export type ProviderEvent =
  | { type: 'session.init'; info: ProviderSessionInfo }
  | {
      type: 'session.status';
      sessionId: string;
      status?: string | null;
      permissionMode?: string;
    }
  | { type: 'delta.text'; text: string; sessionId?: string }
  | { type: 'delta.reasoning'; text: string; sessionId?: string }
  | { type: 'assistant.message'; text: string; sessionId?: string }
  | {
      type: 'tool.use.start';
      toolUseId: string;
      toolName: string;
      toolInput: string;
      /** Raw JSON-serialized tool input object — used by facet derivation for exact field extraction. */
      toolInputRaw?: string;
      sessionId?: string;
    }
  | {
      type: 'tool.use';
      summary: string;
      toolUseIds?: string[];
      sessionId?: string;
    }
  | {
      type: 'tool.output';
      toolUseId: string;
      content: string;
      isError?: boolean;
      /**
       * Plumbed from `ToolResult.truncated` — `true` when the handler hit
       * its output-byte cap and forcibly truncated the buffer (e.g. bash's
       * 100KB SIGKILL path or post-close slice). Distinct from `isError`:
       * an overflowed command may still have exited 0. Consumers
       * (subagent traces, hooks) that need to distinguish "got 100KB of
       * legitimate output" from "got 100KB then killed" read this field
       * rather than substring-scanning `content` for the `[output
       * truncated …]` sentinel.
       */
      truncated?: boolean;
      sessionId?: string;
      /**
       * Originating tool name. Used by `buildToolOutputEvent` to look up
       * per-tool display formatters in `src/agent/tools/render-registry.ts`,
       * and available to hooks/metrics/logging. Optional because not every
       * provider can supply it (the OpenAI Codex adapter synthesizes some
       * `tool.output` events from raw SDK item shapes that don't carry the
       * tool name); when absent, the renderer falls back to its existing
       * preview path.
       */
      toolName?: string;
      /**
       * Concurrency-batch membership, plumbed from `ToolResult.batchIndex` /
       * `.batchSize` (set by the dispatcher's `executeBatch`). `batchSize > 1`
       * means this call ran in a parallel wave; `=== 1` (or absent) means it
       * ran alone. The interactive tool-lane reads these to badge a parallel
       * wave distinctly from back-to-back sequential dispatch. Optional: absent
       * on the single-tool `execute()` path and on providers that don't batch.
       */
      batchIndex?: number;
      batchSize?: number;
    }
  | {
      /**
       * Sidecar render-only event for file-mutation tools. Emitted by the
       * provider loop AFTER the corresponding `tool.output` event, keyed by
       * `toolUseId`. Carries a structured diff that the CLI / Telegram /
       * JSON-output surfaces can render without parsing strings — and that
       * provably cannot leak into the model's `tool_result` content because
       * it travels on a separate event.
       *
       * Consumers correlate by `toolUseId`. Late arrival (after the result
       * has been rendered) is supported — renderers either attach
       * post-hoc to the existing entry or drop the event silently.
       */
      type: 'tool.diff';
      toolUseId: string;
      diff: import('../utils/diff.js').DiffPayload;
      sessionId?: string;
    }
  | {
      type: 'turn.completed';
      usage: ProviderUsage;
      sessionId?: string;
    }
  | { type: 'progress'; progress: ProviderProgress; sessionId?: string }
  | { type: 'suggestion'; suggestion: string; sessionId?: string }
  | {
      /**
       * Mid-stream retry signal. Emitted by the anthropic-direct loop when a
       * transient overload (529 / overloaded_error) arrives DURING stream
       * consumption and the same request is about to be re-driven from
       * scratch. The current round's already-streamed text WILL be re-emitted
       * on the retry, so surfaces that accumulate streamed deltas should
       * discard the current round's uncommitted text on this event to avoid
       * visible duplication. Text already flushed to an append-only surface
       * (CLI scrollback past a block boundary) cannot be un-emitted and
       * remains. Per-round (not per-turn): only the in-flight round re-streams;
       * prior committed tool rounds do not.
       */
      type: 'stream.retry';
      sessionId?: string;
    }
  | {
      /**
       * Live rate-limit / backoff signal. Emitted when the Anthropic provider
       * is throttled (HTTP 429/503/529 with a `retry-after` header) and the
       * SDK is about to sleep-and-retry INSIDE a single `messages.create`
       * call. Because that backoff happens deep inside the wrapped `fetch`
       * (see `providers/anthropic-direct/tracing-fetch.ts`), the per-turn loop
       * is blocked awaiting the SDK and yields nothing — so a healthy session
       * waiting out a 70s `retry-after` (retried twice ≈ 140s) looks frozen.
       * This event is pushed out-of-band from the fetch throttle callback into
       * the loop's yield stream so the UI can surface a live
       * `rate-limited · retrying in ~70s` banner during the wait; the normal
       * activity resumes once the retried request streams.
       *
       * Distinct from `stream.retry` (a MID-stream 529 re-drive that discards
       * partial text) — this is a CONNECTION-phase throttle observed from
       * inside fetch, and it does NOT invalidate any already-streamed text. It
       * is purely observational: the SDK still owns the retry policy and
       * timing (this feature does not change either). Consumers that don't
       * render a live banner may ignore it. `retryAfterMs` is the parsed
       * `retry-after` value when present; `status` is the throttled HTTP
       * status; `attempt` is the 1-based throttle count within the call when
       * the emitter can supply it.
       */
      type: 'rate_limit';
      sessionId: string;
      retryAfterMs?: number;
      status?: number;
      attempt?: number;
    }
  | { type: 'error'; error: Error }
  | {
      type: 'paused';
      reason: 'usage-limit';
      resetsAt?: Date;
      accountId?: string;
      /**
       * Whether the provider will automatically wait for the limit to reset
       * (or a keychain hot-swap) and replay the turn. When false, the next
       * event is an `error` and the user must retry manually. Surfaces to
       * the UI layer so the "Usage paused" panel can show truthful copy
       * (auto-resume → "no need to retype"; manual → "send the message again").
       */
      autoResume?: boolean;
    }
  | {
      type: 'resumed';
      hotSwapped: boolean;
      accountId?: string;
    };

/** Harness-native user input. Provider adapters translate this to the native input shape. */
export interface ProviderUserTurn {
  /**
   * User message payload. Strings cover the default text path; Anthropic
   * content-block arrays ride through for image paste (Ctrl+V) without a
   * tool-call round-trip. Non-Anthropic providers that cannot accept blocks
   * must stringify or reject array content at the adapter boundary.
   */
  content: string | ContentBlockParam[];
  /** Associated harness session id, when known. */
  sessionId?: string;
}

/**
 * Arguments passed to {@link ModelProvider.query}.
 *
 * Providers receive the full harness {@link AgentConfig} and build their own
 * native options internally. The shared `buildQueryOptions` helper still
 * lives in `src/agent/session/query-options.ts` and is used by the Anthropic
 * adapter; Codex-only adapters build their own TypeScript config objects.
 */
export interface ProviderQueryArgs {
  prompt: AsyncIterable<ProviderUserTurn>;
  config: AgentConfig;
}

/**
 * Provider-side session handle.
 *
 * Mirrors the imperative methods `AgentSession` calls on its underlying
 * backend plus the async-iterable lane of translated {@link ProviderEvent}s.
 * Methods a particular provider does not natively support should resolve
 * with an empty list / no-op rather than throw, so the harness stays
 * provider-agnostic.
 *
 * Methods here intentionally use plain strings for model ids / permission
 * modes so providers can accept their own native identifiers without the
 * harness having to widen a Claude-specific union.
 */
export interface ProviderQuery extends AsyncIterable<ProviderEvent> {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  supportedCommands(): Promise<ProviderCommandInfo[]>;
  supportedModels(): Promise<ProviderModelInfo[]>;
  supportedAgents(): Promise<ProviderAgentInfo[]>;
  getContextUsage(): Promise<ProviderContextUsage>;
  mcpServerStatus(): Promise<ProviderMcpServerStatus[]>;
  accountInfo(): Promise<ProviderAccountInfo>;
  rewindFiles(
    userMessageId: string,
    options?: { dryRun?: boolean },
  ): Promise<ProviderRewindResult>;
  /**
   * Optional. Summarize older history into a short preamble in place,
   * preserving the last few raw turns. Providers whose backend manages
   * history opaquely (e.g. Codex) leave this undefined; the harness checks
   * before calling and surfaces a not-supported result instead of throwing.
   */
  compact?(): Promise<ProviderCompactResult>;
  /**
   * Optional. Enumerate the genuine user-text turns in the current
   * conversation, newest-first, for the "rewind to a previous message"
   * picker. Each entry carries an opaque `turnIndex` handle the provider
   * maps back to its internal history, plus a short single-line `preview`.
   * Pure read — no mutation. Providers whose backend manages history
   * opaquely leave this undefined; the harness returns an empty list.
   */
  listRewindTargets?(): RewindTarget[];
  /**
   * Optional. Rewind the conversation to a `turnIndex` returned by
   * {@link listRewindTargets}: discard that user turn and everything after
   * it, repairing any orphaned tool_use at the new tail so the Messages API
   * contract holds. Returns the removed message's text as `reloadText` so
   * the surface can reload it into the input for editing. In-place history
   * mutation guarded by the same idle interlock as {@link compact} — a no-op
   * (`rewound: false`) mid-turn. Providers that manage history opaquely leave
   * this undefined; the harness surfaces a `not-supported` result.
   */
  rewindConversation?(turnIndex: number): Promise<ProviderRewindConversationResult>;
  /**
   * Optional. Update the working directory used by the system prompt and
   * tool handlers for all **subsequent** turns in this query's lifetime.
   *
   * Implemented by `AnthropicDirectQuery` and `OpenAICompatibleQuery`.
   * Providers that manage session state opaquely leave this undefined;
   * `AgentSession.setCwd()` calls it only when present.
   */
  setCwd?(cwd: string): void;
  /**
   * Optional. Force a fresh SDK client by re-reading whatever credential
   * source the provider uses (e.g. the macOS Keychain for OAuth tokens).
   *
   * Used by the `/reauth` slash command to swap the running session's SDK
   * client onto a newly-written credential — e.g. after the operator ran
   * `claude /login` in another terminal to switch accounts.
   *
   * Returns `null` when the provider does not support a forced refresh
   * (api-key mode, local-server mode, providers without keychain integration)
   * or when the underlying refresh failed. Implementations that succeed
   * return the active `accountId` and whether the token byte-changed
   * (`swapped`) so the caller can distinguish "now on a different account"
   * from "already up to date".
   *
   * Implemented by `AnthropicDirectQuery`. Providers that do not implement
   * leave it undefined; `AgentSession.reauth()` returns `null` in that case.
   */
  reauth?(): Promise<{ accountId: string; swapped: boolean } | null>;
  close(): void | Promise<void>;
}

/** Loose structural shape for slash-command discovery across providers. */
export interface ProviderCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
}

/** Loose structural shape for model catalog entries. */
export interface ProviderModelInfo {
  value: string;
  displayName?: string;
  description?: string;
}

/** Loose structural shape for agent discovery. */
export interface ProviderAgentInfo {
  name: string;
  description?: string;
}

/** Loose structural shape for context-usage reporting. */
export interface ProviderContextUsage {
  tools?: unknown[];
  agents?: unknown[];
  isAutoCompactEnabled?: boolean;
  apiUsage?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** Loose structural shape for MCP server status rows. */
export interface ProviderMcpServerStatus {
  name: string;
  status: string;
}

/** Loose structural shape for account info. */
export interface ProviderAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  [key: string]: unknown;
}

/** Loose structural shape for rewindFiles results. */
export interface ProviderRewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}

/**
 * Result of a {@link ProviderQuery.compact} call.
 *
 * `compacted: false` is not an error — it signals a deliberate no-op (history
 * too short, provider doesn't support it, or the user aborted). `reason`
 * carries a short identifier the surface can render to the user.
 */
export interface ProviderCompactResult {
  compacted: boolean;
  reason?: string;
  messagesBefore: number;
  messagesAfter: number;
  /** Best-effort estimate of input tokens saved on subsequent turns. */
  tokensSavedEstimate?: number;
}

/**
 * One rewindable user turn, surfaced to the "edit a previous message" picker
 * by {@link ProviderQuery.listRewindTargets}.
 */
export interface RewindTarget {
  /**
   * Opaque handle the provider maps back to its internal history position.
   * For {@link ProviderQuery.rewindConversation}. Callers must not assume it
   * is a contiguous 0..N index — treat it as a token from `listRewindTargets`.
   */
  turnIndex: number;
  /** Short, single-line preview of the user message text (already truncated). */
  preview: string;
}

/**
 * Result of a {@link ProviderQuery.rewindConversation} call.
 *
 * `rewound: false` is not necessarily an error — it signals a deliberate no-op
 * (session busy, turn in flight, invalid target, or provider doesn't support
 * it). `reason` carries a short identifier the surface can render.
 */
export interface ProviderRewindConversationResult {
  rewound: boolean;
  reason?: string;
  /**
   * Text of the discarded user message, for reloading into the input box so
   * the user can edit and resend. Present only when `rewound: true`.
   */
  reloadText?: string;
  messagesBefore: number;
  messagesAfter: number;
}

/**
 * Arguments for {@link ModelProvider.complete} — a single-shot, non-streaming
 * completion for lightweight side-channel use (inline suggestions,
 * classification, slug-generation, short summaries). Deliberately minimal: no
 * tools, no hooks, no conversation history, no skill manifest. The full
 * `query()` lifecycle would be massive overkill for these.
 *
 * Auth note: when `apiKey` is omitted the provider falls back to the SAME env
 * precedence as `query()`, so a Claude-subscription OAuth token resolved into
 * the environment (or an `OPENAI_API_KEY`) Just Works without the caller
 * re-resolving credentials.
 */
export interface ProviderCompleteArgs {
  /** System prompt. Sent as a single text block. */
  system: string;
  /** User message content. Sent as a single text block. */
  user: string;
  /**
   * Model id. Full ids or short aliases (`haiku`) are accepted; the provider
   * resolves aliases the same way `query()` does. When omitted, the provider
   * selects a cheap default.
   */
  model?: string;
  /** Hard cap on output tokens. Provider chooses a small default when unset. */
  maxTokens?: number;
  /** Caller-controlled cancellation — aborts the in-flight request. */
  signal?: AbortSignal;
  /**
   * Explicit auth material, mirroring `AgentConfig.apiKey`. When omitted the
   * provider falls back to its standard env precedence (see auth note above).
   */
  apiKey?: string;
  /** Endpoint override (local OpenAI-shim / Anthropic-shim baseURL). */
  baseUrl?: string;
}

export interface ModelProvider {
  /** Human-friendly name for diagnostics. */
  readonly name: string;
  query(args: ProviderQueryArgs): ProviderQuery;
  /**
   * Optional single-shot completion. Returns the model's reply text, trimmed.
   * Throws on provider errors (auth, rate-limit, network, abort) — callers own
   * retry/fallback. Providers that don't support it omit the method; callers
   * MUST feature-detect (`if (typeof provider.complete === 'function')`).
   */
  complete?(args: ProviderCompleteArgs): Promise<string>;
  /**
   * Optional disposal hook. Releases provider-held resources — notably the
   * SQLite `MemoryStore` handle opened in the constructor. Callers that build a
   * provider purely for side-channel `complete()` use SHOULD call this when
   * done; otherwise the DB handle leaks for the process lifetime. Providers
   * that hold no resources may omit it, so callers MUST feature-detect
   * (`provider.close?.()`).
   */
  close?(): void | Promise<void>;
}
