import type { KeyDispatchHost } from './terminal-compositor.input-dispatch.js';
import type { KeyInfo } from './terminal-compositor.types.js';

/**
 * Handle Ctrl+O: open the live buffer in $EDITOR.
 *
 * Ctrl+O is always consumed when armed so the raw control byte (0x0f) never
 * leaks into the buffer via handlePrintable. The handler owns the async
 * suspend/spawn/restore + buffer load internally; dispatch just fires it and
 * returns. Fire in any input mode: composing a prompt (idle) is the primary
 * case, and firing mid-stream is harmless — the handler reads the live buffer
 * regardless of turn state.
 *
 * Extracted from `terminal-compositor.input-dispatch.ts` so the grandfathered
 * file does not grow beyond its baselined code-line ceiling (issue #1505).
 */
export function handleOpenEditor(self: KeyDispatchHost, key: KeyInfo): boolean {
  if (key?.ctrl && key?.name === 'o') {
    if (self.onOpenEditor) self.onOpenEditor();
    return true;
  }
  return false;
}
