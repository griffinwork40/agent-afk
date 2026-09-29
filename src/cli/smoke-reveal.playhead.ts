/**
 * Continuous reveal front with a bounded animation backlog.
 *
 * Intake retains the newest tail whose normalized nominal duration
 * (characters / speed / run budget) sums to at most one. Older overflow is
 * explicitly settled, never backdated. Budgets are fixed capacities, NOT
 * arrival deadlines: smoothing and the final crawl may take longer.
 *
 * Between intakes position advances only by capped, smoothed velocity. A fixed
 * absolute 1 ms grid makes births independent of paint cadence. Birth times
 * remain monotonic and never precede arrival, including settled overflow.
 * @module cli/smoke-reveal.playhead
 */
import type { RevealStyle } from './smoke-reveal.cells.js';

/**
 * Steady-state reveal lag: the playhead trails a steady stream by about this
 * much. It hides network jitter shorter than itself, so a chunk gap does not
 * stop the typing. A sweep over bursty 80-350 cps streams (chunk gaps of
 * 0.3-1.7x nominal plus occasional 500 ms stalls) measured, for 350 / 600 /
 * 900 ms: speed jitter over 250 ms of 20% / 10% / 6% and full stops 2% / 0% /
 * 0% of the time. 600 is the knee.
 */
export const TARGET_LAG_MS = 600;
/**
 * Window of the arrival-rate estimate. The typing speed follows the stream's
 * AVERAGE rate over about this long, not each network chunk, which is what
 * makes it read as one steady typist instead of bursts.
 */
export const RATE_WINDOW_MS = 3000;
/** Time over which a backlog above (or below) the target lag is worked off. */
export const CORRECT_MS = 2000;
/** Velocity relaxation time toward the target speed. */
export const TAU_MS = 250;
/**
 * Acceleration cap, in characters per ms per ms (1000 cps gained per second):
 * a change of speed is spread over a visible fraction of a second instead of
 * a lurch, while a start from rest still reaches reading pace in ~0.1 s.
 */
export const MAX_ACCEL = 1 / 1000;
/**
 * Braking cap (1500 cps lost per second). The front brakes on the kinematic
 * curve `v <= sqrt(2 * MAX_BRAKE * backlog)`, so it eases to rest exactly as
 * it reaches the newest character instead of stopping dead: from 300 cps the
 * last ~30 characters take ~0.2 s. Bounds the per-frame change of advance to
 * ~0.4 characters at 60 fps.
 */
export const MAX_BRAKE = 1.5 / 1000;
/** No arrival for this long means a pause or the end: finish at the current pace. */
export const QUIET_MS = 250;
/** Shortest span the rate estimate treats as filled, so one chunk does not read as a spike. */
const WARMUP_MS = 250;
/** Slowest target speed while any character is waiting. */
export const MIN_CPS = 60;
/**
 * Prose speed ceiling. Above typical model output (roughly 150-350 cps), so a
 * fast stream is typed faster rather than skipped: at the old 180 ceiling a
 * 350 cps stream snapped about a third of its text in 20-25 character jumps.
 */
export const MAX_CPS = 600;
/** Heading speed ceiling: an 18 ms cadence. */
export const HEADING_MAX_CPS = 1000 / 18;
/** Fixed integration step. Births are interpolated inside it. */
export const SUBSTEP_MS = 1;

export interface RunSpec {
  count: number;
  style: RevealStyle;
  /** Nominal animation-duration budget, not an arrival-to-birth deadline. */
  capMs: number;
  /** Speed ceiling while the front is inside this run. `Infinity` = instant. */
  maxCps: number;
}
interface Run {
  end: number;
  maxPerMs: number;
  /** Fixed character capacity for this run's duration budget. */
  capacity: number;
}

export class RevealTimeline {
  private total = 0;
  private base = 0;
  private pos = 0;
  private vel = 0;
  private clock: number | null = null;
  private runs: Run[] = [];
  private births: number[] = [];
  private styles: RevealStyle[] = [];
  private arrivals: { end: number; at: number }[] = [];
  /** Arrival-rate estimate (chars/ms) as of `rateAt`, exponentially windowed. */
  private rate = 0;
  private rateAt: number | null = null;
  /** Start of the current estimate window (reset after a long silence). */
  private rateFrom = 0;
  private lastArrival = -Infinity;
  /**
   * Invariant (settle only the unborn): intake overflow settles the half-open
   * range [bornCount, end) that was still UNBORN at intake. Characters the
   * playhead already birthed keep their fade. A prefix marker here would
   * retroactively snap every in-flight fade solid on each overflowing intake,
   * which is what made fast streams pop chunk by chunk. Ranges are ascending
   * and disjoint because each starts at the born count, which only grows.
   */
  private settled: { from: number; to: number }[] = [];

