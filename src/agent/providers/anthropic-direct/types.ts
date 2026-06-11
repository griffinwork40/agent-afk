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
 * Render-only hints attached to a {@link ToolResult}. These never flow into
 * the Anthropic SDK's `ToolResultBlockParam` — they ride alongside on the
 * provider event stream so renderers can show structured detail (diffs,
 * future tool-specific UI hints) without paying model-context tokens.
 *
 * Structural invariant: nothing under `render` is assignable to any field
 * on `ToolResultBlockParam`. A future maintainer cannot accidentally leak
 * a render hint into the model's tool_result via a spread — TypeScript
 * would reject the assignment.
 */
export interface RenderHints {
  /** Line-based unified diff payload, populated by file-mutation handlers. */
  diff?: import('../../../utils/diff.js').DiffPayload;
}

/**
 * Dispatcher result. `content` is the text that becomes the body of the
 * `tool_result` content block returned to the model. `isError: true` flags
 * the tool call as failed so the model can recover or end-turn.
 *
 * `render` carries structured UI hints (e.g. diffs) that travel on the
 * provider event stream but are NEVER included in the model-facing
 * `ToolResultBlockParam`. See {@link RenderHints} for the invariant.
 *
 * Per-tool display formatting (for the interactive tool-lane outcome row)
 * lives in `src/agent/tools/render-registry.ts`, NOT on this type. The
 * handler emits structured `content`; the registry's per-tool formatter
 * derives a short display string from it at the session boundary. This
 * keeps the handler-return contract narrow and prevents drift between
 * `content` and a parallel display field.
 */
export interface ToolResult {
  content: string;
  isError?: boolean;
  /**
   * Set to `true` by handlers when output was forcibly truncated because the
   * tool's byte cap was exceeded (e.g. bash's 100KB mid-stream kill or
   * post-close slice). Distinct from `isError`: an overflowed bash command
   * may still have exited 0 — `isError` reflects the exit code, `truncated`
   * reflects whether the caller is seeing the full buffer. Callers that need
   * to distinguish "got 100KB of legitimate output" from "got 100KB then
   * killed" should read this field rather than substring-scanning `content`
   * for the `[output truncated …]` sentinel. The sentinel remains in
   * `content` as the in-band signal the model sees; this field is the
   * structured signal for non-model consumers (subagent traces, hooks,
   * caller code).
   */
  truncated?: boolean;
  /** True when this result is a synthetic repeat-loop circuit-breaker block,
   *  not a real tool outcome — lets trace consumers exclude it from failure stats. */
  circuitBreaker?: boolean;
  render?: RenderHints;
  /**
   * Structured test-runner result parsed from bash output by
   * `detectTestResult` in `src/agent/tools/handlers/test-runner-detector.ts`.
   * Present only when the bash command produced recognisable test output.
   * Never forwarded to the model — render-only metadata.
   */
  testResult?: import('../../tools/handlers/test-runner-detector.js').TestResult;
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
  /** Model id (e.g. `claude-sonnet-4-5-20250929`). */
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
   * this to `'max'` for `claude-opus-4-{6,7,8}-*` and `claude-sonnet-4-{6,7}-*`
   * when the caller omits it.
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
   * Optional hook fired once per completed round (both tool-use rounds
   * and the terminal end_turn round) with the cumulative usage so far,
   * so the REPL status line can show live mid-turn context usage. The
   * final `turn.completed` event still carries the authoritative
   * end-of-turn usage (including `durationMs`), which it sets immediately
   * after this hook fires on the final round. Best-effort and synchronous;
   * the loop never awaits it.
   */
  onUsageProgress?: (usage: ProviderUsage) => void;
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
 * widen `AnthropicToolDef` instead and add a new field to the projection
 * in `loop.ts` only after confirming the SDK accepts it.
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
}

