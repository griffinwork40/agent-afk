/**
 * Tests for the progress-banner child-activity selector.
 *
 * The load-bearing behaviour here is the STICKINESS rule: without it, N chatty
 * subagents swap the banner's detail line on every repaint, producing motion
 * that is technically work-derived but unreadable — the exact failure this
 * feature exists to avoid. Most of these cases pin that hold.
 */

import { describe, it, expect } from 'vitest';
import {
  ChildActivityTracker,
  deriveChildBanner,
  formatChildActivity,
  CHILD_QUIET_MS,
  STICKY_HOLD_MS,
} from './child-activity-select.js';
import { ORCHESTRATOR_SOURCE_KEY, type SourceState } from './stream-renderer-source.js';

const NOW = 1_000_000;

function makeSource(over: Partial<SourceState> = {}): SourceState {
  return {
    startedAt: NOW - 60_000,
    lastEventAt: NOW,
    stats: { tokens: 0, toolUses: 0 },
    contentBuffer: '',
    done: false,
    errored: false,
    stalledTicks: 0,
    ...over,
  };
}

/** A healthy, recently-active child with a provider round headline. */
function activeChild(agentType: string, over: Partial<SourceState> = {}): SourceState {
  return makeSource({
    agentType,
    lastProgressSummary: `round 2: Read ${agentType}.ts`,
    stats: { tokens: 100, toolUses: 4 },
    ...over,
  });
}

describe('ChildActivityTracker.select', () => {
  it('returns undefined when there are no sources at all', () => {
    expect(new ChildActivityTracker().select(new Map(), NOW)).toBeUndefined();
  });

  it('ignores the orchestrator source — it is not a child', () => {
    const sources = new Map<string, SourceState>([
      [ORCHESTRATOR_SOURCE_KEY, activeChild('main')],
    ]);
    expect(new ChildActivityTracker().select(sources, NOW)).toBeUndefined();
  });

  it('ignores children that are done or errored', () => {
    const sources = new Map<string, SourceState>([
      ['a', activeChild('sees', { done: true })],
      ['b', activeChild('signals', { errored: true })],
    ]);
    expect(new ChildActivityTracker().select(sources, NOW)).toBeUndefined();
  });

  it('names a single running child using the provider round headline', () => {
    const sources = new Map<string, SourceState>([['a', activeChild('sees')]]);
    const picked = new ChildActivityTracker().select(sources, NOW);
    expect(picked).toMatchObject({
      sourceId: 'a',
      label: 'sees',
      clause: 'round 2: Read sees.ts',
      quiet: false,
    });
    expect(formatChildActivity(picked!)).toBe('sees · round 2: Read sees.ts');
  });

  it('falls back to the tool-call count when no round headline has arrived', () => {
    const sources = new Map<string, SourceState>([
      ['a', makeSource({ agentType: 'sees', stats: { tokens: 0, toolUses: 7 } })],
    ]);
    expect(new ChildActivityTracker().select(sources, NOW)?.clause).toBe('7 tool calls');
  });

  it('returns undefined when a child has produced nothing worth reporting', () => {
    // No summary and no tool calls yet — better to leave the slot to the
    // banner's own summary than render a hollow "sees ·" with nothing after it.
    const sources = new Map<string, SourceState>([
      ['a', makeSource({ agentType: 'sees' })],
    ]);
    expect(new ChildActivityTracker().select(sources, NOW)).toBeUndefined();
  });

  it('falls back to the raw source key when agentType is absent', () => {
    const sources = new Map<string, SourceState>([
      ['sub-42', activeChild('x', { agentType: undefined })],
    ]);
    expect(new ChildActivityTracker().select(sources, NOW)?.label).toBe('sub-42');
  });

  it('picks the freshest child on a cold tracker', () => {
    const sources = new Map<string, SourceState>([
      ['stale', activeChild('stale', { lastEventAt: NOW - 5_000 })],
      ['fresh', activeChild('fresh', { lastEventAt: NOW - 10 })],
    ]);
    expect(new ChildActivityTracker().select(sources, NOW)?.sourceId).toBe('fresh');
  });

  it('breaks exact-timestamp ties deterministically by source key', () => {
    const sources = new Map<string, SourceState>([
      ['zebra', activeChild('zebra')],
      ['alpha', activeChild('alpha')],
    ]);
    // Insertion order puts zebra first; the sort must still choose alpha so the
    // line does not flip between equally-fresh children across repaints.
    expect(new ChildActivityTracker().select(sources, NOW)?.sourceId).toBe('alpha');
    expect(new ChildActivityTracker().select(sources, NOW)?.sourceId).toBe('alpha');
  });

  describe('stickiness (anti-thrash)', () => {
    it('HOLDS the incumbent while it is quiet for less than the hold window', () => {
      const tracker = new ChildActivityTracker();
      const first = new Map<string, SourceState>([
        ['a', activeChild('a', { lastEventAt: NOW })],
        ['b', activeChild('b', { lastEventAt: NOW - 50 })],
      ]);
      expect(tracker.select(first, NOW)?.sourceId).toBe('a');

      // `b` is now strictly fresher, but `a` has only been quiet 1s — under the
      // 3s hold, so the line must NOT jump. This is the thrash guard.
      const later = new Map<string, SourceState>([
        ['a', activeChild('a', { lastEventAt: NOW })],
        ['b', activeChild('b', { lastEventAt: NOW + 900 })],
      ]);
      expect(tracker.select(later, NOW + 1_000)?.sourceId).toBe('a');
    });

    it('SWITCHES once the incumbent exceeds the hold window and a fresher sibling exists', () => {
      const tracker = new ChildActivityTracker();
      const sources = new Map<string, SourceState>([
        ['a', activeChild('a', { lastEventAt: NOW })],
        ['b', activeChild('b', { lastEventAt: NOW })],
      ]);
      expect(tracker.select(sources, NOW)?.sourceId).toBe('a');

      const later = new Map<string, SourceState>([
        ['a', activeChild('a', { lastEventAt: NOW })],
        ['b', activeChild('b', { lastEventAt: NOW + STICKY_HOLD_MS + 500 })],
      ]);
      expect(tracker.select(later, NOW + STICKY_HOLD_MS + 600)?.sourceId).toBe('b');
    });

    it('KEEPS the incumbent when every child is equally quiet', () => {
      // Switching between two silent children is churn with no information.
      const tracker = new ChildActivityTracker();
      const at = (t: number) =>
        new Map<string, SourceState>([
          ['b', activeChild('b', { lastEventAt: t })],
          ['c', activeChild('c', { lastEventAt: t })],
        ]);
      const firstPick = tracker.select(at(NOW), NOW)?.sourceId;
      const secondPick = tracker.select(at(NOW), NOW + STICKY_HOLD_MS * 3)?.sourceId;
      expect(secondPick).toBe(firstPick);
    });

    it('drops a held child once it completes', () => {
      const tracker = new ChildActivityTracker();
      const running = new Map<string, SourceState>([['a', activeChild('a')]]);
      expect(tracker.select(running, NOW)?.sourceId).toBe('a');

      const finished = new Map<string, SourceState>([
        ['a', activeChild('a', { done: true })],
        ['b', activeChild('b')],
      ]);
      expect(tracker.select(finished, NOW + 100)?.sourceId).toBe('b');
    });

    it('reset() clears the sticky selection so state never leaks across turns', () => {
      const tracker = new ChildActivityTracker();
      const sources = new Map<string, SourceState>([
        ['a', activeChild('a', { lastEventAt: NOW })],
        ['b', activeChild('b', { lastEventAt: NOW - 5_000 })],
      ]);
      expect(tracker.select(sources, NOW)?.sourceId).toBe('a');
      tracker.reset();
      const flipped = new Map<string, SourceState>([
        ['a', activeChild('a', { lastEventAt: NOW - 5_000 })],
        ['b', activeChild('b', { lastEventAt: NOW })],
      ]);
      expect(tracker.select(flipped, NOW)?.sourceId).toBe('b');
    });
  });

  describe('quiet-child reporting', () => {
    it('names the silence once a child passes the quiet threshold', () => {
      const sources = new Map<string, SourceState>([
        ['a', activeChild('sees', { lastEventAt: NOW - 41_000 })],
      ]);
      const picked = new ChildActivityTracker().select(sources, NOW);
      expect(picked?.quiet).toBe(true);
      expect(picked?.clause).toBe('no output for 41s');
      // The silence must win over the stale round headline — reporting old work
      // as if current is what makes a hung wave look healthy.
      expect(picked?.clause).not.toContain('round 2');
    });

    it('does not flag a child just under the quiet threshold', () => {
      const sources = new Map<string, SourceState>([
        ['a', activeChild('sees', { lastEventAt: NOW - (CHILD_QUIET_MS - 1_000) })],
      ]);
      const picked = new ChildActivityTracker().select(sources, NOW);
      expect(picked?.quiet).toBe(false);
      expect(picked?.clause).toBe('round 2: Read sees.ts');
    });

    it('reports silence even for a child that never produced any output', () => {
      const sources = new Map<string, SourceState>([
        ['a', makeSource({ agentType: 'sees', lastEventAt: NOW - 45_000 })],
      ]);
      expect(new ChildActivityTracker().select(sources, NOW)?.clause).toBe(
        'no output for 45s',
      );
    });
  });
});

