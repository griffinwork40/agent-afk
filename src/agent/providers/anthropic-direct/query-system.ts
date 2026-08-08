import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { getCacheTtl, isCacheEnabled, withSystemBreakpoint } from './cache-policy.js';
import { buildAfkModeAddendumBlock } from './afk-mode-addendum.js';
import { buildPlanModeAddendumBlock } from './plan-mode-addendum.js';
import { refreshEnvironmentDate } from '../shared/date-rollover.js';
import type { SessionState } from './query/session-state.js';

/**
 * Build the Anthropic Messages `system` parameter for the current turn.
 *
 * The provider keeps user-system text mutable so date rollover, `/cd`, and
 * `/afk-md` hot-reload can refresh it without resetting conversation history.
 * Permission-mode addenda are appended last so the prompt-cache breakpoint lands
 * on the active posture block.
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

  const blocks: ContentBlockParam[] = [];
  if (systemPrefix && systemPrefix.length > 0) blocks.push(...systemPrefix);
  if (state.userSystem && state.userSystem.length > 0) {
    blocks.push({ type: 'text', text: state.userSystem });
  }

  const planBlock = buildPlanModeAddendumBlock(state.currentPermissionMode);
  if (planBlock !== null) blocks.push(planBlock);
  const afkBlock = buildAfkModeAddendumBlock(state.currentPermissionMode);
  if (afkBlock !== null) blocks.push(afkBlock);

  if (blocks.length === 0) return null;
  if (!isCacheEnabled({ baseUrl })) return blocks;
  return withSystemBreakpoint(blocks, getCacheTtl());
}