  get recorded(): number { return this.total; }
  get first(): number { return this.base; }
  get bornCount(): number { return this.base + this.births.length; }
  get cps(): number { return this.vel * 1000; }
  get position(): number { return this.pos; }

  record(t: number, spec: RunSpec): void {
    if (spec.count <= 0) return;
    this.advance(t);
    const caughtUp = this.bornCount >= this.total;
    const bornBefore = this.bornCount;
    this.total += spec.count;
    for (let i = 0; i < spec.count; i++) this.styles.push(spec.style);
    this.runs.push({ end: this.total, maxPerMs: spec.maxCps / 1000, capacity: spec.capMs * spec.maxCps / 1000 });
    this.arrivals.push({ end: this.total, at: t });
    this.noteArrival(t, spec.count);
    // Preserve zero first-token latency after rest.
    if (caughtUp) this.bornThrough(this.bornCount + 1, t);
    if (spec.maxCps === Infinity) this.bornThrough(this.total, t);
    else this.settleOverflow(t, bornBefore);
    this.retireRuns();
  }

  /** Bound the combined backlog, including mixed-speed runs, only on intake. */
  private settleOverflow(t: number, bornBefore: number): void {
    let budget = 1;
    for (let j = this.runs.length - 1; j >= 0; j--) {
      const run = this.runs[j]!;
      const start = Math.max(this.pos, this.runs[j - 1]?.end ?? this.bornCount);
      const count = Math.max(0, run.end - start);
      if (count === 0) continue;
      const keep = Math.max(0, budget * run.capacity);
      if (count > keep + 1e-9) {
        const end = Math.ceil(run.end - keep - 1e-9);
        // The zero-latency first birth of THIS intake was never animated; include it.
        const from = Math.min(this.bornCount, bornBefore);
        this.bornThrough(end, t);
        this.markSettled(from, this.bornCount);
        return;
      }
      budget -= count / run.capacity;
    }
  }

  advance(t: number): void {
    const grid = Math.floor(t / SUBSTEP_MS) * SUBSTEP_MS;
    if (this.clock === null || this.atRest()) {
      this.clock = Math.max(this.clock ?? grid, grid);
      return;
    }
    while (this.clock + SUBSTEP_MS <= grid) {
      this.step(this.clock);
      this.clock += SUBSTEP_MS;
      if (this.atRest()) {
        this.clock = grid;
        return;
      }
    }
  }

  /** null if pruned, Infinity if unborn; explicit settlement does not alter births. */
  birthAt(i: number): number | null {
    if (i < this.base) return null;
    return this.births[i - this.base] ?? Infinity;
  }
  isSettled(i: number): boolean {
    if (i < this.base) return true;
    for (const r of this.settled) {
      if (i < r.from) return false;
      if (i < r.to) return true;
    }
    return false;
  }
  styleAt(i: number): RevealStyle | undefined { return this.styles[i - this.base]; }

  trimNewest(n: number): void {
    const take = Math.min(n, this.total - this.base);
    if (take <= 0) return;
    this.total -= take;
    this.styles.length = this.total - this.base;
    if (this.bornCount > this.total) this.births.length = this.total - this.base;
    this.pos = Math.min(this.pos, this.total);
    for (const r of this.settled) r.to = Math.min(r.to, this.total);
    this.settled = this.settled.filter((r) => r.to > r.from);
    for (const list of [this.runs, this.arrivals]) {
      while (list.length > 0 && (list.at(-2)?.end ?? this.base) >= this.total) list.pop();
      const last = list.at(-1);
      if (last) last.end = Math.min(last.end, this.total);
    }
    this.retireRuns();
    if (this.bornCount === this.total) this.vel = 0;
  }

  prune(t: number, lifeOf: (style: RevealStyle) => number): void {
    let k = 0;
    while (k < this.births.length) {
      const style = this.styles[k];
      const birth = this.births[k];
      if (style === undefined || birth === undefined) break;
      if (!this.isSettled(this.base + k) && birth + lifeOf(style) > t) break;
      k++;
    }
    if (k === 0) return;
    this.births.splice(0, k);
    this.styles.splice(0, k);
    this.base += k;
    while (this.arrivals.length > 0 && (this.arrivals[0]?.end ?? 0) <= this.base) this.arrivals.shift();
    while (this.settled.length > 0 && (this.settled[0]?.to ?? 0) <= this.base) this.settled.shift();
  }

  /** Conservative remaining-crawl estimate; actual birth once born, null if settled. */
  newestBirthEstimate(t: number): number | null {
    if (this.total === this.base || this.isSettled(this.total - 1)) return null;
    const known = this.birthAt(this.total - 1);
    if (known !== null && known !== Infinity) return known;
    let eta = t + TAU_MS;
    let from = this.pos;
    for (const run of this.runs) {
      if (run.end <= from) continue;
      eta += (run.end - from) / Math.min(MIN_CPS / 1000, run.maxPerMs) + SUBSTEP_MS;
      from = run.end;
    }
    return eta;
  }

