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
  ToolUseBlock,
  Usage,
} from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../provider.js';
import type { ToolResult } from '../shared/tool-result.js';

export type { ToolResult, RenderHints } from '../shared/tool-result.js';

/**
 * Re-export of the pricing table and per-call cost derivation from their new
 * home at `./pricing.ts`, and of usage normalization from `./usage.ts`.
 * Backward-compatibility shims — both concerns moved into their own files to
 * keep this module under the repo's file-size ceiling. Existing call sites and
 * tests import from here unchanged.
 */
export { MODEL_PRICING, deriveCallCostUsd } from './pricing.js';
export type {
  ModelPricing,
  CacheWriteSplit,
  AnthropicSpeed,
  SpeedPricingContext,
} from './pricing.js';
export { toProviderUsage } from './usage.js';
export type {
  RunTurnInput,
  AnthropicClientLike,
  WireToolDef,
  AnthropicMessagesCreateParams,
} from './request-types.js';

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
 * Re-export of `sumProviderUsage` from its new home at `src/agent/usage.ts`.
 * Backward-compatibility shim — the function moved up one layer so the
 * `openai-compatible` provider can import it without cross-importing from
 * a sibling provider directory. Existing call sites
 * (`anthropic-direct/loop.ts`, `sum-provider-usage.test.ts`, etc.) keep
 * working unchanged.
 */
export { sumProviderUsage } from '../../usage.js';
