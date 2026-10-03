/**
 * Policy resolver for `autoResumeOnUsageLimit` at fork time.
 *
 * Extracted from {@link import('./fork-child-config.js').assembleChildConfig}
 * to keep that file within the 350 code-line ceiling. The inline comment at
 * line 301 describes the intent; this module is the single implementation.
 *
 * Precedence (highest wins):
 *   1. Explicit caller value (`options.config.autoResumeOnUsageLimit`).
 *   2. `AFK_SUBAGENT_AUTO_RESUME_ON_USAGE_LIMIT` env var (opt-in, default false).
 *   3. Hardcoded false.
 *
 * Hard override: when the resolved child surface is `'daemon'`, the result is
 * always false — no human can switch accounts there, so parking indefinitely
 * would silently stall the daemon without any path to recovery.
 *
 * @module agent/subagent/usage-limit-park-policy
 */

import { env } from '../../config/env.js';
import type { Surface } from '../awareness/types.js';

/**
 * Resolve `autoResumeOnUsageLimit` for a forked child.
 *
 * @param explicitCallerValue - the caller's `options.config.autoResumeOnUsageLimit`;
 *   `undefined` when the caller did not set it.
 * @param childSurface - the effective surface the child will run under.
 * @returns `true` when the child should park-and-wait on a usage-limit 429;
 *   `false` to fail fast (default).
 */
export function resolveChildAutoResume(
  explicitCallerValue: boolean | undefined,
  childSurface: Surface | undefined,
): boolean {
  // Hard override: daemon surface cannot hot-swap accounts — always fail fast.
  if (childSurface === 'daemon') return false;

  // Explicit caller value wins (including explicit false).
  if (explicitCallerValue !== undefined) return explicitCallerValue;

  // Opt-in env var (default false).
  return env.AFK_SUBAGENT_AUTO_RESUME_ON_USAGE_LIMIT === '1';
}
