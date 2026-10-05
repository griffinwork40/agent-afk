import { palette } from '../palette.js';
import { pickRandomVerb, pickRandomGoblinVerb } from '../constants.js';
import { buildTipPool, selectTip } from '../loading-tips.js';
import { SPINNER_FRAMES, type SpinnerState } from '../terminal-compositor.types.js';
import { formatElapsed, formatTipRow } from '../terminal-compositor.scrollback.js';
import { contentMargin } from '../render/measure.js';

/**
 * Frame cadence during the first {@link SPINNER_WARMUP_MS} of a spin (12.5 Hz),
 * so short waits still feel alive.
 */
export const SPINNER_WARM_FRAME_MS = 80;
// Measured 2026-10-04: a pane animating only this spinner at 12.5 Hz cost ~4.4% of a core in Goblin Portal, so long spins drop to 4 Hz.
export const SPINNER_IDLE_FRAME_MS = 250;
/** How long a spin (or a new work-derived verb) keeps the warm cadence. */
export const SPINNER_WARMUP_MS = 2_000;

export interface SpinnerControllerOptions {
  /**
   * Capture-mode flag (script(1) / asciinema / screen recorders). When true
   * the frame ticker is never started — see {@link SpinnerController.set} for
   * the byte-accumulation rationale.
   */
  captureMode: boolean;
  /**
   * Invoked whenever the spinner state changes and the owning surface must
   * repaint: on enable, on disable-from-active, and on every frame tick whose
   * composed rows differ from the last ones requested (identical frames are
   * skipped). The controller owns no terminal — this callback is its sole
   * render path.
   */
  onTick: () => void;
  /**
   * Goblin theme: olive frames + goblin verb pool. Default false so direct/test
   * constructions keep the classic dim noir spinner; the live surfaces pass
   * {@link goblinSpinnerEnabled}. Purely cosmetic — no timer/width change.
   */
  goblin?: boolean;
  /**
   * Optional source of a work-derived verb. Consulted on every verb pick; when
   * it returns a string that verb is used verbatim, otherwise the flavour pool
   * supplies one. Lets the spinner describe the tool actually in flight instead
   * of rotating random noir verbs that imply state changes which never happened.
   *
   * Pull-based on purpose: the controller already ticks every frame, so reading the
   * current verb during that tick adds no timer and no new repaint path.
   */
  workVerb?: () => string | undefined;
  /**
   * Optional state-specific hint (e.g. the wait_for queue-to-stop hint). When it
   * returns text, the tip row shows it with a `Hint:` label INSTEAD of the
   * rotating tip, with no warmup and regardless of AFK_SPINNER_TIPS: that
   * setting governs rotating tips only, and this hint describes what the user
   * can do right now. Pulled on each render, so no extra timer.
   */
  contextTip?: () => string | undefined;
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
  /** Period the live interval was armed with (80 warm / 250 idle). */
  private intervalMs = 0;
  /** Start of the current warm-cadence window (spin start or last work-verb change). */
  private cadenceStartedAt = 0;
  /** Composed rows last handed to onTick; a tick that would repeat them is skipped. */
  private lastFrameKey: string | null = null;
  private readonly captureMode: boolean;
  private readonly onTick: () => void;
  private readonly goblin: boolean;
  private readonly workVerb: (() => string | undefined) | undefined;
  private readonly contextTip: (() => string | undefined) | undefined;

  constructor(opts: SpinnerControllerOptions) {
    this.captureMode = opts.captureMode;
    this.onTick = opts.onTick;
    this.goblin = opts.goblin ?? false;
    this.workVerb = opts.workVerb;
    this.contextTip = opts.contextTip;
  }

