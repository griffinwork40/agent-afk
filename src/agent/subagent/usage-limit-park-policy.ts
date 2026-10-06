/**
 * Policy resolver for `autoResumeOnUsageLimit` at fork time.
 *
 * Extracted from `assembleChildConfig` (fork-child-config.ts) to keep that
 * file within the 350 code-line ceiling. This module is the single
 * implementation of the fork-time precedence.
 *
 * Precedence (highest wins):
 *   1. Explicit caller value (`options.config.autoResumeOnUsageLimit`). This
 *      preserves the pre-existing contract that a caller may opt a child in
 *      explicitly, including unattended daemon flows that prefer waiting over
 *      failing.
 *   2. `AFK_SUBAGENT_AUTO_RESUME_ON_USAGE_LIMIT` (opt-in, default off), EXCEPT
 *      on the `'daemon'` surface: the env default exists so an operator can
 *      rescue parked children by switching Claude Code accounts, and no human
 *      is present to do that in a daemon, so the env default is ignored there.
 *   3. `false` — fail fast and let the parent decide.
 *
 * @module agent/subagent/usage-limit-park-policy
 */

import { env } from '../../config/env.js';
import type { Surface } from '../awareness/types.js';

/** `true` when `AFK_SUBAGENT_AUTO_RESUME_ON_USAGE_LIMIT` is `1` or `true` (case-insensitive). */
export function isSubagentAutoResumeEnvEnabled(): boolean {
  const raw = env.AFK_SUBAGENT_AUTO_RESUME_ON_USAGE_LIMIT;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Resolve `autoResumeOnUsageLimit` for a forked child.
 *
 * @param explicitCallerValue - the caller's `options.config.autoResumeOnUsageLimit`;
 *   `undefined` when the caller did not set it.
 * @param childSurface - the effective surface the child will run under.
 * @returns `true` when the child should park and wait on a usage-limit 429;
 *   `false` to fail fast (default).
 *
 * @note Provider scope: this resolver is **provider-agnostic**. The env var
 * `AFK_SUBAGENT_AUTO_RESUME_ON_USAGE_LIMIT` is documented primarily for the
 * Anthropic keychain hot-swap flow, but the resolved flag is forwarded to the
 * child's `AgentConfig` regardless of which provider the child uses. For
 * OpenAI-compatible children the `resetsAt` timestamp is still emitted on a
 * usage-limit 429, so the sleep-retry pause works correctly; it simply does
 * not benefit from a keychain hot-swap because that mechanism is Anthropic-
 * specific. Operators who set this env var to opt OpenAI-compatible children
 * into park-and-wait should be aware that only the timer path applies there —
 * no account-switch shortcut is available. Gating the env default to Anthropic-
 * resolved forks only would prevent safe reuse on other providers that support
 * the pause protocol, so we document instead of gate.
 */
export function resolveChildAutoResume(
  explicitCallerValue: boolean | undefined,
  childSurface: Surface | undefined,
): boolean {
  if (explicitCallerValue !== undefined) return explicitCallerValue;
  if (childSurface === 'daemon') return false;
  return isSubagentAutoResumeEnvEnabled();
}
