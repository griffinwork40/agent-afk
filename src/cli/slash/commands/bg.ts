/**
 * /bg — start a turn directly in the background.
 *
 * Usage: /bg <prompt>
 *
 * Immediately registers a background task, starts the SDK stream, and
 * returns control to the REPL. The stream consumes in a floating promise;
 * completion notifications surface between prompts.
 */

import { palette } from '../../palette.js';
import type { SlashCommand } from '../types.js';
import {
  BackgroundTaskManager,
  createBackgroundSink,
  detachStreamToBackground,
} from '../../commands/interactive/background.js';

let bgManagerRef: BackgroundTaskManager | undefined;

export function setBgManager(manager: BackgroundTaskManager): void {
  bgManagerRef = manager;
}

export const bgCmd: SlashCommand = {
  name: '/bg',
  summary: 'Start a turn in the background',
  usage: '/bg <prompt>',
  hint: 'When you want a long task to run while you keep typing — completion lands in the next prompt as a notification card.',
  async handler(ctx, args) {
    const prompt = args.trim();
    if (!prompt) {
      ctx.out.info('Usage: /bg <prompt>');
      return 'continue';
    }
    if (!bgManagerRef) {
      ctx.out.error('Background tasks not available in this session.');
      return 'continue';
    }

    const label = prompt.slice(0, 40);
    const task = bgManagerRef.register(label);
    const bgSink = createBackgroundSink(task, bgManagerRef);
    const stream = ctx.session.current.sendMessageStream(prompt);

    detachStreamToBackground(stream, '', prompt, task, bgManagerRef, bgSink, ctx.stats, undefined, ctx.session.current.abortSignal);

    ctx.out.line(palette.dim(`  → backgrounded as ${task.id}: ${label}`));
    return 'continue';
  },
};
