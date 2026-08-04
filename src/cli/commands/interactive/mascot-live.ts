/**
 * LiveMascot — the reacting goblin's state machine and animation clock.
 *
 * Issue #336. The goblin needs a visible, reacting presence during a turn. The
 * 1-row spinner cannot carry a *multi*-row sprite (the compositor's `fixedRows`
 * accounting budgets the spinner at exactly one physical row, so a newline in
 * spinner output corrupts the DECSTBM scroll math), and the sprite needs three
 * character rows to read as a goblin rather than a head — so it lives in a
 * reserved band of its own, painted by `MascotBand` (mascot-band.ts).
 *
 * This class is deliberately NOT that painter. The split is the lesson of the
 * first two attempts at this feature: what the mascot *looks like* changes on a
 * timer many times a second, while *where it is painted* is DECSTBM geometry
 * that must change as rarely as possible. Mixing the two produced a band that
 * reserved rows when a tool started and released them at idle, which made the
 * transcript jump twice per tool call. So:
 *
 *   - **Here (LiveMascot):** state (`idle`/`working`/`alert`), the alert dwell,
 *     the frame counter, the ticker. No stream, no rows, no terminal size.
 *   - **There (MascotBand):** a reservation established once at REPL start and
 *     released once at exit, right-aligned out of the reading path. It asks
 *     this class for the current frame; it never asks whether to exist.
 *
 * The mascot is therefore present at rest rather than transient: `idle` is a
 * single still frame that runs no timer, so a resting REPL pays for the rows and
 * nothing else — and a companion that is simply sitting there is less obtrusive
 * than one that pops in and out.
 *
 * Lifecycle: construct → `start()` → `onStage(...)` per loop-stage transition
 * → `stop()` before exit.
 */

import { isPlainOutputRequested } from '../../../config/env.js';
import { mascotSuppressed, type MascotState } from '../../mascot.js';
import { miniMascotFrameCount, renderMiniMascotLines } from '../../mascot-mini.js';
import { detectGoblinMascot } from '../../_lib/capture-mode.js';
import type { LoopStage } from './loop-stage.js';

/**
 * How long an `alert` holds the sprite before the mascot returns to whatever
 * the loop stage says. A tool error is an instant, not a state — without a
 * dwell it would be overwritten by the very next stage transition (usually the
 * same event) and never be seen.
 */
const ALERT_DWELL_MS = 1500;

/**
 * Animation period. Slow on purpose: the working cycle is rest-dominant (see
 * FRAMES in mascot-mini.ts), so this is the beat between twitches, not a
 * spinner's frame rate. The real spinner is already on screen a row or two
 * above — a second fast-cycling thing next to it reads as noise.
 */
const DEFAULT_FRAME_MS = 300;

/**
 * Frames the mascot renders, ANSI-styled — one string per character row.
 * Empty while inert, which the painter must treat as "paint nothing".
 */
export type MascotFrame = readonly string[];

export class LiveMascot {
  private readonly requestRepaint: () => void;
  private readonly frameMs: number;
  private started = false;
  private state: MascotState = 'idle';
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** State implied by the most recent loop stage; the alert dwell falls back to it. */
  private stageState: MascotState = 'idle';
  private alertTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param opts.requestRepaint - Asks the painter to re-assert the band at the
   *   current frame (typically `() => mascotBand.redraw()`). Called once per
   *   animation frame and on every state change; must be idempotent and cheap.
   * @param opts.frameMs - Animation period in ms.
   */
  constructor(opts: { requestRepaint: () => void; frameMs?: number }) {
    this.requestRepaint = opts.requestRepaint;
    this.frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
  }

