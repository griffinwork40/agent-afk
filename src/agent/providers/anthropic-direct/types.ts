/**
 * Internal types for the `anthropic-direct` provider.
 *
 * Pinned signatures live here so each sibling module (auth, translate, loop,
 * query, tool-dispatcher) can be developed and tested in isolation without
 * cross-module type drift. No runtime exports.
 *
 * @module agent/providers/anthropic-direct/types
 */

import type {
  ContentBlockParam,
  MessageParam,
  RawMessageStreamEvent,
  ThinkingConfigParam,
  ToolUseBlock,
  Usage,
} from '@anthropic-ai/sdk/resources';
import type { ProviderEvent, ProviderUsage } from '../../provider.js';
import type { ToolResult } from '../shared/tool-result.js';
import { getCacheTtl } from './cache-policy.js';
import { deriveCallCostUsd, type CacheWriteSplit } from './pricing.js';

export type { ToolResult, RenderHints } from '../shared/tool-result.js';

/**
 * Auth mode is selected by token shape. OAuth-mode tokens (`sk-ant-oat01-*`)
 * require the Bearer + claude-code beta + cli identity headers + system-prompt
 * billing-header recipe. API-key-mode tokens go through the standard
 * `x-api-key` path with no extra headers or body mangling.
 */
export type AuthMode = 'oauth' | 'api-key';

/**
 * A single tool call extracted from an assistant turn.
 *
 * The `signal` is the per-turn AbortSignal so dispatchers can cancel cleanly
 * when the user interrupts a turn while a tool is mid-flight.
 */
export interface ToolCall {
  /** Anthropic-assigned tool-use id; round-trips back as `tool_result.tool_use_id`. */
  id: string;
  /** Tool name as declared by the model (matches the registered tool's `name`). */
  name: string;
  /** Decoded JSON input. Dispatchers must validate; type is `unknown` on purpose. */
  input: unknown;
  /** Per-turn cancellation signal. */
  signal: AbortSignal;
}

/**
 * Output yielded by `translateMessageStream`. A discriminated union so the
 * loop can distinguish "an event to surface to the harness right now" from
 * "the turn is finished, here's the digested result for the next iteration."
 */
export type TranslateOutput =
  | { kind: 'event'; event: ProviderEvent }
  | { kind: 'turn-result'; result: TurnResult };

/**
 * Per-turn translator context. Threaded through so synthetic events
 * (`session.init`, `assistant.message`) can carry the session id and so the
 * translator can stamp `sessionId` onto delta events the consumer relies on.
 */
export interface TranslateCtx {
  sessionId: string;
}

/**
 * Result of a single `messages.stream` call. The loop uses this to decide
 * whether to dispatch tools and continue, or exit and emit `turn.completed`.
 */
export interface TurnResult {
  /**
   * `'tool_use'` means the model wants to call tools (loop continues with
   * `tool_result` blocks). `'end_turn'`, `'stop_sequence'`, `'max_tokens'`,
   * `'pause_turn'` mean the turn is finished. `null` is treated as finished.
   */
  stopReason: string | null;
  /**
   * Full assistant content blocks for this iteration — pushed back into the
   * messages array verbatim so the model sees its own prior turn including
   * tool_use blocks on the next iteration.
   */
  assistantBlocks: ContentBlockParam[];
  /** Tool-use blocks extracted from `assistantBlocks` for dispatcher convenience. */
  toolUseBlocks: ToolUseBlock[];
  /** Usage for this iteration. The loop sums these across the full turn. */
  usage: Usage | null;
  /** Concatenated text from all `text` blocks in this iteration. */
  text: string;
}

/**
 * Inputs to `runTurn` (the per-turn agentic loop). The loop is a pure async
 * generator over `ProviderEvent`s; it owns nothing stateful itself. The
 * caller (query.ts) holds the messages array across turns.
 */
