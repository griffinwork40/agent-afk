/**
 * Subagent result types and structured output extraction.
 *
 * Handles validation of assistant messages against optional Zod schemas,
 * populating `output` on success or `schemaError` on mismatch.
 *
 * @module agent/subagent/result
 */

import type { ZodError, ZodType } from 'zod';
import type { Message } from '../types.js';
import { extractStructuredOutput } from '../output-extractor.js';

export type SubagentStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface SubagentToolCall {
  id: string;
  name: string;
  /**
   * Byte length of the tool's serialized input. Content is intentionally omitted
   * to avoid leaking secrets (tokens, file contents, env vars) through the trace,
   * which flows to hook handlers that may log or persist it. Callers needing the
   * actual input should read provider message history.
   */
  inputBytes?: number;
}

export interface SubagentToolResult {
  toolUseId: string;
  isError?: boolean;
  /**
   * `true` when the tool handler reported a byte-cap overflow (e.g. bash
   * or grep killed mid-stream because output exceeded 100KB). Reflects the
   * structured `ToolResult.truncated` flag set by the handler — not the
   * cosmetic 80-char display preview clip. Parent agents can use this to
   * distinguish "subagent's bash got 100KB of legitimate output" from
   * "subagent's bash got 100KB then was killed" without substring-scanning
   * tool output for the `[output truncated …]` sentinel.
   */
  truncated?: boolean;
  sizeBytes?: number;
}

export interface SubagentTrace {
  toolCalls: SubagentToolCall[];
  toolResults: SubagentToolResult[];
  thinkingPresent: boolean;
  turnCount: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

export function createEmptyTrace(): SubagentTrace {
  return { toolCalls: [], toolResults: [], thinkingPresent: false, turnCount: 0 };
}

export interface SubagentResult<T = unknown> {
  id: string;
  status: SubagentStatus;
  message?: Message;
  /** Parsed structured output (populated when `outputSchema` is provided and parse succeeds). */
  output?: T;
  /**
   * Failure cause. Set when `status === 'failed'` — either the runtime exception
   * thrown during execution, or a synthesized error describing a schema parse
   * failure (with the original ZodError attached as `cause` and surfaced via
   * `schemaError`).
   */
  error?: Error;
  /** Structured Zod parse failure, set alongside `error` on schema validation failures. */
  schemaError?: ZodError;
  /**
   * Partial output captured before a failure, timeout, or cancellation.
   * Populated opportunistically when the subagent could not finish but had produced
   * intermediate work worth surfacing. Parent agents may use this to recover, retry
   * with narrower scope, or route to a fallback.
   *
   * On the success path with a schema-typed subagent, this will be `T` (or absent).
   * On the failure path the value is always a raw `string` fragment — whatever
   * the assistant had streamed before the error interrupted execution. Typed as
   * `T | string` so consumers are not misled into treating the failure-path value
   * as a schema-validated `T`.
   */
  partialOutput?: T | string;
  /**
   * Fraction of work completed at the time of termination, in [0, 1].
   * Only meaningful when the subagent reports progress; absent otherwise.
   */
  completionPercent?: number;
  /** Execution trace: tool calls, tool results, thinking presence, and usage. */
  trace?: SubagentTrace;
}

/**
 * Build a SubagentResult from a successful message.
 * If an outputSchema is provided, attempts extraction and parsing.
 */
export function buildResultFromMessage<T>(
  id: string,
  status: SubagentStatus,
  message: Message,
  outputSchema: ZodType<T> | undefined,
  trace?: SubagentTrace,
): SubagentResult<T> {
  if (!outputSchema) {
    return { id, status, message, trace };
  }

  const candidate = extractStructuredOutput(message.content);
  const parsed = outputSchema.safeParse(candidate);
  if (parsed.success) {
    return { id, status, message, output: parsed.data, trace };
  }

  return {
    id,
    status: 'failed',
    message,
    error: new Error(`structured output did not match schema: ${parsed.error.message}`, {
      cause: parsed.error,
    }),
    schemaError: parsed.error,
    trace,
  };
}

/**
 * Build a SubagentResult from a caught error.
 */
export function buildResultFromError<T>(
  id: string,
  status: SubagentStatus,
  err: unknown,
  trace?: SubagentTrace,
): SubagentResult<T> {
  const error = err instanceof Error ? err : new Error(String(err));
  return { id, status, error, trace };
}

/**
 * Format a failed SubagentResult's status and error for inclusion in a thrown
 * error or log message. Returns the status string, optionally suffixed with
 * `: <error.message>` when a failure cause is attached.
 */
export function describeFailure(result: Pick<SubagentResult, 'status' | 'error'>): string {
  return `${result.status}${result.error ? `: ${result.error.message}` : ''}`;
}

/**
 * Error decorated with partial findings + subagent identity. Used by callers
 * that throw on subagent failure (e.g. `runSubagentDAG`) so downstream
 * surfaces — compose's `formatDAGResult`, error renderers — can extract the
 * partial output that would otherwise be dropped on the throw boundary.
 *
 * Mutates and returns the passed error so existing message / cause / stack
 * are preserved.
 */
export interface SubagentExecutionError extends Error {
  partialOutput?: unknown;
  subagentId?: string;
}

export function attachSubagentContext(
  err: Error,
  context: { partialOutput?: unknown; subagentId?: string },
): SubagentExecutionError {
  const wrapped = err as SubagentExecutionError;
  if (context.partialOutput !== undefined && context.partialOutput !== null) {
    wrapped.partialOutput = context.partialOutput;
  }
  if (context.subagentId !== undefined) {
    wrapped.subagentId = context.subagentId;
  }
  return wrapped;
}
