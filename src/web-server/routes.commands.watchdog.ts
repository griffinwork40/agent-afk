/**
 * Inactivity watchdog for web slash commands.
 *
 * Contract: `promise` rejects with `Error('command_timeout')` once the command
 * has shown no sign of life for `idleMs`. Waiting on the operator (a pending
 * `ctx.choose`) and an open `ctx.progress` span both count as life, so a model
 * picker left open or a long `/compact` is never cut off mid-flight, while a
 * command that hangs silently still releases its turn reservation. A fixed
 * wall-clock cap answered 504 while a picker was still on screen and released
 * the reservation while /compact was still running.
 *
 * Call `dispose()` when the command settles; after that the promise never
 * rejects.
 */
import type { ProgressEvent } from '../cli/slash/interaction.js';

export interface CommandWatchdog {
  readonly promise: Promise<never>;
  /** Suspend the idle clock until `work` settles (e.g. a pending choice). */
  hold<T>(work: Promise<T>): Promise<T>;
  /** Track progress spans: start suspends, update re-arms, end resumes. */
  progress(event: Pick<ProgressEvent, 'corrId' | 'phase'>): void;
  dispose(): void;
}

export function createCommandWatchdog(idleMs: number): CommandWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let holds = 0;
  let disposed = false;
  const openSpans = new Set<string>();
  let reject: (err: Error) => void = () => {};
  const promise = new Promise<never>((_, r) => { reject = r; });
  // A race loser may never be awaited again; keep a late rejection quiet.
  promise.catch(() => {});

  const arm = (): void => {
    clearTimeout(timer);
    if (disposed || holds > 0 || openSpans.size > 0) return;
    timer = setTimeout(() => reject(new Error('command_timeout')), idleMs);
  };
  arm();

  return {
    promise,
    async hold<T>(work: Promise<T>): Promise<T> {
      holds += 1;
      clearTimeout(timer);
      try { return await work; } finally { holds -= 1; arm(); }
    },
    progress(event) {
      if (event.phase === 'start') openSpans.add(event.corrId);
      else if (event.phase === 'end') openSpans.delete(event.corrId);
      arm();
    },
    dispose() { disposed = true; clearTimeout(timer); },
  };
}