export interface RunTurnInput {
  /** Anthropic SDK client, already constructed with the right auth mode. */
  client: AnthropicClientLike;
  /** Conversation history including the new user turn appended last. */
  messages: MessageParam[];
  /** Composed system prompt array (billing-header block prepended for oauth). */
  system: ContentBlockParam[] | string | null;
  /** Tool definitions exposed to the model (Anthropic tool-use shape). */
  tools: AnthropicToolDef[] | null;
  /** Pluggable dispatcher invoked when the model emits tool_use blocks. */
  toolDispatcher: ToolDispatcherLike;
  /** Model id (e.g. `claude-sonnet-5`). */
  model: string;
  /** Max tokens per `messages.create` call. */
  maxTokens: number;
  /** Per-request HTTP headers (oauth recipe headers for oauth mode, {} for api-key). */
  headers: Record<string, string>;
  /** Per-turn cancellation signal. */
  signal: AbortSignal;
  /** Translator context (session id for stamping events). */
  ctx: TranslateCtx;
  /** Hard cap on tool-use loop iterations within a single user turn. */
  maxToolUseIterations?: number;
  /** Extended thinking configuration. When set, forwarded to `messages.create`. */
  thinking?: ThinkingConfigParam;
  /**
   * Effort level for adaptive thinking depth, forwarded as
   * `output_config.effort` in the wire request.  Requires the
   * `effort-2025-11-24` beta header to be present (see
   * {@link buildRequestHeaders} `withEffort` flag).
   *
   * When set, the per-request `anthropic-beta` header is extended with the
   * effort beta string.  The `resolveEffort` helper in `index.ts` defaults
   * this to `'max'` for `claude-opus-4-{6,7,8}-*`, `claude-sonnet-4-{6,7}-*`,
   * and `claude-sonnet-5` when the caller omits it.
   */
  effort?: import('../../types/sdk-types.js').EffortLevel;
  /**
   * Local-server base URL. When set, the per-turn cache breakpoint is
   * suppressed (local shims rarely honor `cache_control`). Plumbed through
   * `isCacheEnabled({baseUrl})` in loop.ts.
   */
  baseUrl?: string;
  /** Witness-layer trace writer. When provided, the loop emits
   *  `tool_call.started` before dispatch and `tool_call.completed`
   *  after each result. See `docs/philosophy/afk-contract.md`. */
  traceWriter?: import('../../trace/index.js').TraceWriter;
  /**
   * This loop's owning subagent id, present only when the loop runs inside a
   * forked child (`AgentConfig.subagentId`). Stamped onto every `tool_call`
   * started/completed event so a fork's tool calls are attributable in the
   * shared parent trace. Absent for a top-level session — its tool calls stay
   * untagged. See issue #612. */
  subagentId?: string;
  /**
   * Optional hook fired once per completed round (both tool-use rounds
   * and the terminal end_turn round) with the cumulative usage so far,
   * so the REPL status line can show live mid-turn context usage. The
   * final `turn.completed` event still carries the authoritative
   * end-of-turn usage (including `durationMs`), which it sets immediately
   * after this hook fires on the final round. Best-effort and synchronous;
   * the loop never awaits it.
   */
  onUsageProgress?: (usage: ProviderUsage) => void;
  /**
   * Optional out-of-band mailbox for live throttle (rate-limit/backoff)
   * signals pushed from the wrapped `fetch` (see `tracing-fetch.ts`). When
   * present, the loop RACES its `messages.create` await against this queue so
   * a 429/503/529 backoff observed INSIDE the SDK call surfaces as a
   * `rate_limit` ProviderEvent LIVE — the loop is otherwise parked on the
   * await and cannot yield during the wait. The same queue instance is wired
   * to the client's fetch callback at query construction. Absent for the
   * external-dispatcher / local-shim paths and in unit tests that don't
   * exercise throttling.
   */
  throttleQueue?: import('./throttle-queue.js').ThrottleQueue;
}

/**
 * Subset of `Anthropic` we actually call. Defining it structurally keeps
 * loop.ts unit-testable with a minimal stub instead of a full SDK mock.
 */
export interface AnthropicClientLike {
  messages: {
    create(
      params: AnthropicMessagesCreateParams,
      options?: { headers?: Record<string, string>; signal?: AbortSignal },
    ): Promise<AsyncIterable<RawMessageStreamEvent>> | AsyncIterable<RawMessageStreamEvent>;
  };
}

/**
 * Wire-safe projection of `AnthropicToolDef`. The Anthropic Messages API
 * rejects extra fields on custom tool definitions (e.g. `category`,
 * `concurrencySafe`, `riskClass`) with a 400 `tools.0.custom.<field>:
 * Extra inputs are not permitted`. This narrow type is what we actually
 * hand to `messages.create`; the fat `AnthropicToolDef` carries internal
 * classification metadata that must NEVER cross the wire boundary.
 *
 * If you find yourself widening this type, you almost certainly want to
 * widen `AnthropicToolDef` instead and add a new field to `toWireTool`
 * in `loop/round-request.ts` only after confirming the SDK accepts it.
 */
