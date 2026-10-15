import type { KeyDispatchHost } from './terminal-compositor.input-dispatch.js';
import type { KeyInfo } from './terminal-compositor.types.js';

/**
 * Handle Ctrl+G: open the in-TUI bash output viewer on the most recent
 * capture file.
 *
 * Ctrl+G is always consumed when armed so the raw BEL byte (0x07) never
 * leaks into the input buffer.  The callback fire-and-forgets — the viewer
 * owns its own picker lifecycle and returns a promise the dispatcher never
 * needs to await.
 *
 * Extracted from `terminal-compositor.input-dispatch.ts` so the grandfathered
 * file does not grow beyond its baselined code-line ceiling (issue #1505).
 */
export function handleOpenOutputViewer(self: KeyDispatchHost, key: KeyInfo): boolean {
  if (key?.ctrl && key?.name === 'g') {
    if (self.onOpenOutputViewer) self.onOpenOutputViewer();
    return true;
  }
  return false;
}
