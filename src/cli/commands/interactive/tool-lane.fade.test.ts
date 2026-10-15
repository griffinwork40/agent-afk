/**
 * ToolLane + AFK_SMOKE_TEXT whole-element fade.
 *
 * Pins:
 *  1. No fade attached (smoke off) → the overlay is byte-identical to a lane
 *     that never heard of fades.
 *  2. A new root row enters faded (same visible text, ramp styling, no
 *     particle glyphs) and, once the fade elapses, renders byte-identical to
 *     the fade-free overlay with no new events.
 *  3. Rows fade independently: an already-settled row is untouched when a
 *     new row arrives below it.
 *  4. Scrollback (flush) never carries fade styling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { ToolLane } from './tool-lane.js';
import { ElementFade, FADE_MS } from '../../smoke-fade.js';
import { resetSmokeToneCache } from '../../smoke-reveal.tones.js';
import { SMOKE_GLYPHS } from '../../smoke-reveal.js';
import { stripAnsi } from '../../display.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';

const ok = (content: string): ToolResultChunk => ({ type: 'tool_result', toolUseId: 'unused', content, isError: false });
const RAMP = /\u001b\[38;2;\d+;\d+;\d+m/;

function twinLanes(): { plain: ToolLane; faded: ToolLane; fade: ElementFade } {
  const plain = new ToolLane();
  const faded = new ToolLane();
  const fade = new ElementFade(vi.fn());
  faded.fade = fade;
  return { plain, faded, fade };
}

function both(lanes: { plain: ToolLane; faded: ToolLane }, fn: (l: ToolLane) => void): void {
  fn(lanes.plain);
  fn(lanes.faded);
}

let savedLevel: typeof chalk.level;
beforeEach(() => {
  vi.useFakeTimers();
  savedLevel = chalk.level;
  chalk.level = 3;
  resetSmokeToneCache();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  chalk.level = savedLevel;
});

describe('ToolLane overlay with a whole-element fade', () => {
  it('without a fade attached, renders exactly as before', () => {
    const lane = new ToolLane();
    lane.addStart('t1', 'Read', '("a.ts")');
    const before = lane.getOverlay();
    lane.fade = null;
    expect(lane.getOverlay()).toBe(before);
  });

  it('a new row enters faded, then settles byte-identical with no new events', () => {
    const lanes = twinLanes();
    both(lanes, (l) => l.addStart('t1', 'Read', '("src/a.ts")'));
    const entering = lanes.faded.getOverlay();
    const reference = lanes.plain.getOverlay();
    expect(stripAnsi(entering)).toBe(stripAnsi(reference));
    expect(entering).not.toBe(reference);
    expect(entering).toMatch(RAMP);
    for (const g of SMOKE_GLYPHS) expect(stripAnsi(entering)).not.toContain(g);

    vi.advanceTimersByTime(FADE_MS);
    expect(lanes.faded.getOverlay()).toBe(lanes.plain.getOverlay());
  });

  it('completion inside the fade window keeps fading; afterwards it is byte-identical', () => {
    const lanes = twinLanes();
    both(lanes, (l) => l.addStart('t1', 'Bash', '("ls")'));
    lanes.faded.getOverlay(); // first visible frame starts the fade
    vi.advanceTimersByTime(FADE_MS / 3);
    both(lanes, (l) => l.addResult('t1', ok('3 files')));
    const mid = lanes.faded.getOverlay();
    expect(stripAnsi(mid)).toBe(stripAnsi(lanes.plain.getOverlay()));
    expect(mid).toMatch(RAMP);
    vi.advanceTimersByTime(FADE_MS);
    expect(lanes.faded.getOverlay()).toBe(lanes.plain.getOverlay());
  });

  it('fades each root independently: a settled row is untouched when a new one arrives', () => {
    const lanes = twinLanes();
    both(lanes, (l) => l.addStart('t1', 'Read', '("a.ts")'));
    lanes.faded.getOverlay();
    vi.advanceTimersByTime(FADE_MS);
    both(lanes, (l) => l.addStart('t2', 'Grep', '("needle")'));
    const fadedRows = lanes.faded.getOverlay().split('\n');
    const plainRows = lanes.plain.getOverlay().split('\n');
    expect(fadedRows).toHaveLength(plainRows.length);
    const readIdx = plainRows.findIndex((r) => stripAnsi(r).includes('Read'));
    const grepIdx = plainRows.findIndex((r) => stripAnsi(r).includes('Grep'));
    expect(fadedRows[readIdx]).toBe(plainRows[readIdx]);
    expect(fadedRows[grepIdx]).not.toBe(plainRows[grepIdx]);
    expect(stripAnsi(fadedRows[grepIdx]!)).toBe(stripAnsi(plainRows[grepIdx]!));
  });

  it('fades a dispatch head together with its child rows', () => {
    const lanes = twinLanes();
    both(lanes, (l) => {
      l.addStartWithAgentContext('a1', 'Agent', '(research)', undefined);
      l.addStartWithAgentContext('c1', 'Read', '("x.ts")', 'a1');
    });
    const fadedRows = lanes.faded.getOverlay().split('\n');
    const plainRows = lanes.plain.getOverlay().split('\n');
    expect(fadedRows.length).toBeGreaterThan(1);
    fadedRows.forEach((row, i) => {
      expect(stripAnsi(row)).toBe(stripAnsi(plainRows[i]!));
      if (stripAnsi(row).trim()) expect(row).not.toBe(plainRows[i]);
    });
  });

  it('a tool call joining a settled subagent fades in on its own; the rest stays byte-identical', () => {
    const lanes = twinLanes();
    both(lanes, (l) => {
      l.addStartWithAgentContext('a1', 'Agent', '(research)', undefined);
      l.addStartWithAgentContext('c1', 'Read', '("x.ts")', 'a1');
    });
    lanes.faded.getOverlay();
    vi.advanceTimersByTime(FADE_MS);
    both(lanes, (l) => l.addStartWithAgentContext('c2', 'Grep', '("late_child")', 'a1'));
    const fadedRows = lanes.faded.getOverlay().split('\n');
    const plainRows = lanes.plain.getOverlay().split('\n');
    expect(fadedRows).toHaveLength(plainRows.length);
    let changed = 0;
    fadedRows.forEach((row, i) => {
      expect(stripAnsi(row)).toBe(stripAnsi(plainRows[i]!));
      if (row !== plainRows[i]) {
        changed++;
        // Only the late child's own rows (head + in-progress continuation) fade.
        const belongsToLateChild = stripAnsi(row).includes('late_child') || stripAnsi(plainRows[i - 1] ?? '').includes('late_child');
        expect(belongsToLateChild).toBe(true);
      }
    });
    expect(changed).toBeGreaterThan(0);
    vi.advanceTimersByTime(FADE_MS);
    expect(lanes.faded.getOverlay()).toBe(lanes.plain.getOverlay());
  });

  it('collapsing settled child rows into a group line does not re-fade them', () => {
    const lanes = twinLanes();
    both(lanes, (l) => {
      l.addStartWithAgentContext('a1', 'Agent', '(sweep)', undefined);
      l.addStartWithAgentContext('r1', 'Read', '("a.ts")', 'a1');
      l.addResult('r1', ok('10 lines'));
    });
    lanes.faded.getOverlay();
    vi.advanceTimersByTime(FADE_MS);
    // Enough same-tool siblings to cross the grouping threshold.
    both(lanes, (l) => {
      for (let i = 2; i <= 6; i++) {
        l.addStartWithAgentContext(`r${i}`, 'Read', `("f${i}.ts")`, 'a1');
        l.addResult(`r${i}`, ok('10 lines'));
      }
    });
    const plain = lanes.plain.getOverlay();
    const groupRow = plain.split('\n').findIndex((r) => stripAnsi(r).includes('Read ×6'));
    expect(groupRow).toBeGreaterThanOrEqual(0); // leaf threshold is 3, so 6 Reads group
    // The group inherits r1's (settled) birth, so its row is already solid.
    expect(lanes.faded.getOverlay()).toBe(plain);
  });

  it('never leaks fade styling into scrollback', () => {
    const lanes = twinLanes();
    both(lanes, (l) => {
      l.addStart('t1', 'Read', '("a.ts")');
      l.addResult('t1', ok('12 lines'));
    });
    lanes.faded.getOverlay(); // mid-fade frame
    expect(lanes.faded.flush()).toEqual(lanes.plain.flush());
  });
});
