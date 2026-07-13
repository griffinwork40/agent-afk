/**
 * Error classifier: maps any thrown value to a typed ClassifiedError.
 *
 * Classification priority (most specific first):
 *  1. BudgetExceededError
 *  2. UnsupportedProviderConfigError
 *  3. HookBlockedError
 *  4. TimeoutError
 *  5. HTTP 401 / AuthenticationError name
 *  6. HTTP 429 / rate-limit message
 *  6b. HTTP 529 / 503 (API overloaded)
 *  7. Not-in-git-repo message
 *  8. Network error
 *  9. unknown fallback
 *
 * @module cli/errors/classifier
 */

import {
  BudgetExceededError,
  UnsupportedProviderConfigError,
  HookBlockedError,
  TimeoutError,
} from '../../utils/errors.js';
import { isRateLimitError, isNetworkError } from '../../utils/error-classifiers.js';

type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'budget_exceeded'
  | 'unsupported_config'
  | 'hook_blocked'
  | 'timeout'
  | 'network'
  | 'not_git_repo'
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  userMessage: string;
  hint?: string;
  exitCode: number;
  /** The original thrown value — held by reference, not serialized. */
  raw: unknown;
}

/**
 * Classify any thrown value and return a user-facing ClassifiedError.
 * Never throws.
 */
export function classifyError(err: unknown): ClassifiedError {
  // 1. BudgetExceededError
  if (err instanceof BudgetExceededError) {
    return {
      kind: 'budget_exceeded',
      userMessage: `Session stopped: cost ceiling reached ($${err.runningCostUsd.toFixed(4)} of $${err.maxBudgetUsd.toFixed(4)} limit).`,
      exitCode: 1,
      raw: err,
    };
  }

  // 2. UnsupportedProviderConfigError
  if (err instanceof UnsupportedProviderConfigError) {
    return {
      kind: 'unsupported_config',
      userMessage: `The "${err.provider}" provider does not support this configuration option.`,
      hint: `Option "${err.field}" is not available for provider "${err.provider}". Switch to a compatible provider or remove the option.`,
      exitCode: 1,
      raw: err,
    };
  }

  // 3. HookBlockedError
  if (err instanceof HookBlockedError) {
    return {
      kind: 'hook_blocked',
      userMessage: `A hook blocked the operation (event: ${err.event}).`,
      ...(err.reason !== undefined ? { hint: err.reason } : {}),
      exitCode: 1,
      raw: err,
    };
  }

  // 4. TimeoutError
  if (err instanceof TimeoutError) {
    const secs = Math.round(err.timeoutMs / 1000);
    return {
      kind: 'timeout',
      userMessage: `The operation timed out after ${secs} second${secs !== 1 ? 's' : ''}.`,
      hint: `Timeout: ${err.timeoutMs}ms (${secs}s). Increase the timeout or retry.`,
      exitCode: 124,
      raw: err,
    };
  }

  // From here on, work with the error as an object (may not be an Error instance)
  const errObj = err as Record<string, unknown>;
  const message = err instanceof Error ? err.message : String(err);
  const lowerMsg = message.toLowerCase();

  // 5. HTTP 401 / AuthenticationError
  if (
    errObj['status'] === 401 ||
    (err instanceof Error && err.name === 'AuthenticationError')
  ) {
    return {
      kind: 'auth',
      userMessage: 'Authentication failed. Check that your API key is valid and has not expired.',
      hint: 'Verify the ANTHROPIC_API_KEY environment variable or run `afk login`.',
      exitCode: 1,
      raw: err,
    };
  }

  // 6. HTTP 429 / rate limit
  if (errObj['status'] === 429 || isRateLimitError(err)) {
    return {
      kind: 'rate_limit',
      userMessage: 'Anthropic rate limit reached. The request was rejected (HTTP 429).',
      hint: 'Wait a moment and retry, or reduce the request frequency.',
      exitCode: 1,
      raw: err,
    };
  }

  // 6b. HTTP 529 (overloaded) / HTTP 503 (service unavailable)
  if (errObj['status'] === 529 || errObj['status'] === 503) {
    const code = errObj['status'] as number;
    return {
      kind: 'overloaded',
      userMessage: `Anthropic API is temporarily overloaded (HTTP ${code}). All retry attempts were exhausted.`,
      hint: 'Wait a minute and try again, or switch to a less loaded model (e.g. sonnet).',
      exitCode: 1,
      raw: err,
    };
  }

  // 7. Not-in-git-repo
  if (
    message === 'Not in a git repository.' ||
    lowerMsg.includes('not in a git repository')
  ) {
    return {
      kind: 'not_git_repo',
      userMessage: 'This command must be run from inside a git repository.',
      hint: 'Run `git init` to initialise a repository, or change to a directory that is already a git repo.',
      exitCode: 1,
      raw: err,
    };
  }

  // 8. Network error
  if (isNetworkError(err) || lowerMsg.includes('econnrefused') || lowerMsg.includes('etimedout')) {
    return {
      kind: 'network',
      userMessage: 'Network error: unable to reach the API endpoint.',
      hint: 'Check your internet connection and try again.',
      exitCode: 1,
      raw: err,
    };
  }

  // 9. Fallback — unknown
  const unknownMsg = err instanceof Error ? err.message : String(err);
  return {
    kind: 'unknown',
    userMessage: unknownMsg || 'An unexpected error occurred.',
    exitCode: 1,
    raw: err,
  };
}