  /**
   * Go inert: stop the ticker and stop producing frames. Idempotent.
   *
   * Teardown is written above `start()` so the inverse of every setup step stays
   * visible next to it. Invariant: this must run BEFORE the painter's own
   * `stop()`. It owns no rows, so it erases nothing — but its ticker's only job
   * is to ask the painter to repaint, and a tick that outlives the band would
   * write to rows the reservation no longer covers. Silencing the clock first
   * makes the band's release the last write either object performs.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stopTimer();
    this.clearAlertTimer();
    this.state = 'idle';
    this.stageState = 'idle';
    this.frame = 0;
    this.requestRepaint();
  }

  /**
   * Arm the mascot. Renders the resting sprite immediately.
   *
   * Opt-in: `AFK_GOBLIN_MASCOT=1`. Two further inert gates —
   * `AFK_PLAIN_OUTPUT`/`--plain` (full render opt-out, mirroring the
   * status-line/compositor/loop-stage gates) and `AFK_BANNER_PLAIN=1` (pixel
   * art suppressed everywhere). A non-TTY needs no gate here: this class never
   * writes, and its painter is separately TTY-gated (a band tenant that starts
   * must be able to reserve rows, and a phantom reservation on a dumb pipe would
   * shrink the scroll region for output nobody can see).
   */
  start(): void {
    if (this.started) return;
    if (!detectGoblinMascot()) return;
    if (isPlainOutputRequested()) return;
    if (mascotSuppressed()) return;
    this.started = true;
    this.requestRepaint();
  }

  /**
   * The sprite's current frame — MINI_MASCOT_HEIGHT ANSI-styled rows, each
   * exactly MINI_MASCOT_WIDTH display columns wide — or `[]` when the mascot is
   * inert, which the painter must treat as "paint nothing".
   *
   * Contract: this is a pure read. It never starts a timer or changes state, so
   * the painter may call it as often as it likes (every repaint, every resize
   * self-heal) without side effects, and a caller that ignores the result costs
   * nothing.
   */
  lines(): MascotFrame {
    if (!this.started) return [];
    return renderMiniMascotLines(this.state, this.frame);
  }

  /**
   * Point the mascot at the agent's current state. `idle` parks it on the
   * resting frame with no ticker; `working`/`alert` start the animation. Cheap
   * to call on every loop-stage transition — a no-op when the state has not
   * changed.
   */
  setState(state: MascotState): void {
    if (!this.started || state === this.state) return;
    this.state = state;
    this.frame = 0;
    if (miniMascotFrameCount(state) <= 1) this.stopTimer();
    else this.startTimer();
    this.requestRepaint();
  }

  /**
   * Map a loop-stage transition onto a mascot state — the REPL's only wiring
   * point. `acting` (a tool is in flight with no result yet) is the working
   * window; every other stage is rest. A `toolErrored` signal flashes `alert`
   * for {@link ALERT_DWELL_MS} and then falls back to the live stage, so the
   * error is visible without freezing the mascot in a scary face.
   *
   * Kept here rather than in the two call sites (the REPL turn loop and the
   * slash-skill surface) so the mapping and the dwell have exactly one home.
   */
  onStage(stage: LoopStage, signals?: { toolErrored?: boolean }): void {
    if (!this.started) return;
    this.stageState = stage === 'acting' ? 'working' : 'idle';
    if (signals?.toolErrored) {
      this.flashAlert();
      return;
    }
    // While an alert is dwelling it owns the sprite; the stage we just recorded
    // is what the dwell timer will fall back to.
    if (this.alertTimer) return;
    this.setState(this.stageState);
  }

  // ---- animation ----------------------------------------------------------

  private clearAlertTimer(): void {
    if (!this.alertTimer) return;
    clearTimeout(this.alertTimer);
    this.alertTimer = null;
  }

  /** Show `alert`, then fall back to the live stage after the dwell. */
  private flashAlert(): void {
    this.clearAlertTimer();
    this.setState('alert');
    this.alertTimer = setTimeout(() => {
      this.alertTimer = null;
      this.setState(this.stageState);
    }, ALERT_DWELL_MS);
    this.alertTimer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame += 1;
      this.requestRepaint();
    }, this.frameMs);
    // Never hold the event loop open: a live mascot must not delay process exit.
    this.timer.unref?.();
  }
}
