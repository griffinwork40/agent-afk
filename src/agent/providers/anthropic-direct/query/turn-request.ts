import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { FastModeController, FastTurnDecision } from '../../../fast-mode.js';
import type { AnthropicClientLike, AnthropicToolDef, RunTurnInput, ToolDispatcherLike } from '../types.js';
import { buildRequestHeaders } from '../auth.js';
import { isExtendedCacheTtlActive } from '../cache-policy.js';

export interface TurnRequestInput {
  client: AnthropicClientLike;
  messages: RunTurnInput['messages'];
  system: ContentBlockParam[] | string | null;
  tools: AnthropicToolDef[] | null;
  toolDispatcher: ToolDispatcherLike;
  model: string;
  maxTokens: number;
  signal: AbortSignal;
  authMode: import('../types.js').AuthMode;
  sessionId: string;
  requestId: string;
  fastModeController?: FastModeController;
  baseUrl?: string;
  thinking?: RunTurnInput['thinking'];
  effort?: RunTurnInput['effort'];
  maxToolUseIterations?: number;
  traceWriter?: RunTurnInput['traceWriter'];
  subagentId?: string;
  throttleQueue?: RunTurnInput['throttleQueue'];
  onUsageProgress?: RunTurnInput['onUsageProgress'];
}

/** Snapshot eligibility and construct the immutable input reused by all rounds/retries. */
export function prepareTurnRequest(input: TurnRequestInput): {
  decision: FastTurnDecision | undefined;
  runInput: RunTurnInput;
} {
  const decision = input.fastModeController?.snapshotTurn({
    resolvedModelId: input.model,
    providerFamily: 'anthropic-direct',
    hasCustomEndpoint: input.baseUrl !== undefined,
    executionPath: 'top-level',
  });
  const fast = decision?.effective === true;
  const headers = buildRequestHeaders(
    input.authMode,
    input.sessionId,
    input.requestId,
    input.effort !== undefined,
    isExtendedCacheTtlActive(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    fast,
  );
  return {
    decision,
    runInput: {
      client: input.client,
      messages: input.messages,
      system: input.system,
      tools: input.tools,
      toolDispatcher: input.toolDispatcher,
      model: input.model,
      maxTokens: input.maxTokens,
      headers,
      signal: input.signal,
      ctx: { sessionId: input.sessionId },
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(fast ? { fastMode: true } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.maxToolUseIterations !== undefined ? { maxToolUseIterations: input.maxToolUseIterations } : {}),
      ...(input.traceWriter ? { traceWriter: input.traceWriter } : {}),
      ...(input.subagentId !== undefined ? { subagentId: input.subagentId } : {}),
      ...(input.throttleQueue ? { throttleQueue: input.throttleQueue } : {}),
      ...(input.onUsageProgress ? { onUsageProgress: input.onUsageProgress } : {}),
    },
  };
}

/** Prefix marking an error raised while Fast mode was the requested speed. */
export const FAST_ERROR_PREFIX = '[Fast mode requested; no standard-mode fallback will be attempted]';

/**
 * Add visible request intent without changing the original error or retry policy.
 *
 * Invariant: the annotation is PURELY cosmetic — it rewrites `message` and
 * nothing else. Every downstream classifier keys off own enumerable properties
 * carried on the thrown SDK error rather than its prototype:
 *   - `status === 401`  → retry-layer's `isRetryableAuth` (refresh + replay)
 *   - `status === 429`  → `classifyUsageLimitError` (pause/resume tiers)
 *   - `status` 529/503  → `isTransientServerError` / `isOverloadedErrorEvent`
 *   - nested `error`/`headers` → SSE overload body + rate-limit reset headers
 * A naive `new Error(msg)` wrapper drops all of them, which silently downgrades
 * every Fast-mode turn to "terminal on first error": a 401 that should refresh
 * the OAuth token and replay instead surfaces as a hard failure. So copy the
 * original's own properties onto the annotated error and keep `cause` for
 * provenance. Regression-tested by the Fast 401 replay case in
 * `query-auth-retry.test.ts`.
 */
export function annotateFastError(error: unknown, fast: boolean): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  if (!fast) return original;
  // Already annotated (e.g. round-request annotated it, then query-runtime saw
  // the same throw): don't stack a second prefix.
  if (original.message.startsWith(FAST_ERROR_PREFIX)) return original;
  const annotated = new Error(`${FAST_ERROR_PREFIX} ${original.message}`, { cause: original });
  annotated.name = original.name;
  if (original.stack !== undefined) annotated.stack = original.stack;
  // Carry every own property (status, headers, error, requestID, …) so the
  // retry/pause classifiers see the same signals they would without annotation.
  for (const key of Object.getOwnPropertyNames(original) as Array<keyof Error>) {
    if (key === 'message' || key === 'stack') continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor !== undefined) Object.defineProperty(annotated, key, descriptor);
  }
  return annotated;
}