  reset(): void {
    this.total = this.base = this.pos = this.vel = 0;
    this.settled = [];
    this.clock = null;
    this.runs = [];
    this.births = [];
    this.styles = [];
    this.arrivals = [];
    this.rate = 0;
    this.rateAt = null;
    this.rateFrom = 0;
    this.lastArrival = -Infinity;
  }
  private markSettled(from: number, to: number): void {
    if (to <= from) return;
    const last = this.settled.at(-1);
    if (last && last.to >= from) last.to = Math.max(last.to, to);
    else this.settled.push({ from, to });
  }
  private atRest(): boolean { return this.bornCount >= this.total && this.vel === 0; }
  private retireRuns(): void {
    while (this.runs.length > 0 && (this.runs[0]?.end ?? 0) <= this.bornCount) this.runs.shift();
  }

  private step(g: number): void {
    this.retireRuns();
    const head = this.runs[0];
    if (!head) {
      this.pos = this.total;
      this.vel = 0;
      return;
    }
    this.vel = this.nextVelocity(g, head.maxPerMs);
    const from = this.pos;
    // Stop at a run boundary: never spend a fast run's residual step in a slow run.
    const to = Math.min(head.end, from + this.vel * SUBSTEP_MS);
    this.cross(from, to, g, SUBSTEP_MS);
    if (to >= this.total) this.vel = 0;
  }

  /** Fold `count` characters arriving at `t` into the windowed rate estimate. */
  private noteArrival(t: number, count: number): void {
    if (t - this.lastArrival > RATE_WINDOW_MS) {
      this.rate = 0;
      this.rateAt = null;
      this.rateFrom = t;
    }
    this.rate = this.rawRate(t) + count / RATE_WINDOW_MS;
    this.rateAt = t;
    this.lastArrival = t;
  }
  private rawRate(t: number): number {
    if (this.rateAt === null) return 0;
    return this.rate * Math.exp(-Math.max(0, t - this.rateAt) / RATE_WINDOW_MS);
  }
  /**
   * Windowed rate, corrected for a window that has not filled yet (the start
   * of an answer): without it the first seconds read as a slow stream and
   * the typist falls behind before catching up.
   */
  private rateNow(t: number): number {
    const filled = 1 - Math.exp(-Math.max(WARMUP_MS, t - this.rateFrom) / RATE_WINDOW_MS);
    return this.rawRate(t) / filled;
  }

  /**
   * Invariant (steady typist): the target speed is the stream's windowed
   * average rate plus a slow correction toward `TARGET_LAG_MS` of backlog,
   * and velocity approaches it with first-order smoothing under an
   * acceleration cap. Once the stream is quiet the target never drops below
   * the current speed, so the last words are typed at the same pace instead of
   * crawling out, until the braking curve eases it to rest on the newest
   * character. The ceiling of the run at the front always wins.
   */
  private nextVelocity(g: number, ceiling: number): number {
    const rate = this.rateNow(g);
    const backlog = this.total - this.pos;
    let target = rate + (backlog - rate * TARGET_LAG_MS) / CORRECT_MS;
    if (g - this.lastArrival >= QUIET_MS) target = Math.max(target, this.vel);
    target = Math.min(Math.max(target, MIN_CPS / 1000), ceiling);
    const want = ((target - this.vel) * SUBSTEP_MS) / TAU_MS;
    let next = this.vel + Math.min(Math.max(want, -MAX_BRAKE * SUBSTEP_MS), MAX_ACCEL * SUBSTEP_MS);
    // Braking bypasses the smoothing: following the curve directly is what
    // makes the front arrive at rest instead of arriving at speed.
    const brake = Math.sqrt(2 * MAX_BRAKE * backlog);
    if (next > brake) next = Math.max(brake, this.vel - MAX_BRAKE * SUBSTEP_MS);
    // A slower run must not inherit the preceding run's faster velocity.
    return Math.min(next, ceiling);
  }

  private cross(from: number, to: number, g: number, h: number): void {
    const span = to - from;
    while (this.bornCount + 1 <= to + 1e-9) {
      const k = this.bornCount + 1;
      const at = span > 0 ? g + (h * Math.max(0, k - from)) / span : g + h;
      this.stamp(Math.min(at, g + h));
    }
    this.pos = Math.max(this.pos, to);
  }
  private bornThrough(end: number, t: number): void {
    while (this.bornCount < Math.min(end, this.total)) this.stamp(t);
    this.pos = Math.max(this.pos, this.bornCount);
  }
  private stamp(t: number): void {
    const i = this.bornCount;
    const prev = this.births.at(-1) ?? -Infinity;
    this.births.push(Math.max(t, prev, this.arrivalOf(i)));
  }
  private arrivalOf(i: number): number {
    for (const a of this.arrivals) if (i < a.end) return a.at;
    return -Infinity;
  }
}