export interface WireToolDef {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

/**
 * Minimal shape of params we hand to `messages.create`. Re-exporting from
 * the SDK directly gives us the full type but creates a circular hassle in
 * tests; this loose alias is intentional and matches how `messages.create`
 * accepts inputs at runtime.
 *
 * `tools` is typed as `WireToolDef[]` (not `AnthropicToolDef[]`) so the
 * compiler refuses to pass the fat internal struct directly — a projection
 * is required at every call site.
 */
export interface AnthropicMessagesCreateParams {
  model: string;
  max_tokens: number;
  messages: MessageParam[];
  system?: ContentBlockParam[] | string;
  tools?: WireToolDef[];
  thinking?: ThinkingConfigParam;
  /**
   * Output configuration forwarded verbatim to the Anthropic Messages API.
   * Currently used only for the `effort` field, which controls adaptive
   * thinking depth on Opus 4.7+.  Requires the
   * `effort-2025-11-24` beta header (see
   * {@link buildRequestHeaders}).
   */
  output_config?: { effort?: import('../../types/sdk-types.js').EffortLevel };
  stream: true;
  metadata?: Record<string, unknown>;
}

/**
 * Semantic category for tool classification.
 *
 * Duplicated here so the provider-boundary type doesn't need to import
 * from the higher-level `agent/tool-category` module (which would create
 * a layering inversion). `src/agent/tool-category.ts` re-exports this
 * definition and owns the authoritative documentation.
 */
export type ToolCategory =
  | 'read'
  | 'write'
  | 'shell'
  | 'subagent'
  | 'skill'
  | 'dag'
  | 'mcp'
  | 'web'
  | 'browser'
  | 'planning'
  | 'schedule'
  | 'other';

/**
 * Anthropic tool definition shape. The SDK exports a precise type; we use
 * a structural alias so the provider boundary doesn't import it.
 *
 * The three optional classification fields (`category`, `concurrencySafe`,
 * `riskClass`) make the schema the single source of truth for tool
 * classification. Consumers derive their sets from these fields rather than
 * maintaining independent hard-coded lists.
 *
 * - `category` — semantic bucket; required on every built-in tool. MCP
 *   tools and dynamically-injected plugin tools may omit it and fall through
 *   to `categorizeTool`'s string-matching heuristics.
 * - `concurrencySafe` — when `true` the dispatcher may run this tool
 *   concurrently with other concurrency-safe tools in the same batch.
 *   Defaults to `false`.
 * - `riskClass` — optional override for the risk classifier's default
 *   category-based derivation (`'safe'` | `'caution'` | `'destructive'`).
 *   When omitted the classifier derives risk from `category`.
 */
export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
  /** Semantic category — drives plan-mode gating, risk classification, and
   *  concurrency batching. Required on every built-in tool. */
  category?: ToolCategory;
  /** When `true`, the dispatcher may run this tool concurrently with other
   *  concurrency-safe tools in the same batch. Defaults to `false`. */
  concurrencySafe?: boolean;
  /** Optional override for the risk classifier's default category-based
   *  derivation. `'safe'` | `'caution'` | `'destructive'`. */
  riskClass?: 'safe' | 'caution' | 'destructive';
}

/**
 * Structural alias so loop.ts doesn't import tool-dispatcher.ts directly
 * (avoids a layering cycle if a dispatcher implementation ever wants to
 * call back into the provider).
 */
export interface ToolDispatcherLike {
  execute(call: ToolCall): Promise<ToolResult>;
  executeBatch?(calls: ToolCall[]): Promise<ToolResult[]>;
  /**
   * Optional in-place cwd update. When present, called by
   * `AnthropicDirectQuery.setCwd()` BEFORE the dispatcher reference is
   * swapped so that any in-flight `runInput.toolDispatcher` reference
   * (captured by `loop.ts`) sees the new cwd on its next `handlerContext`
   * read. Dispatchers that own their own cwd model can omit this.
   * See `SessionToolDispatcher.setResolveBase` for the canonical
   * implementation.
   */
  setResolveBase?(cwd: string): void;
  /**
   * Optional in-place bypass (`allowAll`) update. Called by a provider query
   * handle's `setPermissionMode()` so a live `/bypass` toggle changes effective
   * file-tool path containment mid-session. The dispatcher reads `allowAll`
   * fresh per call (via its `handlerContext` getter), so flipping it here takes
   * effect on the NEXT tool call — no dispatcher swap needed. Dispatchers that
   * own their own permission model can omit this.
   * See `SessionToolDispatcher.setAllowAll` for the canonical implementation.
   */
  setAllowAll?(allow: boolean): void;
}

