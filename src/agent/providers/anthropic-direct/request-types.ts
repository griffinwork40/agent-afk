import type {
  ContentBlockParam,
  MessageParam,
  RawMessageStreamEvent,
  ThinkingConfigParam,
} from '@anthropic-ai/sdk/resources';
import type { ProviderUsage } from '../../provider.js';
import type { AnthropicToolDef, ToolDispatcher, TranslateCtx } from './types.js';

/** Immutable inputs shared by every round and retry in one top-level turn. */
export interface RunTurnInput {
  client: AnthropicClientLike;
  messages: MessageParam[];
  system: ContentBlockParam[] | string | null;
  tools: AnthropicToolDef[] | null;
  toolDispatcher: ToolDispatcher;
  model: string;
  maxTokens: number;
  headers: Record<string, string>;
  signal: AbortSignal;
  ctx: TranslateCtx;
  maxToolUseIterations?: number;
  /** Soft wall-clock deadline, ms from turn start. `0`/unset = off. See shared/soft-deadline.ts. */
  softDeadlineMs?: number;
  thinking?: ThinkingConfigParam;
  effort?: import('../../types/sdk-types.js').EffortLevel;
  /** Sampling temperature forwarded to `messages.create`. Omit for server default. */
  temperature?: number;
  /** Allows Fable 5.1 prefix-bound thinking blocks to be dropped instead of 400ing. */
  thinkingBlockBinding?: { prefix_mismatch_behavior: 'drop_block' };
  /** Effective Fast decision captured once at turn start. */
  fastMode?: boolean;
  baseUrl?: string;
  traceWriter?: import('../../trace/index.js').TraceSink;
  subagentId?: string;
  onUsageProgress?: (usage: ProviderUsage) => void;
  throttleQueue?: import('./throttle-queue.js').ThrottleQueue;
  /** Callback invoked after each tool round returns 'continue', before the next openRound(). Returns steering text to inject, or undefined. */
  beforeNextRound?: () => string | undefined;
  /** Journal differ; `sync(messages)` at each commit point (docs/message-journal.md). */
  journalSync?: import('../../journal/index.js').JournalSync<MessageParam>;
  /**
   * Contract: the turn-scoped accumulator (wall-clock origin, completed-round
   * count, wind-down reason, summed usage) for the USER TURN this input belongs
   * to. Created once per user turn by `prepareTurnRequest`; `runTurn` reuses it
   * when present and only falls back to a fresh one when absent (direct
   * callers/tests).
   *
   * Invariant: the retry tiers (overload pause → usage limit → auth) recover by
   * calling `runTurn` AGAIN with this same object. Every turn budget must be
   * measured from the original turn, so the replay must continue this
   * accumulator — a fresh one restarts the soft-deadline clock and the round
   * cap and drops the pre-replay rounds' usage (2026-09-28: a 401 replay ~33 min
   * into a 45-min child pushed its 40-min soft deadline to ~73 min, past the
   * hard abort). See turn-budget-replay.test.ts.
   */
  turnState?: import('./loop/turn-accumulator.js').TurnAccumulator;
}

/** Streaming-only subset of the Anthropic client used by the loop. */
export interface AnthropicClientLike {
  messages: {
    create(
      params: AnthropicMessagesCreateParams,
      options?: { headers?: Record<string, string>; signal?: AbortSignal },
    ): Promise<AsyncIterable<RawMessageStreamEvent>> | AsyncIterable<RawMessageStreamEvent>;
  };
}

/** Wire-safe projection; internal classification fields cannot cross the API boundary. */
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

export interface AnthropicMessagesCreateParams {
  model: string;
  max_tokens: number;
  messages: MessageParam[];
  system?: ContentBlockParam[] | string;
  tools?: WireToolDef[];
  /** Thinking config, optionally augmented with the Fable 5.1 prefix-binding control. */
  thinking?: ThinkingConfigParam & { block_binding?: { prefix_mismatch_behavior: 'drop_block' } };
  output_config?: { effort?: import('../../types/sdk-types.js').EffortLevel };
  temperature?: number;
  speed?: 'fast';
  stream: true;
  metadata?: Record<string, unknown>;
}
