import { palette } from '../palette.js';
import { pickRandomVerb, pickRandomGoblinVerb } from '../constants.js';
import { buildTipPool, selectTip } from '../loading-tips.js';
import {
  SPINNER_FRAMES,
  formatElapsed,
  formatTipRow,
  type SpinnerState,
} from '../terminal-compositor.types.js';

export interface SpinnerControllerOptions {
  /**
   * Capture-mode flag (script(1) / asciinema / screen recorders). When true
   * the 80ms ticker is never started — see {@link SpinnerController.set} for
   * the byte-accumulation rationale.
   */
  captureMode: boolean;
  /**
   * Invoked whenever the spinner state changes and the owning surface must
   * repaint: on enable, on disable-from-active, and on every 80ms frame tick.
   * The controller owns no terminal — this callback is its sole render path.
   */
  onTick: () => void;
  /**
   * Goblin theme: olive frames + goblin verb pool. Default false so direct/test
   * constructions keep the classic dim noir spinner; the live surfaces pass
   * {@link goblinSpinnerEnabled}. Purely cosmetic — no timer/width change.
   */
  goblin?: boolean;
}

/**
 * Owns the streaming spinner's state machine — the braille frame ticker, verb
 * rotation, and loading-tip slot — extracted from TerminalCompositor so the
 * compositor delegates rather than inlining interval management and
 * duplicating the spinner/tip render block across repaint() and
 * repaintPickerFrame().
 *
 * Invariant: the controller never writes to the terminal. It mutates its own
 * state and calls `onTick` to REQUEST a repaint; the compositor owns the frame
 * and pulls `renderSpinnerRow()` / `renderTipRow()` when it paints. This keeps
 * the single-frame ownership that the original inline implementation relied on
 * to avoid the ora-vs-log-update region-tracking race.
 */
export class SpinnerController {
  private state: SpinnerState | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly captureMode: boolean;
  private readonly onTick: () => void;
  private readonly goblin: boolean;

  constructor(opts: SpinnerControllerOptions) {
    this.captureMode = opts.captureMode;
    this.onTick = opts.onTick;
    this.goblin = opts.goblin ?? false;
  }

  /** Pick a verb from the active theme's pool. */
  private pickVerb(): string {
    return this.goblin ? pickRandomGoblinVerb() : pickRandomVerb();
  }

  /**
   * Enable or disable the spinner. Callers MUST gate on TTY before calling —
   * the controller owns no stdout and assumes an interactive terminal.
   */
  set(config: { enabled: boolean; rotateVerbEveryMs?: number }): void {
    // Constraint: the disable path MUST run unconditionally so a previously-
    // started spinner can be torn down even after capture-mode is toggled on
    // (defensive — capture-mode is set at construction time today, but
    // structuring this way means future enable/disable wiring doesn't strand
    // an orphaned interval). Only the enable path is gated.
    if (!config.enabled) {
      if (this.interval) {
        clearInterval(this.interval);
        this.interval = null;
      }
      if (this.state) {
        this.state = null;
        this.onTick();
      }
      return;
    }
    // Capture-mode constraint: a setInterval-driven repaint at 80ms fires
    // ~12.5 log-update frames per second. In a live TTY these collapse to
    // one visible region via cursor-up + erase-line escapes; in a captured
    // stream (`script(1)`, `asciinema`, screen recorders) the escapes are
    // preserved as bytes and every frame appends. For a 4-second tool
    // execution that's ~50 redundant copies of the same overlay in the
    // captured artifact. Skip the ticker entirely in capture-mode.
    if (this.captureMode) return;
    if (this.state) return;
    const rotateMs = config.rotateVerbEveryMs ?? 3500;
    const now = Date.now();
    // Harvest the tip pool once at start. Empty pool (AFK_SPINNER_TIPS=0 or no
    // hints registered yet) is the no-op path — selectTip keeps returning null
    // and the tip row never renders.
    this.state = {
      frameIndex: 0,
      verb: this.pickVerb(),
      nextVerbRotateAt: now + rotateMs,
      startedAt: now,
      tipPool: buildTipPool(),
      currentTip: null,
    };
    this.interval = setInterval(() => this.tick(rotateMs), 80);
    this.onTick();
  }

  /**
   * Tear down the ticker and clear state. Does NOT request a repaint — the
   * caller (disarm) clears the entire frame itself.
   */
  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.state = null;
  }

  /** The composed spinner row, or null when no spinner is active. */
  renderSpinnerRow(): string | null {
    if (!this.state) return null;
    // Goblin theme tints the frame+verb olive; classic stays dim. Width is
    // unchanged (single braille glyph), so no compositor row-budget impact.
    const tint = this.goblin ? palette.goblin : palette.meta;
    return tint(`${SPINNER_FRAMES[this.state.frameIndex]!} ${this.state.verb}...`)
      + formatElapsed(this.state.startedAt);
  }

  /**
   * The composed tip row, or null when the spinner has no current tip.
   * Truncated to `cols` HERE (not in `selectTip`) so the same tip text stays
   * stable across terminal resizes — `selectTip` is width-agnostic.
   */
  renderTipRow(cols: number): string | null {
    return this.state?.currentTip
      ? formatTipRow(this.state.currentTip.text, cols)
      : null;
  }

  private tick(rotateMs: number): void {
    if (!this.state) return;
    this.state.frameIndex = (this.state.frameIndex + 1) % SPINNER_FRAMES.length;
    const now = Date.now();
    if (now >= this.state.nextVerbRotateAt) {
      this.state.verb = this.pickVerb();
      this.state.nextVerbRotateAt = now + rotateMs;
    }
    // Refresh the tip slot every tick. `selectTip` is time-stable — it returns
    // the same tip across consecutive ticks within one rotation window — so
    // this is effectively a no-op except at warmup-elapsed and rotation-window
    // boundaries. Calling it here keeps the warmup-suppression and rotation
    // logic in one place (loading-tips.ts) instead of duplicating timestamps.
    this.state.currentTip = selectTip(this.state.tipPool, {
      startedAt: this.state.startedAt,
      now,
    });
    this.onTick();
  }
}
