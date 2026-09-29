import { describe, it, expect } from 'vitest';
import { RevealTimeline, MAX_CPS, HEADING_MAX_CPS, MIN_CPS, TAU_MS, TARGET_LAG_MS, type RunSpec } from './smoke-reveal.playhead.js';

const prose = (count: number): RunSpec => ({ count, style: 'ink', capMs: 350, maxCps: MAX_CPS });
const heading = (count: number): RunSpec => ({ count, style: 'smoke', capMs: 900, maxCps: HEADING_MAX_CPS });

const FRAME = 1000 / 60;

/** Bursty stream: 3-5 chars every 18 ms, with a 180 ms stall every 12th chunk. */
function burstyEvents(chunks = 60): [number, number][] {
  const out: [number, number][] = [];
  let t = 0;
  for (let k = 1; k <= chunks; k++) {
    t += k % 12 === 0 ? 180 : 18;
    out.push([t, 3 + (k % 3)]);
  }
  return out;
}

interface Run {
  adv: number[];
  /** Per-frame advance of the float playhead (before integer rounding). */
  fadv: number[];
  arrivalOf: number[];
  birthOf: number[];
  ahead: boolean;
}

/** Drive a timeline with `events` and sample it on a fixed frame clock. */
function drive(events: [number, number][], frame: number, spec: (n: number) => RunSpec = prose): Run {
  const tl = new RevealTimeline();
  const arrivalOf: number[] = [];
  const birthOf: number[] = [];
  const adv: number[] = [];
  const fadv: number[] = [];
  let fprev = 0;
  let ahead = false;
  let ei = 0;
  let prev = 0;
  const end = (events.at(-1)?.[0] ?? 0) + 1_000;
  for (let c = 0; c <= end; c += frame) {
    while (ei < events.length && (events[ei]?.[0] ?? Infinity) <= c) {
      const [at, n] = events[ei] ?? [0, 0];
      tl.record(at, spec(n));
      for (let i = 0; i < n; i++) arrivalOf.push(at);
      ei++;
    }
    tl.advance(c);
    if (tl.bornCount > tl.recorded) ahead = true;
    for (let i = birthOf.length; i < tl.bornCount; i++) birthOf.push(tl.birthAt(i) ?? NaN);
    adv.push(tl.bornCount - prev);
    prev = tl.bornCount;
    fadv.push(tl.position - fprev);
    fprev = tl.position;
  }
  return { adv, fadv, arrivalOf, birthOf, ahead };
}

const maxChange = (xs: number[]): number => {
  let m = 0;
  for (let i = 1; i < xs.length; i++) m = Math.max(m, Math.abs((xs[i] ?? 0) - (xs[i - 1] ?? 0)));
  return m;
};

/** Check actual motion, not just the advertised velocity: catches hidden jumps. */
function sweep(tl: RevealTimeline, start: number, end: number, ceiling: number): void {
  let prev = tl.position;
  for (let t = start + 1; t <= end; t++) {
    tl.advance(t);
    expect(tl.position - prev).toBeGreaterThanOrEqual(0);
    expect(tl.position - prev).toBeLessThanOrEqual(ceiling / 1000 + 1e-9);
    expect(tl.cps).toBeLessThanOrEqual(ceiling + 1e-9);
    prev = tl.position;
  }
}

