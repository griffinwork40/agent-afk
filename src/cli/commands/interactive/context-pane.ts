/**
 * Pre-prompt context pane — a stable live surface that prints the current
 * todo list above each prompt between turns.
 *
 * Design:
 *   - Reads the durable todo store by session id each call; no in-memory
 *     mirror, so edits made via `/todo` slash handlers show up on the next
 *     prompt without any explicit invalidation.
 *   - Dedupes by structural fingerprint so identical state doesn't re-paint
 *     into scrollback turn after turn.
 *   - On resize, the *content* fingerprint is unchanged but the *rendered*
 *     width may differ. The ResizeBus callback installed by the REPL clears
 *     the fingerprint cache so the next prompt gets a fresh paint.
 *   - Non-TTY: still prints the panel (useful for scripted runs + tests).
 */

import { loadTodos, renderTodoPanel, todoFingerprint } from '../../todo-panel.js';
import { ResizeBus } from '../../terminal-size.js';

export interface ContextPane {
  /** Render the panel above the next prompt if the content changed. */
  renderIfChanged(sessionId: string | undefined): string[];
  /** Drop the fingerprint cache — next call will re-paint. */
  invalidate(): void;
  /** Detach the resize listener; call on REPL teardown. */
  dispose(): void;
}

export interface ContextPaneOptions {
  /** Override the loader in tests. */
  load?: (sessionId: string) => ReturnType<typeof loadTodos>;
  /** Override the resize subscription in tests. */
  onResize?: (cb: () => void) => () => void;
}

export function createContextPane(opts: ContextPaneOptions = {}): ContextPane {
  const load = opts.load ?? loadTodos;
  const subscribe = opts.onResize ?? ((cb: () => void) => ResizeBus.subscribe(cb));

  let lastFingerprint = '';
  let lastSessionId: string | undefined;

  const unsubscribe = subscribe(() => {
    lastFingerprint = '';
  });

  return {
    renderIfChanged(sessionId) {
      const id = sessionId ?? 'unbound';
      const store = load(id);
      const fp = todoFingerprint(store);

      if (id === lastSessionId && fp === lastFingerprint) return [];

      lastSessionId = id;
      lastFingerprint = fp;
      if (fp === '') return [];
      return renderTodoPanel(store);
    },

    invalidate() {
      lastFingerprint = '';
    },

    dispose() {
      try {
        unsubscribe();
      } catch {
        /* noop — bus may already be torn down */
      }
    },
  };
}
