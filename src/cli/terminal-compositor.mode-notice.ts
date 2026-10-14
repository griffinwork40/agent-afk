/**
 * Transient mode notice — a single live-frame row that replaces itself.
 *
 * Shift+Tab walks the permission-mode ring (`permission-mode-cycle.ts`). Each
 * step used to commit a `✓ ● plan mode ON — …` line to scrollback, so a few
 * presses left a stack of stale mode lines above the prompt even though the
 * status line already shows the live mode. The notice instead lives INSIDE the
 * compositor's frame (rendered in the chrome slot above the input cluster, see
 * `gatherChromeRows`), so:
 *
 *   - each Shift+Tab OVERWRITES the previous notice (toggle, not log), and
 *   - the next non-Shift+Tab keystroke clears it, so it never reaches
 *     scrollback and never outlives the moment it explains.
 *
 * Contract: `setModeNotice` returns `false` (and changes nothing) when the
 * compositor is not armed, so callers fall back to the scrollback writer on
 * surfaces where no live frame exists (readLine fallback, non-TTY, tests).
 */

/** Narrow host slice for {@link setModeNotice}. */
export interface ModeNoticeHost {
  armed: boolean;
  modeNotice: string | null;
  repaint(): void;
}

/** Narrow host slice for {@link clearModeNoticeOnKey}. */
export interface ModeNoticeKeyHost {
  modeNotice: string | null;
  scheduleRepaint(): void;
}

/** Show (or replace) the notice; `null` clears it. See module contract. */
export function setModeNotice(self: ModeNoticeHost, text: string | null): boolean {
  if (!self.armed) return false;
  self.modeNotice = text;
  self.repaint();
  return true;
}

/**
 * Clear the notice on any keystroke except Shift+Tab (which is about to
 * replace it via the cycle handler). No-op when no notice is showing.
 */
export function clearModeNoticeOnKey(
  self: ModeNoticeKeyHost,
  key: { name?: string; shift?: boolean } | undefined,
): void {
  if (self.modeNotice === null) return;
  if (key?.name === 'tab' && key.shift) return;
  self.modeNotice = null;
  self.scheduleRepaint();
}
