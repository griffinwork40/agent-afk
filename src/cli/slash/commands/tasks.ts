/**
 * /tasks — list background tasks and subagent jobs.
 *
 * Usage:
 *   /tasks          list all background tasks and subagent jobs (recency-desc)
 *   /tasks <id>     show full output of a specific task or job metadata
 *
 * Invariant: subagent job result text is NEVER printed here. Use /bgsub:join
 * <id> to retrieve a subagent result and surface it to the model.
 */

import { palette } from '../../palette.js';
import { formatDuration } from '../../format-utils.js';
import type { SlashCommand } from '../types.js';
import type { BackgroundTaskManager } from '../../commands/interactive/background.js';
import type { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
import { type BackgroundItem, itemStartedAt } from '../../background/types.js';

let bgManagerRef: BackgroundTaskManager | undefined;
let bgRegistryRef: BackgroundAgentRegistry | undefined;

export function setTasksManager(manager: BackgroundTaskManager): void {
  bgManagerRef = manager;
}

export function setTasksRegistry(registry: BackgroundAgentRegistry): void {
  bgRegistryRef = registry;
}

/** Reset both refs. Tests use this to isolate module-scope bindings. */
export function resetTasksRefs(): void {
  bgManagerRef = undefined;
  bgRegistryRef = undefined;
}

// Status glyphs — covers both BackgroundTask and BackgroundJob status values.
// BackgroundTask: 'running' | 'succeeded' | 'failed' | 'cancelled'
// BackgroundJob:  'running' | 'completed' | 'failed' | 'cancelled'
const STATUS_GLYPHS: Record<string, string> = {
  running: '◐',
  succeeded: '✓',
  completed: '✓',
  failed: '✗',
  cancelled: '⊘',
};

// Kind-prefix glyphs distinguish the source of each row.
// ▸ = "attached to a turn"  (kind: 'turn')
// ◆ = "background subagent" (kind: 'subagent')
const KIND_GLYPHS = {
  turn: '▸',
  subagent: '◆',
} as const;

export const tasksCmd: SlashCommand = {
  name: '/tasks',
  summary: 'List background tasks and subagent jobs',
  hint: 'When you have running or completed /bg turns and want to see status, IDs, and outputs at a glance.',
  usage: '/tasks [id]',
  async handler(ctx, args) {
    if (!bgManagerRef) {
      ctx.out.error('Background tasks not available in this session.');
      return 'continue';
    }

    const id = args.trim();
    if (id) {
      // Prefer turn-task match (existing behavior wins when ids collide).
      const task = bgManagerRef.get(id);
      if (task) {
        const glyph = STATUS_GLYPHS[task.status] ?? '?';
        ctx.out.line(`  ${KIND_GLYPHS.turn} ${glyph} ${palette.bold(task.id)} ${task.label}`);
        ctx.out.line(`  Status: ${task.status} · ${formatDuration(task.stats.durationMs)}`);
        if (task.resultText) {
          ctx.out.line('');
          const lines = task.resultText.split('\n').slice(0, 20);
          for (const line of lines) ctx.out.line(`  ${line}`);
          if (task.resultText.split('\n').length > 20) {
            ctx.out.line(palette.dim('  ... (truncated)'));
          }
        }
        if (task.error) {
          ctx.out.error(`  Error: ${task.error.message}`);
        }
        return 'continue';
      }

      // Try subagent job match.
      const job = bgRegistryRef?.get(id);
      if (job) {
        const glyph = STATUS_GLYPHS[job.status] ?? '?';
        const elapsed = job.endedAt !== undefined
          ? formatDuration(job.endedAt - job.startedAt)
          : formatDuration(Date.now() - job.startedAt);
        ctx.out.line(`  ${KIND_GLYPHS.subagent} ${glyph} ${palette.bold(job.jobId)} ${job.label}`);
        ctx.out.line(`  Status:   ${job.status} · ${elapsed}`);
        ctx.out.line(`  Subagent: ${job.subagentId}`);
        ctx.out.line(`  Model:    ${job.model}`);
        // INVARIANT: never print job result text from /tasks.
        // The operator must use /bgsub:join <id> to retrieve the result.
        ctx.out.line('');
        ctx.out.line(palette.dim(`  Use /bgsub:join ${id} to wait for and print this subagent's result.`));
        return 'continue';
      }

      ctx.out.error(`No task or job found with ID "${id}".`);
      return 'continue';
    }

    // Build unified list, sorted by recency (newest first).
    const items: BackgroundItem[] = [
      ...(bgManagerRef.all().map(task => ({ kind: 'turn' as const, task }))),
      ...((bgRegistryRef?.list() ?? []).map(job => ({ kind: 'subagent' as const, job }))),
    ].sort((a, b) => itemStartedAt(b) - itemStartedAt(a));

    if (items.length === 0) {
      ctx.out.info(
        "No background tasks. Use Ctrl+B to background a running turn, /bg <prompt>, " +
        "or dispatch a subagent with mode:'background'.",
      );
      return 'continue';
    }

    for (const item of items) {
      if (item.kind === 'turn') {
        const { task } = item;
        const glyph = STATUS_GLYPHS[task.status] ?? '?';
        const elapsed = task.status === 'running'
          ? formatDuration(Date.now() - task.startedAt)
          : formatDuration(task.stats.durationMs);
        const desc = task.progressDescription ? palette.dim(` ${task.progressDescription}`) : '';
        ctx.out.line(
          `  ${KIND_GLYPHS.turn} ${glyph} ${palette.bold(task.id)} ${task.label}${desc} ${palette.dim(elapsed)}`,
        );
      } else {
        const { job } = item;
        const glyph = STATUS_GLYPHS[job.status] ?? '?';
        const elapsed = job.endedAt !== undefined
          ? formatDuration(job.endedAt - job.startedAt)
          : formatDuration(Date.now() - job.startedAt);
        ctx.out.line(
          `  ${KIND_GLYPHS.subagent} ${glyph} ${palette.bold(job.jobId)} ${job.label} ${palette.dim(elapsed)}`,
        );
      }
    }
    return 'continue';
  },
};
