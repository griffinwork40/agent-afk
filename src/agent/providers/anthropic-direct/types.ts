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
export { MODEL_PRICING, deriveCallCostUsd } from './pricing.js';
export { toProviderUsage } from './usage.js';
export type {
  RunTurnInput,
  AnthropicClientLike,
  WireToolDef,
  AnthropicMessagesCreateParams,
} from './request-types.js';
import type { ToolFailureClass } from '../../trace/types.js';

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
  /**
   * Set to `true` when this result carries a SUBAGENT's partial/incomplete
   * answer — the child hit its tool-use iteration cap or its stream was cut
   * off mid-flight (see `isIncompleteStopReason` in `agent/subagent/result.js`).
   * Deliberately NOT named `truncated`: that field means tool-OUTPUT truncation
   * (bash/grep/web-scrape byte-cap slicing) and is orthogonal — a subagent
   * result can be `incomplete` while its content is nowhere near any byte cap,
   * and a tool's output can be `truncated` with no subagent involved at all.
   * `incomplete` is the structured counterpart to the `[⚠ PARTIAL RESULT…]`
   * prose banner `annotateIfIncomplete` prepends to `content`: the banner
   * stays (existing consumers depend on it as the in-band model-visible
   * signal); this flag lets non-model consumers (trace readers, hooks,
   * calling code) branch on the same fact without substring-matching the
   * banner text. Absent for a clean completion or any non-subagent tool.
   */
  incomplete?: boolean;
  /**
   * The subagent's `stopReason` that produced `incomplete: true` (e.g.
   * `tool_use_loop_capped`, `stream_incomplete`). Present only alongside
   * `incomplete: true`; absent otherwise.
   */
  incompleteReason?: string;
  /** True when this result is a synthetic repeat-loop circuit-breaker block,
   *  not a real tool outcome — lets trace consumers exclude it from failure stats. */
  circuitBreaker?: boolean;
  /**
   * Coarse classification of WHY this result is an error, set by the site that
   * produced it (dispatcher gate or tool handler). Carried through to the
   * `tool_call` completed trace event so failure-density detection can
   * distinguish "the system correctly said no" (policy/permission/hook/abort)
   * from a real tool fault. Absent on success and unclassified failures.
   * See {@link import('../../trace/types.js').ToolFailureClass}.
   */
  failureClass?: ToolFailureClass;
  /**
   * 1-based position and total size of the concurrency batch this call was
   * dispatched in, stamped by {@link SessionToolDispatcher.executeBatch}.
   * `batchSize > 1` means the call ran in a parallel wave alongside
   * `batchSize - 1` sibling calls; `batchSize === 1` (or absent) means it ran
   * alone in its own sequential batch — which is the case for EVERY
   * concurrency-unsafe tool (bash, write_file, edit_file, …), since the
   * partitioner isolates each into a singleton batch.
   *
   * Render-only + trace metadata, never forwarded to the model. Lets the TUI
   * and `afk trace show` distinguish a genuine parallel wave from back-to-back
   * sequential dispatches, which are otherwise visually identical once
   * committed to scrollback. Note `batchSize` is the number of calls
   * DISPATCHED together, not the number that ran at literally the same instant:
   * a safe batch wider than `maxConcurrentSafeCalls` drains through the pool in
   * sub-waves, but is one logical batch here. Absent when the dispatcher ran
   * the non-batching `execute()` path (single-tool fallback).
   */
  batchIndex?: number;
  batchSize?: number;
  render?: RenderHints;
  /**
   * Structured test-runner result parsed from bash output by
   * `detectTestResult` in `src/agent/tools/handlers/test-runner-detector.ts`.
   * Present only when the bash command produced recognisable test output.
   * Never forwarded to the model — render-only metadata.
   */
  testResult?: import('../../tools/handlers/test-runner-detector.js').TestResult;
  /**
   * Optional image to surface to the model as part of the `tool_result`.
   *
   * Unlike `render` (deliberately kept OUT of the model-facing block), `image`
   * IS model-facing: the anthropic-direct loop emits it as an `image` content
   * block alongside the `content` text. Set by tools that produce pixels the
   * model should read visually (e.g. browser_screenshot).
   *
   * `data` is base64-encoded raw bytes (no `data:` URI prefix). Providers that
   * cannot represent images in a tool result (OpenAI `role:'tool'`) ignore
   * this field and degrade to text-only — so `content` must still carry a
   * useful textual summary (path, dimensions) on its own.
   */
  image?: {
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
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
