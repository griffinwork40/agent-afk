import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { getCacheTtl, isCacheEnabled, withSystemBreakpoint } from './cache-policy.js';
import { buildAfkModeAddendumBlock } from './afk-mode-addendum.js';
import { buildPlanModeAddendumBlock } from './plan-mode-addendum.js';
import { refreshEnvironmentDate } from '../shared/date-rollover.js';
import type { SessionState } from './query/session-state.js';

/**
 * Boundary used by `assembleSystemPrompt` (query/system-prompt.ts) to
 * separate the stable prefix from the `# Environment` section.
 *
 * Parts are joined with `\n\n`, so the environment section always starts
 * with `\n\n# Environment\n`. Searching for this exact prefix lets us
 * cleanly split the assembled string into:
 *
 *   stable prefix — toolBase + doctrine + memoryPrompt + workspacePrompt
 *                   + hotMemory + goalPrompt
 *   volatile tail — `# Environment` block + manifest (if any)
 *
 * The split boundary is exported so tests can assert on it directly.
 */
export const ENV_SPLIT_MARKER = '\n\n# Environment\n';

/**
 * Split `assembled` at the `# Environment` boundary produced by
 * `assembleSystemPrompt`.
 *
 * Returns `{ stablePrefix, volatileTail }` when the marker is found, or
 * `null` when the string contains no environment section (e.g. a minimal
 * test prompt that skips the assembler entirely). The split is exclusive —
 * neither half contains the `\n\n` separator itself; the tail starts at
 * `# Environment`.
 *
 * Non-throwing: a prompt with no environment section is treated as fully
 * stable and returned as-is via the `null` sentinel so the caller degrades
 * gracefully to a single block.
 */
export function splitAtEnvironmentBoundary(
  assembled: string,
): { stablePrefix: string; volatileTail: string } | null {
  const idx = assembled.lastIndexOf(ENV_SPLIT_MARKER);
  if (idx === -1) return null;
  return {
    stablePrefix: assembled.slice(0, idx),
    volatileTail: assembled.slice(idx + '\n\n'.length), // keeps the leading `# Environment\n`
  };
}

/**
 * Build the Anthropic Messages `system` parameter for the current turn.
 *
 * The provider keeps user-system text mutable so date rollover, `/cd`, and
 * `/afk-md` hot-reload can refresh it without resetting conversation history.
 * Permission-mode addenda are appended last so the prompt-cache breakpoint
 * lands on the active posture block.
 *
 * When caching is enabled and `state.userSystem` contains an `# Environment`
 * section, the assembled string is split into two blocks:
 *
 *   1. **Stable prefix** — framework doctrine, operator overlay, memory
 *      prompt, skill manifest. Carries a `cache_control` breakpoint so the
 *      Anthropic cache can reuse it across sessions, child forks, date
 *      rollovers, and `/cd` changes without paying a full re-write.
 *
 *   2. **Volatile tail** — `# Environment` (cwd, date, session id, git SHA)
 *      plus the manifest. Changes every time the environment changes but
 *      keeps the stable prefix in cache.
 *
 * This uses 2 of the 4 allowed `cache_control` breakpoints:
 *   - one on the stable prefix block (new)
 *   - one on the last block via `withSystemBreakpoint` (existing)
 * The message-tail breakpoint (in `withMessagesBreakpoint`) is unaffected.
 *
 * When the environment section is absent (e.g. a test prompt that bypasses
 * the assembler) the function degrades to the previous single-block behaviour.
 */
export function composeQuerySystem(options: {
  state: SessionState;
  systemPrefix: ContentBlockParam[] | null;
  baseUrl?: string;
}): ContentBlockParam[] | null {
  const { state, systemPrefix, baseUrl } = options;
  if (state.userSystem) {
    state.userSystem = refreshEnvironmentDate(state.userSystem);
  }

  const cacheEnabled = isCacheEnabled({ baseUrl });
  const ttl = cacheEnabled ? getCacheTtl() : undefined;

  const blocks: ContentBlockParam[] = [];
  if (systemPrefix && systemPrefix.length > 0) blocks.push(...systemPrefix);

  if (state.userSystem && state.userSystem.length > 0) {
    if (cacheEnabled) {
      // Attempt a stable/volatile split. When the split succeeds, emit two
      // blocks with an explicit cache breakpoint on the stable prefix so it
      // can be reused across sessions even when the environment changes.
      const split = splitAtEnvironmentBoundary(state.userSystem);
      if (split !== null && split.stablePrefix.length > 0 && split.volatileTail.length > 0) {
        blocks.push({
          type: 'text',
          text: split.stablePrefix,
          cache_control: { type: 'ephemeral', ttl: ttl! },
        });
        blocks.push({ type: 'text', text: split.volatileTail });
      } else {
        // No environment section found — degrade to single block (old behavior).
        blocks.push({ type: 'text', text: state.userSystem });
      }
    } else {
      blocks.push({ type: 'text', text: state.userSystem });
    }
  }

  const planBlock = buildPlanModeAddendumBlock(state.currentPermissionMode);
  if (planBlock !== null) blocks.push(planBlock);
  const afkBlock = buildAfkModeAddendumBlock(state.currentPermissionMode);
  if (afkBlock !== null) blocks.push(afkBlock);

  if (blocks.length === 0) return null;
  if (!cacheEnabled) return blocks;
  return withSystemBreakpoint(blocks, ttl!);
}
