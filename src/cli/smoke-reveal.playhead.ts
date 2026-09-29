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
 * much. Long enough that the front glides at the stream's average rate
 * instead of sprinting through each network chunk and then stopping; a
 * simulation of bursty and pausing streams showed 170 ms stalled the front
 * ~15% of the time at sentence pauses, 400 ms ~0%.
 */
export const TARGET_LAG_MS = 400;
/** Velocity relaxation time. */
export const TAU_MS = TARGET_LAG_MS / 4;
/**
 * Slowest target crawl while any character is waiting. With the 400 ms lag
 * the backlog drains exponentially once a stream ends, so this floor sets how
 * fast an answer's final letters come out: at 30 the last ten crawled at
 * ~33 cps and the last letter landed ~1.25 s after the final arrival; at 60
 * they come out at ~62 cps and the tail finishes ~0.2 s sooner.
 */
export const MIN_CPS = 60;
/** Prose speed ceiling; intake settles excess backlog instead of speeding up. */
export const MAX_CPS = 180;
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
    const target = Math.min(Math.max((this.total - this.pos) / TARGET_LAG_MS, MIN_CPS / 1000), head.maxPerMs);
    this.vel += ((target - this.vel) * SUBSTEP_MS) / TAU_MS;
    // A slower run must not inherit the preceding run's faster velocity.
    this.vel = Math.min(this.vel, head.maxPerMs);
    const from = this.pos;
    // Stop at a run boundary: never spend a fast run's residual step in a slow run.
    const to = Math.min(head.end, from + this.vel * SUBSTEP_MS);
    this.cross(from, to, g, SUBSTEP_MS);
    if (to >= this.total) this.vel = 0;
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
