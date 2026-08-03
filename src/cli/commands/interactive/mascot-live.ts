/**
 * LiveMascot — the reacting goblin as a right-edge decoration on the
 * loop-stage rail.
 *
 * Issue #336. The goblin needs a visible, reacting presence during a turn, and
 * the obvious shapes for that are both wrong:
 *
 *   - The 1-row spinner cannot carry a *multi*-row sprite: the compositor's
 *     `fixedRows` accounting budgets the spinner at exactly one physical row,
 *     so a newline in spinner output corrupts the DECSTBM scroll math.
 *   - Its own reserved band can, but then the sprite claims rows — and a
 *     reservation that appears while a tool runs and collapses at idle makes
 *     the transcript jump on every tool call. That is the most obtrusive thing
 *     a footer tenant can do, which is exactly the complaint this shape fixes.
 *
 * So this class is not a painter at all. It owns the mascot's state machine and
 * its animation ticker, and hands `LoopStageBar` a one-row sprite to
 * right-align on the row the rail already owns (see `getRightDecoration` there).
 * Consequences worth stating, because they are the point:
 *
 *   - **No geometry.** It reserves no rows, reads no terminal size, and never
 *     writes to a stream, so the `extraRows` sum in `footer-subsystems.ts` is
 *     byte-identical whether or not the operator enabled the mascot. There is
 *     no reserve-before-paint ordering to get wrong and nothing to erase.
 *   - **One owner per row.** The rail composes the row including the sprite, so
 *     the two can never clobber each other's columns.
 *   - **Resize is free.** The rail re-composes on every paint (including its
 *     ResizeBus self-heal) and pulls the sprite fresh, dropping it when the row
 *     is too narrow to hold both.
 *
 * Unlike the rail it decorates, the mascot is present at rest: `idle` is a
 * single still frame and runs no timer, so a resting REPL pays nothing for a
 * goblin that is simply sitting there.
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
   * @param opts.requestRepaint - Asks the host row to repaint (typically
   *   `() => loopStageBar.redraw()`). Called once per animation frame and on
   *   every state change; must be idempotent and cheap.
   * @param opts.frameMs - Animation period in ms.
   */
  constructor(opts: { requestRepaint: () => void; frameMs?: number }) {
    this.requestRepaint = opts.requestRepaint;
    this.frameMs = opts.frameMs ?? DEFAULT_FRAME_MS;
  }

  /**
   * Go inert: stop the ticker and stop contributing a decoration. Idempotent.
   *
   * Teardown is written above `start()` so the inverse of every setup step
   * stays visible next to it. Note what is absent versus a band painter: there
   * are no rows to erase and no reservation to release, so ordering against the
   * other footer tenants does not matter — the host row's own `stop()` clears
   * the whole line. The one real requirement is that the ticker die before the
   * host does, so a stray tick cannot outlive its repaint target.
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
   * writes, and its host row is already TTY-gated.
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
   * The sprite to render at the host row's right edge, ANSI-styled, exactly
   * MINI_MASCOT_WIDTH display columns wide — or `''` when the mascot is inert,
   * which the host must treat as "decorate nothing" so its row is unchanged for
   * operators who never enabled the goblin.
   */
  decoration(): string {
    if (!this.started) return '';
    return renderMiniMascotLines(this.state, this.frame)[0] ?? '';
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
