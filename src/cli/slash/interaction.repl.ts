import ora from 'ora';
import { renderSelector } from '../input/selectors.js';
import { palette } from '../palette.js';
import { REPL_SPINNER_OPTIONS } from '../commands/interactive/shared.js';
import type { Choose, ProgressEvent } from './interaction.js';
import type { SlashContext } from './types.js';

/** Late-bound compositor lookup: bootstrap precedes REPL compositor arming. */
export function createReplInteractions(ctx: Pick<SlashContext, 'out' | 'getCompositor'>): {
  choose: Choose;
  progress: (event: ProgressEvent) => void;
} {
  const active = new Map<string, { stop: () => void; update: (label: string) => void }>();
  const choose: Choose = async (request) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || request.options.length === 0) return null;
    // renderSelector starts at index zero. Move the default there without
    // conflating labels with values, or changing the caller's request object.
    const options = [...request.options];
    const initial = options.findIndex((option) => option.value === request.default);
    if (initial > 0) options.unshift(...options.splice(initial, 1));
    const compositor = ctx.getCompositor?.() ?? null;
    compositor?.suspendInput();
    try {
      ctx.out.info(request.title);
      const index = await renderSelector(options.map((option) =>
        option.description ? `${option.label} — ${option.description}` : option.label,
      ), new AbortController().signal);
      return typeof index === 'number' ? (options[index]?.value ?? null) : null;
    } finally {
      compositor?.resumeInput();
    }
  };
  const progress = (event: ProgressEvent): void => {
    if (event.phase === 'end') {
      active.get(event.corrId)?.stop();
      active.delete(event.corrId);
      return;
    }
    const current = active.get(event.corrId);
    if (current) { current.update(event.label); return; }
    if (event.phase !== 'start') return;
    const compositor = ctx.getCompositor?.() ?? null;
    if (compositor) {
      ctx.out.info(event.label);
      compositor.setSpinner({ enabled: true });
      active.set(event.corrId, {
        stop: () => { if (active.size === 1) compositor.setSpinner({ enabled: false }); },
        update: (label) => ctx.out.info(label),
      });
    } else if (process.stdin.isTTY && process.stdout.isTTY) {
      const spinner = ora({ text: palette.meta(event.label), ...REPL_SPINNER_OPTIONS }).start();
      active.set(event.corrId, {
        stop: () => { spinner.stop(); },
        update: (label) => { spinner.text = palette.meta(label); },
      });
    } else {
      ctx.out.info(event.label);
      active.set(event.corrId, { stop: () => {}, update: (label) => ctx.out.info(label) });
    }
  };
  return { choose, progress };
}