  /**
   * Pick a verb: the real in-flight activity when one is known, else the active
   * theme's flavour pool. A throwing provider must never take down the render
   * loop, so it degrades to the pool rather than propagating.
   */
  private pickVerb(): string {
    try {
      const derived = this.workVerb?.();
      if (derived) return derived;
    } catch {
      // fall through to the flavour pool
    }
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
      this.clearTimer();
      if (this.state) {
        this.state = null;
        this.lastFrameKey = null;
        this.onTick();
      }
      return;
    }
    // Capture-mode constraint: a timer-driven repaint at 80ms fires
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
    this.cadenceStartedAt = now;
    this.armInterval(rotateMs, SPINNER_WARM_FRAME_MS);
    this.lastFrameKey = this.frameKey();
    this.onTick();
  }

  /**
   * (Re)arm the single frame interval at `ms`. The one setInterval call site
   * is deliberate (live-progress-no-timer.test.ts pins it): the cadence change
   * replaces the interval rather than adding a second clock.
   */
  private armInterval(rotateMs: number, ms: number): void {
    this.clearTimer();
    this.intervalMs = ms;
    this.interval = setInterval(() => this.tick(rotateMs), ms);
  }

  private clearTimer(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Step the interval between warm and idle when the warm-up window flips. */
  private syncCadence(rotateMs: number, now: number): void {
    const want = now - this.cadenceStartedAt < SPINNER_WARMUP_MS
      ? SPINNER_WARM_FRAME_MS
      : SPINNER_IDLE_FRAME_MS;
    if (want !== this.intervalMs) this.armInterval(rotateMs, want);
  }

  /**
   * Identity of everything this controller contributes to a frame: the
   * composed spinner row (glyph + verb + elapsed) and the tip-row text. Width-
   * independent on purpose — a resize repaints through its own path.
   */
  private frameKey(): string {
    let hint: string | undefined;
    try {
      hint = this.contextTip?.();
    } catch {
      hint = undefined;
    }
    return `${this.renderSpinnerRow() ?? ''}\n${hint ?? this.state?.currentTip?.text ?? ''}`;
  }

  /**
   * Tear down the ticker and clear state. Does NOT request a repaint — the
   * caller (disarm) clears the entire frame itself.
   */
  dispose(): void {
    this.clearTimer();
    this.state = null;
    this.lastFrameKey = null;
  }

  /** The composed spinner row, or null when no spinner is active. */
  renderSpinnerRow(): string | null {
    if (!this.state) return null;
    // Goblin theme tints the frame+verb olive; classic stays dim. Width is
    // unchanged (single braille glyph), so no compositor row-budget impact.
    const tint = this.goblin ? palette.goblin : palette.meta;
    // Content centering (AFK_CENTER_CONTENT): prepend left margin so the
    // spinner row floats at the same horizontal position as other content.
    return contentMargin() + tint(`${SPINNER_FRAMES[this.state.frameIndex]!} ${this.state.verb}...`)
      + formatElapsed(this.state.startedAt);
  }

  /**
   * The composed tip row, or null when the spinner has no current tip.
   * Truncated to `cols` HERE (not in `selectTip`) so the same tip text stays
   * stable across terminal resizes — `selectTip` is width-agnostic.
   */
  renderTipRow(cols: number): string | null {
    if (!this.state) return null;
    let hint: string | undefined;
    try {
      hint = this.contextTip?.();
    } catch {
      hint = undefined; // a broken hint probe must never take down the render loop
    }
    if (hint) return formatTipRow(hint, cols, 'Hint');
    return this.state.currentTip
      ? formatTipRow(this.state.currentTip.text, cols)
      : null;
  }

  private tick(rotateMs: number): void {
    if (!this.state) return;
    this.state.frameIndex = (this.state.frameIndex + 1) % SPINNER_FRAMES.length;
    const now = Date.now();
    // Two triggers for a re-pick: the flavour rotation window elapsing, and the
    // work-derived verb disagreeing with what is displayed. The second keeps the
    // verb honest without waiting out a rotation — and is self-throttling,
    // because the provider resolves a tool verb, so tools sharing the same verb
    // yield one stable label rather than a flicker of new words.
    const derived = (() => {
      try {
        return this.workVerb?.();
      } catch {
        return undefined;
      }
    })();
    const workVerbChanged = derived !== undefined && derived !== this.state.verb;
    if (now >= this.state.nextVerbRotateAt || workVerbChanged) {
      this.state.verb = this.pickVerb();
      this.state.nextVerbRotateAt = now + rotateMs;
      // A new work-derived verb is a real state change, so it earns a fresh
      // warm-up. The timed flavour rotation does not: it fires every few
      // seconds while idle and would hold the spinner at 12.5 Hz forever.
      if (workVerbChanged) this.cadenceStartedAt = now;
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
    this.syncCadence(rotateMs, now);
    // Never request a repaint for a frame identical to the last one requested.
    const key = this.frameKey();
    if (key === this.lastFrameKey) return;
    this.lastFrameKey = key;
    this.onTick();
  }
}
