import type {
  ContentBlockParam,
  MessageParam,
  RawMessageStreamEvent,
  ThinkingConfigParam,
} from '@anthropic-ai/sdk/resources';
import type { ProviderUsage } from '../../provider.js';
import type { AnthropicToolDef, ToolDispatcherLike, TranslateCtx } from './types.js';

/** Immutable inputs shared by every round and retry in one top-level turn. */
export interface RunTurnInput {
  client: AnthropicClientLike;
  messages: MessageParam[];
  system: ContentBlockParam[] | string | null;
  tools: AnthropicToolDef[] | null;
  toolDispatcher: ToolDispatcherLike;
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
  /** Effective Fast decision captured once at turn start. */
  fastMode?: boolean;
  baseUrl?: string;
  traceWriter?: import('../../trace/index.js').TraceSink;
  subagentId?: string;
  onUsageProgress?: (usage: ProviderUsage) => void;
  throttleQueue?: import('./throttle-queue.js').ThrottleQueue;
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
  thinking?: ThinkingConfigParam;
  output_config?: { effort?: import('../../types/sdk-types.js').EffortLevel };
  speed?: 'fast';
  stream: true;
  metadata?: Record<string, unknown>;
}