/**
 * Re-export of the pricing table and per-call cost derivation from their new
 * home at `./pricing.ts`. Backward-compatibility shim — the pricing concern
 * moved into its own file to keep this module under the repo's file-size
 * ceiling. Existing call sites and tests import from here unchanged.
 */
export { MODEL_PRICING } from './pricing.js';
export { deriveCallCostUsd };
export type { ModelPricing, CacheWriteSplit } from './pricing.js';

/**
 * Contract: split this call's cache-write tokens by the TTL they were billed
 * at, so `deriveCallCostUsd` can apply 1.25× (5m) vs 2× (1h) correctly.
 *
 * Prefers the API's own `usage.cache_creation` breakdown — that is what was
 * actually billed, and it is the only source that stays right when a request
 * mixes TTLs. Falls back to attributing every write token to the locally
 * configured TTL (`getCacheTtl()`), which is correct for this provider because
 * `cache-policy.ts` stamps every breakpoint in a request with that one TTL.
 * The fallback matters: without it an endpoint that omits `cache_creation`
 * would be priced at 5m rates while `AFK_PROMPT_CACHE_TTL` defaults to `1h`.
 *
 * This is the single env-reading boundary for pricing — `pricing.ts` stays
 * pure so its golden-rate tests cannot drift with ambient config.
 */
function resolveCacheWriteSplit(usage: Usage): CacheWriteSplit {
  // Invariant: the SDK types every field read below as a required `number`,
  // but that is a compile-time guarantee only — a malformed response (or a
  // hand-built fixture) could still carry a negative or NaN count, which
  // would propagate into a negative/NaN totalCostUsd downstream. Clamp here
  // so both branches below (explicit breakdown vs. total-only fallback)
  // return only finite, non-negative counts.
  const clampCount = (n: number): number => (Number.isFinite(n) && n >= 0 ? n : 0);
  const breakdown = usage.cache_creation;
  if (breakdown) {
    return {
      ephemeral5m: clampCount(breakdown.ephemeral_5m_input_tokens ?? 0),
      ephemeral1h: clampCount(breakdown.ephemeral_1h_input_tokens ?? 0),
    };
  }
  const total = clampCount(usage.cache_creation_input_tokens ?? 0);
  return getCacheTtl() === '1h'
    ? { ephemeral5m: 0, ephemeral1h: total }
    : { ephemeral5m: total, ephemeral1h: 0 };
}

/**
 * Convert a single Anthropic `Usage` into our normalized `ProviderUsage`.
 * Lives in types.ts because both `loop` and `query` need it.
 *
 * `model` is optional — when supplied, `totalCostUsd` is computed from the
 * static pricing table. When unknown or omitted, `totalCostUsd` is left
 * undefined so callers can detect "cost unavailable" vs. "cost is zero".
 */
export function toProviderUsage(
  usage: Usage | null,
  stopReason: string | null,
  model?: string,
): ProviderUsage {
  if (!usage) {
    return { stopReason: stopReason ?? null };
  }
  const out: ProviderUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    stopReason: stopReason ?? null,
  };
  if (usage.cache_read_input_tokens != null) {
    out.cachedInputTokens = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens != null) {
    out.cacheCreationTokens = usage.cache_creation_input_tokens;
  }
  out.totalTokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);

  // Derive cost when model pricing is available.
  if (model) {
    const cost = deriveCallCostUsd(
      model,
      usage.input_tokens ?? 0,
      usage.output_tokens ?? 0,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
      resolveCacheWriteSplit(usage),
    );
    if (cost !== undefined) out.totalCostUsd = cost;
  }

  return out;
}

/**
 * Re-export of `sumProviderUsage` from its new home at `src/agent/usage.ts`.
 * Backward-compatibility shim — the function moved up one layer so the
 * `openai-compatible` provider can import it without cross-importing from
 * a sibling provider directory. Existing call sites
 * (`anthropic-direct/loop.ts`, `sum-provider-usage.test.ts`, etc.) keep
 * working unchanged.
 */
export { sumProviderUsage } from '../../usage.js';