/**
 * Static pricing table for known Claude models.
 * Rates are in USD per 1 million tokens.
 *
 * Sources: https://www.anthropic.com/pricing (checked 2025-07)
 *
 * MAINTENANCE: update when Anthropic revises list prices.
 * Units: USD / 1 000 000 tokens (MTok).
 *
 * Cache-write tokens are billed at 1.25× the base input rate;
 * cache-read tokens are billed at 0.1× the base input rate.
 */
interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache-write surcharge per MTok (default: 1.25 × input rate). */
  cacheWritePerMTok?: number;
  /** Cache-read rate per MTok (default: 0.10 × input rate). */
  cacheReadPerMTok?: number;
}

/** @internal exported only for unit tests */
export const MODEL_PRICING: ReadonlyMap<string, ModelPricing> = new Map([
  // Claude 4.5 family
  ['claude-sonnet-4-5-20250929', { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 }],
  ['claude-opus-4-5-20250929',   { inputPerMTok: 15.0, outputPerMTok: 75.0, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.50 }],
  // Haiku 4.5: $1.00 input / $5.00 output per MTok per https://www.anthropic.com/pricing
  // The previous $0.80/$4.00 values were the Haiku 3.5 rates accidentally
  // copied to the 4.5 row, causing per-turn cost under-reporting by ~20%.
  // Cache rates follow the standard 1.25× / 0.10× multipliers.
  ['claude-haiku-4-5-20250929',  { inputPerMTok: 1.00, outputPerMTok: 5.0,  cacheWritePerMTok: 1.25,  cacheReadPerMTok: 0.10 }],
  ['claude-haiku-4-5-20251001',  { inputPerMTok: 1.00, outputPerMTok: 5.0,  cacheWritePerMTok: 1.25,  cacheReadPerMTok: 0.10 }],
  // Claude 3.7 family (kept for backward compat with persisted sessions)
  ['claude-3-7-sonnet-20250219', { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 }],
  // Claude 3.5 family
  ['claude-3-5-sonnet-20241022', { inputPerMTok: 3.0,  outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 }],
  ['claude-3-5-sonnet-20240620', { inputPerMTok: 3.0,  outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 }],
  ['claude-3-5-haiku-20241022',  { inputPerMTok: 0.80, outputPerMTok: 4.0,  cacheWritePerMTok: 1.0,   cacheReadPerMTok: 0.08 }],
  // Claude 3 family
  ['claude-3-opus-20240229',     { inputPerMTok: 15.0, outputPerMTok: 75.0, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.50 }],
  ['claude-3-sonnet-20240229',   { inputPerMTok: 3.0,  outputPerMTok: 15.0, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.30 }],
  ['claude-3-haiku-20240307',    { inputPerMTok: 0.25, outputPerMTok: 1.25, cacheWritePerMTok: 0.30,  cacheReadPerMTok: 0.03 }],
]);

/**
 * Derive the USD cost of a single API call given token counts and a model id.
 *
 * Returns `undefined` when the model is unknown (not in the pricing table) —
 * callers must treat `undefined` as "cost unavailable" and avoid treating it
 * as zero.
 *
 * @internal exported for unit tests
 */
export function deriveCallCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
): number | undefined {
  const pricing = MODEL_PRICING.get(model);
  if (!pricing) return undefined;

  const M = 1_000_000;
  // Plain (non-cached, non-creation) input tokens
  const plainInput = Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens);
  const inputCost = (plainInput / M) * pricing.inputPerMTok;
  const outputCost = (outputTokens / M) * pricing.outputPerMTok;
  const cacheWriteRate = pricing.cacheWritePerMTok ?? pricing.inputPerMTok * 1.25;
  const cacheReadRate = pricing.cacheReadPerMTok ?? pricing.inputPerMTok * 0.10;
  const cacheWriteCost = (cacheCreationTokens / M) * cacheWriteRate;
  const cacheReadCost = (cachedInputTokens / M) * cacheReadRate;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
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
