/**
 * Error classifier: maps any thrown value to a typed ClassifiedError.
 *
 * Classification priority (most specific first):
 *  1. BudgetExceededError
 *  2. UnsupportedProviderConfigError
 *  3. HookBlockedError
 *  4. TimeoutError
 *  5. HTTP 401 / AuthenticationError name
 *  5b. Usage limit (UsageLimitError, or a raw ChatGPT usage_limit_reached body)
 *  6. HTTP 429 / rate-limit message
 *  6b. HTTP 529 / 503 (API overloaded)
 *  7. Not-in-git-repo message
 *  8. Network error
 *  9. unknown fallback
 *
 * @module cli/errors/classifier
 */

import { BudgetExceededError, HookBlockedError, TimeoutError, UnsupportedProviderConfigError, errorMessage } from '../../utils/errors.js';

/**
 * Check if the error carries Anthropic SDK error structure.
 *
 * Real `@anthropic-ai/sdk` errors (source: node_modules/@anthropic-ai/sdk/src/core/error.ts)
 * store the raw response body in `.error`, giving the envelope shape:
 *   `err.error = { type: 'error', error: { type: 'authentication_error', ... } }`
 * Real OpenAI SDK errors (source: node_modules/openai/src/core/error.ts) unwrap one
 * level in `generate()` before storing, so `.error` is flat:
 *   `err.error = { type: 'invalid_request_error', ... }`
 *
 * We gate on `err.error.type === 'error'` (the Anthropic envelope sentinel) and read
 * the discriminating type from `err.error.error.type`. Flat shapes are excluded,
 * so OpenAI errors can never match even when their type string is in the Anthropic set.
 */
function isAnthropicSdkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const outer = (err as Record<string, unknown>)['error'];
  if (!outer || typeof outer !== 'object') return false;
  // The Anthropic SDK wraps the response body: outer.type === 'error' and
  // the real type is nested one level deeper in outer.error.type.
  const outerType = (outer as Record<string, unknown>)['type'];
  if (outerType !== 'error') return false; // Not the Anthropic envelope shape
  const inner = (outer as Record<string, unknown>)['error'];
  if (!inner || typeof inner !== 'object') return false;
  const type = (inner as Record<string, unknown>)['type'];
  return typeof type === 'string' && (
    type === 'authentication_error' ||
    type === 'permission_error' ||
    type === 'overloaded_error' ||
    type === 'api_error' ||
    type === 'rate_limit_error' ||
    type === 'invalid_request_error' ||
    type === 'not_found_error'
  );
}
/**
 * True when an error carries the Anthropic 403 body
 * (`{ type: 'error', error: { type: 'permission_error' } }`).
 */
function hasAnthropicPermissionBody(err: unknown): boolean {
  const body = (err as Record<string, unknown>)['error'];
  if (!body || typeof body !== 'object') return false;
  const inner = (body as Record<string, unknown>)['error'];
  return !!inner && typeof inner === 'object' && (inner as Record<string, unknown>)['type'] === 'permission_error';
}
import { isRateLimitError, isNetworkError } from '../../utils/error-classifiers.js';
import { usageLimitInfoOf } from '../../agent/usage/usage-limit-info.js';
import { describeUsageLimit } from '../../agent/usage/usage-formatter.js';
import { DaemonAlreadyRunningError } from '../../agent/daemon-instance.lock.js';

type ErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'usage_limit'
  | 'overloaded'
  | 'budget_exceeded'
  | 'unsupported_config'
  | 'hook_blocked'
  | 'timeout'
  | 'network'
  | 'not_git_repo'
  | 'daemon_already_running'
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
  // 0. DaemonAlreadyRunningError — exit 2 so scripts/service managers can
  // distinguish "already running" from a crash (exit 1). ownerPid is surfaced
  // in the hint so the operator knows which process to stop.
  if (err instanceof DaemonAlreadyRunningError) {
    const pidHint = err.ownerPid !== null
      ? `Daemon PID ${err.ownerPid} is already running. Stop it with \`afk daemon stop\` before starting a new one.`
      : 'Another afk daemon is already running. Stop it with `afk daemon stop` before starting a new one.';
    return {
      kind: 'daemon_already_running',
      userMessage: err.message,
      hint: pidHint,
      exitCode: 2,
      raw: err,
    };
  }

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
  const message = errorMessage(err);
  const lowerMsg = message.toLowerCase();

  // 5. HTTP 401 / AuthenticationError
  // Architecture rule: @anthropic-ai/sdk must not be imported outside
  // src/agent/providers/ — so we cannot use `instanceof AuthenticationError`.
  // SDK error instances inherit `.name === 'Error'` (the SDKs do not set it),
  // so `err.constructor.name` is what matches a real SDK error; the `.name`
  // check covers errors that set it explicitly. Class names survive the build
  // (scripts/build-dist.mjs sets `minifyIdentifiers: false`).
  if (
    errObj['status'] === 401 ||
    (err instanceof Error && (err.name === 'AuthenticationError' || err.constructor.name === 'AuthenticationError'))
  ) {
    const isAnthropic = isAnthropicSdkError(err);
    return {
      kind: 'auth',
      userMessage: 'Authentication failed. Check that your API key is valid and has not expired.',
      hint: isAnthropic
        ? 'Verify the ANTHROPIC_API_KEY environment variable or run `afk login --force`.'
        : 'Check the API key for your configured provider (OPENAI_API_KEY, per-slot AFK_MODEL_<TIER>_API_KEY, or XAI_API_KEY). Run `afk doctor` for credential diagnostics.',
      exitCode: 1,
      raw: err,
    };
  }

  // 5a. Anthropic PermissionDeniedError (seat removed, subscription inactive)
  // See comment at §5 above: .name + constructor.name used instead of instanceof
  // to avoid an SDK import outside src/agent/providers/. The OpenAI SDK also
  // has a PermissionDeniedError class, so both arms require the Anthropic 403
  // body shape (`{ type: 'error', error: { type: 'permission_error' } }`);
  // an OpenAI 403 must not receive seat-removal guidance.
  if (
    err instanceof Error &&
    (err.name === 'PermissionDeniedError' || err.constructor.name === 'PermissionDeniedError') &&
    hasAnthropicPermissionBody(err)
  ) {
    return {
      kind: 'auth',
      userMessage: 'Access denied (HTTP 403). Your account seat may have been removed or subscription access is inactive.',
      hint: 'Check your subscription at https://console.anthropic.com/settings/billing, or switch accounts with `afk login --force`.',
      exitCode: 1,
      raw: err,
    };
  }

  // 5b. Usage limit. Above the generic 429 branch so a provider-labeled
  // usage limit never reads as an "Anthropic rate limit". Matches a raw
  // ChatGPT body even with no status (a mid-stream error).
  const usageLimit = usageLimitInfoOf(err);
  if (usageLimit !== null) {
    const isAnthropic = usageLimit.provider === 'anthropic';
    return {
      kind: 'usage_limit',
      userMessage: `${describeUsageLimit(usageLimit)}.`,
      hint: isAnthropic && usageLimit.kind === 'credit'
        ? 'Top up at https://console.anthropic.com/settings/billing, or switch to your Claude subscription.'
        : isAnthropic
          ? 'Wait for the reset, switch account with `claude login`, or switch model with /model, then resend.'
          : 'Wait for the reset, or switch model with /model, then resend.',
      exitCode: 1,
      raw: err,
    };
  }

  // 6. HTTP 429 / rate limit
  if (errObj['status'] === 429 || isRateLimitError(err)) {
    return {
      kind: 'rate_limit',
      // Provider-neutral: subscription usage limits are caught by the
      // usage_limit branch above, so this is a plain throttle from any provider.
      userMessage: 'Rate limit reached. The request was rejected (HTTP 429).',
      hint: 'Wait a moment and retry, or reduce the request frequency.',
      exitCode: 1,
      raw: err,
    };
  }

  // 6b. HTTP 529 (overloaded) / HTTP 503 (service unavailable)
  if (errObj['status'] === 529 || errObj['status'] === 503) {
    const code = errObj['status'] as number;
    const isAnthropic = isAnthropicSdkError(err);
    return {
      kind: 'overloaded',
      userMessage: isAnthropic
        ? `Anthropic API is temporarily overloaded (HTTP ${code}). All retry attempts were exhausted.`
        : `API is temporarily overloaded (HTTP ${code}). All retry attempts were exhausted.`,
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
  const unknownMsg = errorMessage(err);
  return {
    kind: 'unknown',
    userMessage: unknownMsg || 'An unexpected error occurred.',
    hint: 'If this keeps happening, check `afk trace show` for the full error or try `afk doctor`.',
    exitCode: 1,
    raw: err,
  };
}
