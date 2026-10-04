/**
 * Copy for the Telegram "Usage paused" message.
 *
 * Extracted from `streaming.handlers.ts` so the provider-aware wording lives
 * in one pure function. The Claude account-switch hint ("log in with a
 * different Claude account") only applies to Anthropic, so it shows for
 * `provider: 'anthropic'` or an absent provider (legacy events) and never for
 * another provider, whose name heads the message instead.
 *
 * @module telegram/streaming.paused-copy
 */

import type { UsageLimitProvider } from '../utils/errors.js';
import { usageLimitProviderName } from '../agent/usage/usage-formatter.js';

/** Inputs for {@link pausedMessage}. */
export interface PausedCopyInput {
  timeStr: string | null;
  minutesRemaining: number | null;
  autoResume: boolean;
  accountId?: string;
  provider?: UsageLimitProvider;
  plan?: string;
}

/** Render the initial `paused` message body (Telegram markdown). */
export function pausedMessage(input: PausedCopyInput): string {
  const { timeStr, minutesRemaining, autoResume } = input;
  const isAnthropic = input.provider === undefined || input.provider === 'anthropic';
  const accountLine = input.accountId ? `\n\nAccount: ${input.accountId}` : '';
  const limitLine = isAnthropic
    ? ''
    : `\n\n${usageLimitProviderName(input.provider)} usage limit reached${input.plan !== undefined ? ` (${input.plan} plan)` : ''}.`;
  const head = `⏸ **Usage paused**${limitLine}${accountLine}`;
  if (timeStr !== null && minutesRemaining !== null) {
    const reset = `Resets at ${timeStr} (in ~${minutesRemaining} min).`;
    return autoResume
      ? `${head}\n\n${reset}\n\nI'll auto-resume when the limit resets — no need to retype.`
      : `${head}\n\n${reset}\n\nWait for the limit to reset, then send again — or abort and retry later.`;
  }
  if (autoResume && isAnthropic) {
    return `${head}\n\nNo reset time available. I'll resume automatically if you log in with a different Claude account — or abort and retry later.`;
  }
  if (autoResume) {
    return `${head}\n\nNo reset time available. I'll retry automatically until the limit lifts, or abort and retry later.`;
  }
  return `${head}\n\nNo reset time available. Wait for the limit to reset, then send again — or abort and retry later.`;
}
