/**
 * Tests for the wait_for queue-to-stop hint: the pure copy function, the
 * root-only tracker helpers, and the spinner's context-tip override of the tip
 * row (including that it shows with AFK_SPINNER_TIPS=0 while rotating tips stay
 * hidden).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InFlightToolTracker,
  WAIT_HINT_TOOL,
  noteRootWaitEvent,
  waitHintText,
} from './work-derived-verb.js';
import { SpinnerController } from './spinner.js';
import { formatTipRow } from '../terminal-compositor.scrollback.js';

const strip = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, '');

const start = (id: string, toolName: string) =>
  ({ type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: id, toolName } }) as const;
const done = (id: string) => ({ type: 'chunk', chunk: { type: 'tool_result', toolUseId: id } }) as const;

describe('waitHintText', () => {
  it('returns nothing when no root wait is in flight, queued or not', () => {
    expect(waitHintText({ waiting: false, queued: false })).toBeUndefined();
    expect(waitHintText({ waiting: false, queued: true })).toBeUndefined();
  });

  it('tells the user how to stop the wait while waiting', () => {
    expect(waitHintText({ waiting: true, queued: false })).toBe('type a message + Enter to stop waiting');
  });

  it('confirms the queued message will stop the wait, without promising it is read next', () => {
    const text = waitHintText({ waiting: true, queued: true })!;
    expect(text).toContain('message queued');
    expect(text).toContain('wait will stop');
    expect(text).not.toMatch(/reads? it next/);
  });
});

describe('InFlightToolTracker.has', () => {
  it('stays true while any parallel call of that tool is in flight', () => {
    const t = new InFlightToolTracker();
    t.start('a', 'wait_for');
    t.start('b', 'wait_for');
    t.start('c', 'bash');
    t.finish('a');
    expect(t.has('wait_for')).toBe(true);
    t.finish('b');
    expect(t.has('wait_for')).toBe(false);
    expect(t.has('bash')).toBe(true);
  });
});

describe('noteRootWaitEvent', () => {
  it('pushes true on wait_for start and false on its result', () => {
    const t = new InFlightToolTracker();
    const seen: boolean[] = [];
    const sink = { setRootWaitActive: (v: boolean) => { seen.push(v); } };
    expect(WAIT_HINT_TOOL).toBe('wait_for');
    noteRootWaitEvent(start('w', 'wait_for'), t, sink);
    noteRootWaitEvent(start('r', 'read_file'), t, sink);
    noteRootWaitEvent(done('r'), t, sink);
    noteRootWaitEvent(done('w'), t, sink);
    expect(seen).toEqual([true, true, true, false]);
  });

  it('never calls the verb setter (the session-wide tracker owns that)', () => {
    const t = new InFlightToolTracker();
    const verbs: unknown[] = [];
    noteRootWaitEvent(start('w', 'wait_for'), t, { setActiveToolName: (n) => verbs.push(n) });
    expect(verbs).toEqual([]);
  });

  it('ignores non-tool events and tolerates sinks without the setter', () => {
    const t = new InFlightToolTracker();
    expect(noteRootWaitEvent({ type: 'chunk', chunk: { type: 'content' } }, t, {})).toBe(false);
    expect(() => noteRootWaitEvent(start('w', 'wait_for'), t, {})).not.toThrow();
  });
});

describe('formatTipRow label', () => {
  it('defaults to Tip and accepts Hint', () => {
    expect(strip(formatTipRow('x', 80))).toBe('  Tip: x');
    expect(strip(formatTipRow('x', 80, 'Hint'))).toBe('  Hint: x');
  });

  it('still truncates to the terminal width with a custom label', () => {
    const row = strip(formatTipRow('y'.repeat(200), 40, 'Hint'));
    expect(row.length).toBeLessThanOrEqual(40);
    expect(row.endsWith('…')).toBe(true);
  });
});

describe('SpinnerController contextTip', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['AFK_SPINNER_TIPS']; });
  afterEach(() => {
    if (saved === undefined) delete process.env['AFK_SPINNER_TIPS'];
    else process.env['AFK_SPINNER_TIPS'] = saved;
  });

  it('renders the hint immediately (no warmup) with a Hint label', () => {
    const c = new SpinnerController({ captureMode: false, onTick: () => {}, contextTip: () => 'stop me' });
    c.set({ enabled: true });
    const row = c.renderTipRow(80);
    c.dispose();
    expect(strip(row!)).toBe('  Hint: stop me');
  });

  /** Run a spinner past the tip warmup; returns the tip row with and without a hint. */
  function rowsAfterWarmup(): { withHint: string | null; withoutHint: string | null } {
    vi.useFakeTimers();
    try {
      let hint: string | undefined = 'stop me';
      const c = new SpinnerController({ captureMode: false, onTick: () => {}, contextTip: () => hint });
      c.set({ enabled: true });
      vi.advanceTimersByTime(3_000); // past the 1500ms warmup; ticks run selectTip
      const withHint = c.renderTipRow(200);
      hint = undefined;
      const withoutHint = c.renderTipRow(200);
      c.dispose();
      return { withHint, withoutHint };
    } finally {
      vi.useRealTimers();
    }
  }

  it('shows the hint with AFK_SPINNER_TIPS=0, while rotating tips stay hidden', () => {
    process.env['AFK_SPINNER_TIPS'] = '0';
    const { withHint, withoutHint } = rowsAfterWarmup();
    expect(strip(withHint!)).toBe('  Hint: stop me');
    // Empty tip pool under the opt-out: no rotating tip falls through.
    expect(withoutHint).toBeNull();
  });

  it('control: with tips on, the hint still wins and a rotating Tip returns once it clears', () => {
    delete process.env['AFK_SPINNER_TIPS'];
    const { withHint, withoutHint } = rowsAfterWarmup();
    expect(strip(withHint!)).toBe('  Hint: stop me');
    expect(strip(withoutHint ?? '')).toMatch(/^ {2}Tip: /);
  });

  it('renders nothing when the spinner is off, and survives a throwing provider', () => {
    const off = new SpinnerController({ captureMode: false, onTick: () => {}, contextTip: () => 'x' });
    expect(off.renderTipRow(80)).toBeNull();
    const broken = new SpinnerController({
      captureMode: false,
      onTick: () => {},
      contextTip: () => { throw new Error('boom'); },
    });
    broken.set({ enabled: true });
    expect(() => broken.renderTipRow(80)).not.toThrow();
    broken.dispose();
  });
});
