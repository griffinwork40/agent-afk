/**
 * Surface-agnostic usage-limit detection for thrown errors.
 *
 * Contract: returns the provider-neutral {@link UsageLimitInfo} for
 *   - a {@link UsageLimitError} (the provider layer's terminal wrap), or
 *   - a raw ChatGPT/Codex `usage_limit_reached` error that escaped unwrapped
 *     (any body nesting, with or without an HTTP status, since a mid-stream
 *     error carries none), parsed by the provider's own classifier,
 * and `null` for anything else, including a plain 429. Shared by the CLI
 * error classifier and Telegram's error replies. No SDK import.
 *
 * @module agent/usage/usage-limit-info
 */

import { UsageLimitError, type UsageLimitInfo } from '../../utils/errors.js';
import { classifyChatGptUsageLimit } from '../providers/openai-compatible/query/chatgpt-usage-limit.js';
import { describeUsageLimit } from './usage-formatter.js';

/** Usage-limit facts for `err`, or `null` when it is not a usage limit. */
export function usageLimitInfoOf(err: unknown, now: number = Date.now()): UsageLimitInfo | null {
  if (err instanceof UsageLimitError) return err.info;
  const codex = classifyChatGptUsageLimit(err, now);
  if (codex === null) return null;
  return {
    provider: 'codex',
    kind: 'subscription',
    ...(codex.resetsAt !== undefined ? { resetsAt: codex.resetsAt } : {}),
    ...(codex.plan !== undefined ? { plan: codex.plan } : {}),
  };
}

/**
 * Return `err` as a {@link UsageLimitError} when it is a usage limit that
 * escaped the provider layer unwrapped (a raw ChatGPT body), else `err`
 * unchanged. Lets a surface's terminal error path show the friendly sentence.
 */
export function normalizeUsageLimitError(err: unknown, now: number = Date.now()): unknown {
  if (err instanceof UsageLimitError) return err;
  const info = usageLimitInfoOf(err, now);
  return info === null ? err : new UsageLimitError(describeUsageLimit(info, now), info, { cause: err });
}
