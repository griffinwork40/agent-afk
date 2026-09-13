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
 * goal is injected into the system prompt at session construction; mid-session
 * changes are persisted immediately but take effect on the next session start.
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

    // History: goalPrompt is baked into stableSystemPrefix at session construction
    // (injectGoalPrompt / cwd-dependents.ts). Mid-session writes persist to DB
    // immediately but the running session's prompt is not rebuilt. The UX notes
    // below surface this boundary so users are not surprised.
    const SESSION_NOTE = 'Goal change saved — takes effect at the start of the next session.';

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
        ctx.out.info(SESSION_NOTE);
        return 'continue';
      }
      case 'pause': {
        const result = pauseGoal();
        if (result) {
          ctx.out.success('Goal paused.');
          ctx.out.info(SESSION_NOTE);
        } else {
          const current = getGoal();
          if (!current) ctx.out.warn('No goal to pause.');
          else if (current.status === 'paused') ctx.out.warn('Goal is already paused.');
          else ctx.out.info(`Goal is ${current.status} — cannot pause.`);
        }
        return 'continue';
      }
      case 'resume': {
        const result = resumeGoal();
        if (result) {
          ctx.out.success('Goal resumed.');
          ctx.out.info(SESSION_NOTE);
        } else {
          const current = getGoal();
          if (!current) ctx.out.warn('No goal to resume.');
          else if (current.status === 'active') ctx.out.warn('Goal is already active.');
          else ctx.out.info(`Goal is ${current.status} — cannot resume.`);
        }
        return 'continue';
      }
      case 'done':
      case 'complete': {
        const result = completeGoal();
        if (result) {
          ctx.out.success(`Goal completed: ${result.text}`);
          ctx.out.info(SESSION_NOTE);
        } else {
          const current = getGoal();
          if (!current) ctx.out.warn('No goal to complete.');
          else if (current.status === 'completed') ctx.out.warn('Goal is already completed.');
          else ctx.out.warn(`Goal is ${current.status} — resume it before completing.`);
        }
        return 'continue';
      }
      case 'clear': {
        const deleted = clearGoal();
        if (deleted) {
          ctx.out.success('Goal cleared.');
          ctx.out.info(SESSION_NOTE);
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
        ctx.out.info(SESSION_NOTE);
        return 'continue';
      }
    }
  },
};
