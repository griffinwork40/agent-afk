/**
 * Caret-blink controller — owns the input caret's on/off blink phase and its
 * interval timer, extracted from TerminalCompositor in the same controller
 * style as {@link SpinnerController} (input/spinner.ts).
 *
 * **Why a software blink exists at all.** AFK paints its OWN caret glyph (a ▏
 * thin bar at end-of-buffer, or an inverse-video block mid-buffer) inside the
 * log-update frame, and the frame renderer hides the hardware terminal cursor
 * for the entire armed cycle (cup-frame-renderer.ts emits `\x1b[?25l`). The
 * terminal's native cursor blink therefore never shows. To pulse the caret
 * like a terminal cursor we toggle the painted glyph on a timer instead.
 *
 * Invariant: the controller never writes to the terminal. It flips its own
 * `visiblePhase` and calls `onTick` to REQUEST a repaint; the compositor owns
 * the frame and reads {@link visible} when it paints the input line. This
 * preserves the single-frame ownership the renderer relies on (the same
 * contract SpinnerController follows to avoid the ora-vs-log-update race).
 */

export interface CaretBlinkControllerOptions {
  /**
   * Master enable. When false the caret is permanently solid and no timer is
   * ever created — the disabled path for `AFK_CARET_BLINK=0`, reduced-motion
   * users, and every non-interactive / test construction that doesn't opt in.
   * Callers that own an interactive surface resolve
   * `detectCaretBlink() && !detectReducedMotion()` and pass the result.
   */
  enabled: boolean;
  /**
   * Capture-mode flag (script(1) / asciinema / AFK_DEMO_CLEAN). When true the
   * ticker never starts — each phase flip would append a frame to the recorded
   * byte stream (same rationale as SpinnerController). The caret then stays
   * solid (visible) so recordings show a stable cursor.
   */
  captureMode: boolean;
  /** Blink half-period in ms — the dwell time in each (on / off) phase. */
  intervalMs: number;
  /**
   * Invoked whenever the blink TIMER flips the visible phase — the controller's
   * sole render path. {@link resetVisible} does NOT call this; it reports its
   * un-hide via a return value so the caller can coalesce the repaint with the
   * keystroke's own frame instead of writing the frame twice.
   */
  onTick: () => void;
}

/** Default blink half-period — the classic VT/xterm cursor-blink cadence. */
export const DEFAULT_CARET_BLINK_INTERVAL_MS = 530;

export class CaretBlinkController {
  private interval: ReturnType<typeof setInterval> | null = null;
  private visiblePhase = true;
  private readonly enabled: boolean;
  private readonly captureMode: boolean;
  private readonly intervalMs: number;
  private readonly onTick: () => void;

  constructor(opts: CaretBlinkControllerOptions) {
    this.enabled = opts.enabled;
    this.captureMode = opts.captureMode;
    this.intervalMs = opts.intervalMs;
    this.onTick = opts.onTick;
  }

  /**
   * Whether the caret glyph should be painted this frame. Always true when
   * blinking is disabled or suppressed (capture-mode keeps the ticker from
   * ever starting, so `visiblePhase` stays true) — the renderer then paints a
   * solid caret unconditionally.
   */
  get visible(): boolean {
    return this.enabled ? this.visiblePhase : true;
  }

  /**
   * Start the blink ticker. Idempotent; no-op when disabled or in capture mode
   * (the caret then stays solid). Called from arm() / resumeInput().
   */
  start(): void {
    if (!this.enabled || this.captureMode || this.interval) return;
    this.visiblePhase = true;
    this.schedule();
  }

  /**
   * Snap the caret back to solid and restart the dwell window — called on every
   * non-paste keystroke so the caret stays steady while typing and blinks only
   * when idle (terminal cursor behavior). No-op when disabled / capture / not
   * running.
   *
   * Pure state mutation: this does NOT repaint. It RETURNS whether the call
   * un-hid an off-phase caret — i.e. whether a frame is needed to show the
   * now-solid caret. The caller (arm()'s keypress handler) coalesces that with
   * the keystroke's own edit repaint: a keystroke that repaints anyway (the
   * common case) shows the solid caret for free in that frame, so only a
   * non-painting keystroke pays for an extra repaint. Returns false when the
   * caret was already visible / disabled / capture / not running.
   */
  resetVisible(): boolean {
    if (!this.enabled || this.captureMode || !this.interval) return false;
    const wasHidden = !this.visiblePhase;
    this.visiblePhase = true;
    clearInterval(this.interval);
    this.schedule();
    return wasHidden;
  }

  /**
   * Stop the ticker and reset to the solid phase. Idempotent. Called from
   * disarm() / suspendInput() so no blink timer outlives the armed cycle.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.visiblePhase = true;
  }

  private schedule(): void {
    const handle = setInterval(() => {
      this.visiblePhase = !this.visiblePhase;
      this.onTick();
    }, this.intervalMs);
    // Don't let the blink timer keep the event loop alive at process exit;
    // disarm() clears it on the normal path, this covers abrupt teardown.
    handle.unref?.();
    this.interval = handle;
  }
}
