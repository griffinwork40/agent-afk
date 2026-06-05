/**
 * /attach — view the output of a background task.
 *
 * Usage: /attach <id>
 *
 * For completed tasks, replays the full resultText. For running tasks,
 * tells the user the task is still in progress.
 */

import { palette } from '../../palette.js';
import { renderMarkdownToTerminal } from '../../formatter.js';
import type { SlashCommand } from '../types.js';
import type { BackgroundTaskManager } from '../../commands/interactive/background.js';

let bgManagerRef: BackgroundTaskManager | undefined;

export function setAttachManager(manager: BackgroundTaskManager): void {
  bgManagerRef = manager;
}

export const attachCmd: SlashCommand = {
  name: '/attach',
  summary: 'View output of a background task',
  hint: 'When a /bg task has completed and you want to read its full output inline rather than just the notification card.',
  usage: '/attach <id>',
  async handler(ctx, args) {
    const id = args.trim();
    if (!id) {
      ctx.out.info('Usage: /attach <id>  (use /tasks to see IDs)');
      return 'continue';
    }
    if (!bgManagerRef) {
      ctx.out.error('Background tasks not available in this session.');
      return 'continue';
    }

    const task = bgManagerRef.get(id);
    if (!task) {
      ctx.out.error(`No task found with ID "${id}".`);
      return 'continue';
    }

    if (task.status === 'running') {
      const desc = task.progressDescription ? ` — ${task.progressDescription}` : '';
      ctx.out.info(`Task ${task.id} is still running${desc}. Use /tasks to check progress.`);
      return 'continue';
    }

    ctx.out.line(palette.dim(`  ─── ${task.id} ${task.label} (${task.status}) ───`));
    ctx.out.line('');

    if (task.resultText) {
      const rendered = renderMarkdownToTerminal(task.resultText);
      for (const line of rendered.split('\n')) {
        ctx.out.line(line);
      }
    } else if (task.error) {
      ctx.out.error(task.error.message);
    } else {
      ctx.out.info('No output captured.');
    }

    return 'continue';
  },
};
