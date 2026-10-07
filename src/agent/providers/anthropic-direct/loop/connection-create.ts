import type { AnthropicMessagesCreateParams } from '../types.js';
import { sleepWithAbort } from '../../shared/sleep-with-abort.js';
import { jitterBackoff } from '../overload-pause.js';
import { OVERLOAD_BASE_DELAY_MS, OVERLOAD_MAX_RETRIES, isTransientServerError } from './retry-budget.js';
import { CONNECTION_ERROR_BASE_DELAY_MS, CONNECTION_ERROR_MAX_RETRIES, isConnectionPhaseNetworkError, isConnectionTimeoutError, isRetryableConnectionStatus } from './connection-error.js';
import { ConnectionRetryBudget, connectionFailureMetadata } from '../../shared/connection-retry-budget.js';

export class ConnectionOverloadExhaustedError extends Error {
  constructor() { super('Connection-phase overload budget exhausted'); this.name = 'ConnectionOverloadExhaustedError'; }
}

export interface ConnectionRetryInfo { attempt: number; delayMs: number; error: Error }
export interface ConnectionLifecycleInfo {
  phase: 'connection_failure' | 'connection_recovered' | 'connection_budget_exhausted';
  metadata: Record<string, string | number | boolean>;
}

export async function createWithRetry(
  client: { messages: { create(params: unknown, opts: unknown): unknown }; baseURL?: string },
  params: AnthropicMessagesCreateParams,
  headers: Record<string, string>,
  requestSignal: AbortSignal,
  turnSignal: AbortSignal,
  onConnectionRetry?: (info: ConnectionRetryInfo) => void,
  onLifecycle?: (info: ConnectionLifecycleInfo) => void,
): Promise<AsyncIterable<unknown>> {
  const budget = new ConnectionRetryBudget();
  let overloadAttempts = 0;
  let connectionAttempts = 0;
  let delay = 0;
  let lastConnectionError: Error | undefined;
  const notify = (info: ConnectionLifecycleInfo): void => {
    try { onLifecycle?.(info); } catch { /* INV-040: diagnostics never affect control flow */ }
  };
  for (;;) {
    if (delay > 0) {
      await sleepWithAbort(delay, turnSignal);
      if (turnSignal.aborted) throw new Error('aborted');
      if (lastConnectionError && budget.budgetMs !== undefined && !budget.canRetry(0, 0)) {
        notify({ phase: 'connection_budget_exhausted', metadata: connectionFailureMetadata(lastConnectionError, budget, client.baseURL) });
        throw lastConnectionError;
      }
    }
    try {
      // Invariant: tools execute client-side only after consumeRoundStream completes
      // (loop.ts -> runToolRound). Reopening before receiving the stream cannot replay tool side effects.
      const stream = await Promise.resolve(client.messages.create(params, { headers, signal: requestSignal })) as AsyncIterable<unknown>;
      if (connectionAttempts) notify({ phase: 'connection_recovered', metadata: { attempts: connectionAttempts + 1, outageMs: budget.elapsedMs() } });
      return stream;
    } catch (err) {
      if (requestSignal.aborted || turnSignal.aborted) throw err;
      const e = err instanceof Error ? err : new Error(String(err));
      if (isTransientServerError(e)) {
        lastConnectionError = undefined;
        if (overloadAttempts >= OVERLOAD_MAX_RETRIES) throw new ConnectionOverloadExhaustedError();
        overloadAttempts++;
        delay = jitterBackoff(OVERLOAD_BASE_DELAY_MS * Math.pow(2, overloadAttempts - 1));
        continue;
      }
      if (isConnectionPhaseNetworkError(e) || isConnectionTimeoutError(e) || isRetryableConnectionStatus(e)) {
        notify({ phase: 'connection_failure', metadata: connectionFailureMetadata(e, budget, client.baseURL) });
        if (budget.canRetry(connectionAttempts, CONNECTION_ERROR_MAX_RETRIES)) {
          lastConnectionError = e;
          delay = budget.delay(jitterBackoff(CONNECTION_ERROR_BASE_DELAY_MS * Math.pow(2, connectionAttempts)), CONNECTION_ERROR_BASE_DELAY_MS, connectionAttempts);
          connectionAttempts++;
          onConnectionRetry?.({ attempt: connectionAttempts, delayMs: delay, error: e });
          continue;
        }
        notify({ phase: 'connection_budget_exhausted', metadata: connectionFailureMetadata(e, budget, client.baseURL) });
      }
      throw e;
    }
  }
}