describe('RevealTimeline', () => {
  it('advances the front smoothly through a bursty stream with stalls (60 fps frames)', () => {
    const { adv, fadv } = drive(burstyEvents(), FRAME);
    // Bound: velocity relaxes toward its target with TAU_MS and the target
    // itself only moves as the backlog does, so the continuous front's
    // per-frame advance changes smoothly between frames.
    // The one exception is the stream's very first character, born the
    // instant it arrives (zero first-token latency), so allow one character
    // plus the continuous bound. The integer front adds at most one character
    // of rounding. The legacy per-burst schedule changed by 3 chars/frame.
    //
    // The 0.6 bound was calibrated for TAU_MS=42.5ms (prose capacity 84 chars).
    // With TAU_MS=100ms the relaxation is gentler, but the smaller prose capacity
    // (capMs*MAX_CPS/1000 = 350*180/1000 = 63 chars) causes slightly larger
    // overflow-settlement pos jumps at burst intakes. Raised to 1.0: still
    // well under one character/frame, still rules out the legacy 3 chars/frame.
    expect(maxChange(fadv.slice(4))).toBeLessThan(1.0);
    expect(maxChange(fadv)).toBeLessThan(1.6);
    expect(maxChange(adv)).toBeLessThanOrEqual(2);
  });

  it('keeps the per-frame change bounded at 30 fps frames too', () => {
    const { adv, fadv } = drive(burstyEvents(), 33);
    // Twice the frame, twice the float bound. Legacy: 5 chars/frame here.
    expect(maxChange(fadv)).toBeLessThan(2);
    expect(maxChange(adv)).toBeLessThanOrEqual(3);
  });

  it('decelerates over at least 3 frames into a stall instead of stopping dead', () => {
    const tl = new RevealTimeline();
    // Steady 200 cps for 400 ms, then silence.
    for (let t = 0; t <= 400; t += 20) tl.record(t, prose(4));
    const speeds: number[] = [];
    for (let c = 400; c <= 400 + 8 * TARGET_LAG_MS; c += FRAME) {
      tl.advance(c);
      speeds.push(tl.cps);
    }
    // The front may still be converging on its target when input stops; from
    // its peak on it only slows, and it is still moving 3 frames past the peak.
    const at = speeds.indexOf(Math.max(...speeds));
    const peak = speeds[at] ?? 0;
    expect(peak).toBeGreaterThan(100);
    for (let i = at + 1; i < speeds.length; i++) expect(speeds[i] ?? 0).toBeLessThanOrEqual((speeds[i - 1] ?? 0) + 1e-9);
    expect(speeds[at + 3] ?? 0).toBeGreaterThan(0);
    expect(speeds[at + 3] ?? 0).toBeLessThan(peak);
    // And it comes to rest with everything born.
    expect(speeds.at(-1)).toBe(0);
    expect(tl.bornCount).toBe(tl.recorded);
  });

  it('never passes the recorded text, and never births a character before it arrived', () => {
    const { ahead, arrivalOf, birthOf } = drive(burstyEvents(), FRAME);
    expect(ahead).toBe(false);
    expect(birthOf.length).toBe(arrivalOf.length);
    for (let i = 0; i < birthOf.length; i++) {
      expect(birthOf[i] ?? NaN).toBeGreaterThanOrEqual(arrivalOf[i] ?? Infinity);
      if (i > 0) expect(birthOf[i] ?? NaN).toBeGreaterThanOrEqual(birthOf[i - 1] ?? Infinity);
    }
  });


  it('accelerates from rest without jumping, even past the old arrival deadline', () => {
    const tl = new RevealTimeline();
    tl.record(0, prose(20));
    expect(tl.position).toBe(1);
    let prev = tl.position;
    let delta = 0;
    for (let t = 1; t <= 1000; t++) {
      tl.advance(t);
      const next = tl.position - prev;
      expect(next).toBeLessThanOrEqual(MAX_CPS / 1000);
      // Acceleration follows the relaxation law; final stopping may be abrupt.
      expect(next - delta).toBeLessThanOrEqual(MAX_CPS / 1000 / TAU_MS + 1e-9);
      expect(tl.isSettled(1)).toBe(false);
      prev = tl.position;
      delta = next;
      if (t === 350) expect(tl.bornCount).toBeLessThan(20);
    }
    expect(tl.bornCount).toBe(20);
    expect(tl.cps).toBe(0);
    tl.record(2000, prose(20));
    expect(tl.birthAt(20)).toBe(2000);
    sweep(tl, 2000, 3000, MAX_CPS);
    expect(tl.bornCount).toBe(40);
  });

  it.each([prose, heading])('settles excess at intake, preserving a fixed newest tail', (spec) => {
    const tl = new RevealTimeline();
    const run = spec(2000);
    tl.record(100, run);
    const tail = Math.floor(run.capMs * run.maxCps / 1000);
    const cut = 2000 - tail;
    expect(tl.position).toBe(cut);
    expect(tl.isSettled(cut - 1)).toBe(true);
    expect(tl.isSettled(cut)).toBe(false);
    expect(tl.birthAt(cut - 1)).toBe(100);
    expect(tl.birthAt(cut)).toBe(Infinity);
    sweep(tl, 100, 4100, run.maxCps);
    expect(tl.isSettled(cut)).toBe(false); // passage of time never overflows
    expect(tl.bornCount).toBe(2000);
    let prev = 100;
    for (let i = 0; i < 2000; i++) {
      const birth = tl.birthAt(i)!;
      expect(birth).toBeGreaterThanOrEqual(prev);
      prev = birth;
    }
  });

  it('bounds combined duration across mixed runs, rather than granting each its own backlog', () => {
    const tl = new RevealTimeline();
    // Capacities derived from the run specs above and the exported constants:
    //   prose capacity  = capMs * MAX_CPS / 1000         = 350 * 180 / 1000 = 63
    //   heading capacity = capMs * HEADING_MAX_CPS / 1000 = 900 * (1000/18) / 1000 = 50
    const PROSE_CAP = 350 * MAX_CPS / 1000;           // 63 chars
    const HEADING_CAP = 900 * HEADING_MAX_CPS / 1000; // 50 chars
    tl.record(0, prose(60));
    // heading(25) uses 25/50 = 0.5 of budget; prose keeps 0.5 * PROSE_CAP = 31.5 chars.
    // settle to ceil(60 - 31.5) = 29.
    tl.record(0, heading(25));
    const pos1 = Math.ceil(60 - 0.5 * PROSE_CAP); // 29
    expect(tl.position).toBe(pos1);
    expect(tl.isSettled(pos1 - 1)).toBe(true);
    expect(tl.isSettled(pos1)).toBe(false);
    // prose(42) uses 42/63 ≈ 2/3 of budget; heading keeps (1 - 2/3) * 50 ≈ 16.67 chars.
    // settle heading at ceil(85 - 16.67) = 69.
    tl.record(0, prose(42));
    const budgetAfterProse = 1 - 42 / PROSE_CAP;                // ≈ 1/3
    const pos2 = Math.ceil(85 - budgetAfterProse * HEADING_CAP); // 69
    expect(tl.position).toBe(pos2);
    expect(tl.isSettled(pos2 - 1)).toBe(true);
    expect(tl.isSettled(pos2)).toBe(false);
  });

  it('caps actual movement entering a slower style even when inheriting high velocity', () => {
    const tl = new RevealTimeline();
    tl.record(0, { ...prose(80), capMs: 10000 });
    tl.record(0, { ...heading(20), capMs: 10000 });
    let prev = tl.position;
    let crossed = false;
    for (let t = 1; t <= 2500; t++) {
      tl.advance(t);
      const limit = prev >= 80 ? HEADING_MAX_CPS : MAX_CPS;
      expect(tl.position - prev).toBeLessThanOrEqual(limit / 1000 + 1e-9);
      if (prev >= 80) crossed = true;
      prev = tl.position;
    }
    expect(crossed).toBe(true);
    expect(tl.bornCount).toBe(100);
  });

  it('overflow never settles letters the playhead already birthed (their fade keeps playing)', () => {
    // Regression: settlement was a prefix marker, so every overflowing intake
    // also flagged the already-born, still-fading letters as settled. On a
    // stream faster than MAX_CPS each letter snapped solid within one chunk
    // interval of birth (~94% of prose popped instead of fading in).
    const tl = new RevealTimeline();
    let t = 0;
    for (let k = 0; k < 40; k++) {
      t += 25; // 12 chars / 25 ms = 480 cps, well above MAX_CPS
      const bornBefore = tl.bornCount;
      const animated: number[] = [];
      for (let i = tl.first; i < bornBefore; i++) if (!tl.isSettled(i)) animated.push(i);
      tl.record(t, prose(12));
      for (const i of animated) expect(tl.isSettled(i)).toBe(false);
      for (let u = t - 24; u <= t; u++) tl.advance(u);
    }
    let settled = 0;
    for (let i = tl.first; i < tl.recorded; i++) if (tl.isSettled(i)) settled++;
    // Only the true excess over MAX_CPS settles at 480 cps: (480-MAX_CPS)/480.
    // With MAX_CPS=240 that was ~50%; with MAX_CPS=180 it is ~62.5%, and boundary
    // effects push the measured fraction to ~65-66%. Using 0.75 gives comfortable
    // margin while still ruling out the 94% regression this test guards against.
    expect(settled / tl.recorded).toBeLessThan(0.75);
    expect(settled).toBeGreaterThan(0);
  });

  it('repeated overload bounds retained memory and only overflows on intake', () => {
    const tl = new RevealTimeline();
    // Retained = queued backlog (<= 84 capacity) + everything that arrived
    // within one fade lifetime: overflow never cuts an in-flight fade short,
    // so settled overflow queued behind a still-fading letter waits for it.
    // Still a fixed bound (arrival rate x lifetime), independent of run length.
    const life = 340;
    const bound = 84 + (Math.ceil(life / 16) + 1) * 100;
    for (let t = 0; t < 2000; t += 16) {
      tl.record(t, prose(100));
      tl.prune(t, () => life);
      expect(tl.recorded - tl.first).toBeLessThanOrEqual(bound);
      sweep(tl, t, t + 16, MAX_CPS);
    }
    tl.advance(6000);
    tl.prune(20000, () => 10000);
    expect(tl.first).toBe(tl.recorded);
  });

  it('is cadence-independent, including fractional arrivals, overflow, pruning and styles', () => {
    const run = (period: number): (number | null)[] => {
      const tl = new RevealTimeline();
      const events: [number, RunSpec][] = [[0.7, prose(5)], [10.3, prose(2000)], [31.2, heading(30)], [120.8, prose(4)]];
      let at = 0;
      for (const [t, spec] of events) {
        while (at < t) { tl.advance(at); tl.prune(at, () => 400); at += period; }
        tl.record(t, spec);
      }
      tl.advance(4000);
      return Array.from({ length: tl.recorded }, (_, i) => tl.isSettled(i) ? null : tl.birthAt(i));
    };
    expect(run(7)).toEqual(run(1000 / 60));
  });

  it('keeps overflow births truthful across multiple fractional arrivals', () => {
    const tl = new RevealTimeline();
    const arrivals: number[] = [];
    for (const [at, count] of [[0.7, 20], [120.3, 500], [121.9, 200]] as const) {
      tl.record(at, prose(count));
      arrivals.push(...Array<number>(count).fill(at));
    }
    tl.advance(5000);
    let previous = -Infinity;
    for (let i = 0; i < arrivals.length; i++) {
      const birth = tl.birthAt(i)!;
      expect(birth).toBeGreaterThanOrEqual(arrivals[i]!);
      expect(birth).toBeGreaterThanOrEqual(previous);
      previous = birth;
    }
  });

  it('trimNewest and retirement do not strand a run or reuse settlement for new text', () => {
    const tl = new RevealTimeline();
    tl.record(0, prose(200));
    tl.trimNewest(100); // trim into settled prefix
    expect(tl.recorded).toBe(100);
    expect(tl.newestBirthEstimate(0)).toBeNull();
    tl.record(0, prose(4));
    expect(tl.isSettled(100)).toBe(false);
    expect(tl.birthAt(100)).toBe(0);
    sweep(tl, 0, 1000, MAX_CPS);
    expect(tl.bornCount).toBe(104);
    tl.prune(2000, () => 100);
    expect(tl.first).toBe(104);
    tl.reset();
    expect(tl.recorded).toBe(0);
    expect(tl.position).toBe(0);
    tl.record(3000, prose(2));
    expect(tl.isSettled(0)).toBe(false);
  });

  it('estimates remaining motion instead of clamping to an arrival deadline', () => {
    const tl = new RevealTimeline();
    tl.record(0, prose(500));
    const estimate = tl.newestBirthEstimate(0)!;
    expect(estimate).toBeGreaterThan(350);
    tl.advance(350);
    expect(tl.newestBirthEstimate(350)).toBeGreaterThan(350);
    tl.advance(estimate);
    expect(tl.bornCount).toBe(500);
    expect(tl.newestBirthEstimate(estimate)).toBe(tl.birthAt(499));
  });

  it('respects custom ceilings below MIN_CPS, and instant and zero-budget runs', () => {
    const tl = new RevealTimeline();
    tl.record(0, { ...prose(3), maxCps: MIN_CPS / 3, capMs: 1000 });
    sweep(tl, 0, 1000, MIN_CPS / 3);
    expect(tl.bornCount).toBe(3);
    tl.record(1000, { ...prose(12), maxCps: Infinity, capMs: 0 });
    expect(tl.birthAt(14)).toBe(1000);
    tl.record(1000, { ...prose(12), capMs: 0 });
    expect(tl.isSettled(26)).toBe(true);
    expect(tl.newestBirthEstimate(1000)).toBeNull();
  });
});
