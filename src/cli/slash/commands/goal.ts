/**
 * /goal — persistent cross-session objective tracking.
 *
 * Usage:
 *   /goal <text>         set a new active goal (replaces any existing)
 *   /goal set <text>     same as above (explicit verb)
 *   /goal status         show the current goal and its status
 *   /goal pause          pause the active goal
 *   /goal resume         resume a paused goal
 *   /goal done           mark the goal as completed
 *   /goal clear          remove the goal entirely
 *   /goal                (no args) — show current goal
 *
 * Goals persist in the durable state store (~/.afk/state/kv/kv.db) and
 * survive across sessions, compaction, and terminal disconnects. The active
 * goal is injected into the system prompt so the model sees it every turn.
 */

import { palette } from '../../palette.js';
import {
  getGoal,
  setGoal,
  pauseGoal,
  resumeGoal,
  completeGoal,
  clearGoal,
} from '../../../agent/goals/index.js';
import type { SlashCommand, SlashContext } from '../types.js';

function statusBadge(status: string): string {
  switch (status) {
    case 'active': return palette.success('● active');
    case 'paused': return palette.warning('◌ paused');
    case 'completed': return palette.meta('✓ completed');
    default: return status;
  }
}

function printGoal(ctx: SlashContext): void {
  const goal = getGoal();
  if (!goal) {
    ctx.out.info('No goal set.  Try  /goal <objective>');
    return;
  }
  ctx.out.line(`${statusBadge(goal.status)}  ${goal.text}`);
  ctx.out.line(palette.meta(`  set ${goal.createdAt}  ·  updated ${goal.updatedAt}`));
}

export const goalCmd: SlashCommand = {
  name: '/goal',
  usage: '/goal [set|status|pause|resume|done|clear] ...',
  summary: 'Persistent objective that survives across sessions',
  hint: 'When you want the agent to track a durable objective across turns, compaction, and session restarts — not just a todo but the overarching goal.',
  async handler(ctx, args) {
    const trimmed = args.trim();

    // No args or "status" → show current goal
    if (!trimmed || trimmed === 'status') {
      printGoal(ctx);
      return 'continue';
    }

    // Parse verb + remainder
    const spaceIdx = trimmed.indexOf(' ');
    const verb = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const rem = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    switch (verb) {
      case 'set': {
        if (!rem) {
          ctx.out.warn('Usage:  /goal set <objective>');
          return 'continue';
        }
        const goal = setGoal(rem, ctx.stats.sessionId);
        ctx.out.success(`Goal set: ${goal.text}`);
        return 'continue';
      }
      case 'pause': {
        const goal = pauseGoal();
        if (!goal) {
          ctx.out.warn('No goal to pause.');
        } else if (goal.status === 'paused') {
          ctx.out.success('Goal paused.');
        } else {
          ctx.out.info(`Goal is ${goal.status}, not active — cannot pause.`);
        }
        return 'continue';
      }
      case 'resume': {
        const goal = resumeGoal();
        if (!goal) {
          ctx.out.warn('No goal to resume.');
        } else if (goal.status === 'active') {
          ctx.out.success('Goal resumed.');
        } else {
          ctx.out.info(`Goal is ${goal.status}, not paused — cannot resume.`);
        }
        return 'continue';
      }
      case 'done':
      case 'complete': {
        const goal = completeGoal();
        if (!goal) {
          ctx.out.warn('No goal to complete.');
        } else {
          ctx.out.success(`Goal completed: ${goal.text}`);
        }
        return 'continue';
      }
      case 'clear': {
        const deleted = clearGoal();
        if (deleted) {
          ctx.out.success('Goal cleared.');
        } else {
          ctx.out.info('No goal to clear.');
        }
        return 'continue';
      }
      case 'status': {
        printGoal(ctx);
        return 'continue';
      }
      default: {
        // Bare text without a verb → treat as "set"
        const goal = setGoal(trimmed, ctx.stats.sessionId);
        ctx.out.success(`Goal set: ${goal.text}`);
        return 'continue';
      }
    }
  },
};