describe('deriveChildBanner', () => {
  const wired = () => ({
    sources: new Map<string, SourceState>([['a', activeChild('sees')]]),
    childActivity: new ChildActivityTracker(),
  });

  it('returns undefined when the ctx omits the live wiring', () => {
    // Non-TTY surfaces and existing tests must keep their prior behaviour.
    expect(deriveChildBanner({})).toBeUndefined();
    expect(deriveChildBanner({ sources: new Map() })).toBeUndefined();
    expect(deriveChildBanner({ childActivity: new ChildActivityTracker() })).toBeUndefined();
  });

  it('composes the label and clause into one plain-text line', () => {
    expect(deriveChildBanner(wired(), NOW)?.activity).toBe('sees · round 2: Read sees.ts');
  });

  it('emits no ANSI — the banner owns dimming and width math', () => {
    // eslint-disable-next-line no-control-regex
    expect(deriveChildBanner(wired(), NOW)?.activity).not.toMatch(/\u001b\[/);
  });

  it('reports stats scoped to the SAME child it names, not the parent', () => {
    const sources = new Map<string, SourceState>([['a', activeChild('sees')]]);
    const child = sources.get('a')!;
    child.stats.toolUses = 52;
    child.stats.tokens = 47_000;
    child.startedAt = NOW - 1_400_000; // 23m20s ago

    const banner = deriveChildBanner({ sources, childActivity: new ChildActivityTracker() }, NOW);
    expect(banner?.stats).toEqual({
      toolUses: 52,
      totalTokens: 47_000,
      durationMs: 1_400_000,
    });
  });

  it('never reports a negative elapsed when the clock skews backwards', () => {
    const sources = new Map<string, SourceState>([['a', activeChild('sees')]]);
    sources.get('a')!.startedAt = NOW + 5_000;
    const banner = deriveChildBanner({ sources, childActivity: new ChildActivityTracker() }, NOW);
    expect(banner?.stats.durationMs).toBe(0);
  });
});
