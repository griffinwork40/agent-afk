/**
 * Hot-reload engine for `/afk-md` — re-read AFK.md from disk and push the
 * recomposed system prompt into the RUNNING session.
 *
 * This is the capability Claude Code's `/memory` does not have: there, an edited
 * CLAUDE.md only applies to sessions started afterwards. Shared by the `edit`,
 * `add`, and `reload` subcommands so all three apply changes identically.
 *
 * @module cli/slash/commands/afk-md/reload
 */

import { loadAfkMd } from '../../../config/afk-md-tier.js';
import { resetAfkMdCache } from '../../../config/afk-md-tier.js';
import { _resetConfigCache } from '../../../config.js';
import { resolveBaseSystemPrompt } from '../../../shared-helpers.js';
import { estimateTokens } from '../../../../agent/memory/index.js';
import type { SlashContext } from '../../types.js';

export interface ReloadOutcome {
  /** True when the live session's prompt was actually swapped. */
  applied: boolean;
  /** Estimated tokens of the overlay now in effect. */
  tokens: number;
  /** Signed token delta vs. the overlay measured before the change. */
  delta: number;
  /** Provenance string, e.g. `framework+afk-md:/a/AFK.md+afk-md:/b/AFK.md`. */
  source: string;
}

/**
 * Estimated tokens of the currently-cached overlay. Call BEFORE mutating the
 * file to capture the baseline for a delta.
 */
export function currentOverlayTokens(): number {
  const loaded = loadAfkMd();
  return loaded ? estimateTokens(loaded.content) : 0;
}

/**
 * Re-read AFK.md and apply the recomposed prompt to the live session.
 *
 * Invariant (ordering is externally governed by the config-cache contract, and
 * every step below depends on the previous one having already run):
 *
 *   1. BUST the cache. `loadAfkMd()` memoizes into a module-scope `afkMdCache`
 *      that lives for the whole process, and nothing at runtime invalidates it —
 *      it was previously reset only by tests. Skipping this step makes every
 *      later read return the PRE-EDIT text, so the command would cheerfully
 *      report a successful reload while applying nothing.
 *   2. RE-DERIVE through `resolveBaseSystemPrompt()`, never by hand. That helper
 *      returns the FULL composed prompt: the framework doctrine
 *      (`prompts/system-prompt.md`) plus the operator overlay under the
 *      `# Operator configuration` header. Passing the bare `loadAfkMd().content`
 *      instead would replace the entire system prompt with just the AFK.md text
 *      and silently delete the framework doctrine from the running session.
 *   3. APPLY, and only then report. `setSystemPrompt` returns whether the live
 *      swap actually happened; the caller must not print a success line before
 *      this call returns, and must not claim a reload when it returns false.
 *
 * `resetAfkMdCache()` is the narrowest correct bust: only the AFK.md tier can
 * have changed on disk, and the env/json tiers are strictly higher priority — if
 * either of them supplies `systemPrompt`, the AFK.md tier is not consulted at
 * all and this whole path is inert anyway. `_resetConfigCache()` is called as
 * well because `loadConfig()` memoizes the COMPOSED result separately, and
 * `resolveBaseSystemPrompt()` reads through it — busting only the leaf would
 * leave the composed layer stale.
 */
export function applyReload(ctx: SlashContext, baselineTokens: number): ReloadOutcome {
  // Step 1 — bust before any read.
  resetAfkMdCache();
  _resetConfigCache();

  // Step 2 — re-derive the FULL composed prompt (framework + overlay).
  const { prompt, source } = resolveBaseSystemPrompt();
  const loaded = loadAfkMd();
  const tokens = loaded ? estimateTokens(loaded.content) : 0;

  // Step 3 — apply, then report what actually happened.
  const applied = ctx.session.current.setSystemPrompt(prompt);

  return { applied, tokens, delta: tokens - baselineTokens, source };
}

/** Format the signed delta for display: `+180`, `-42`, or `no size change`. */
export function formatDelta(delta: number): string {
  if (delta === 0) return 'no size change';
  return delta > 0 ? `+${delta}` : `${delta}`;
}
