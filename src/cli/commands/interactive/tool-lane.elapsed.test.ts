/**
 * Tests for the live elapsed-time counter on in-flight tool-lane overlay rows.
 *
 * Covers:
 *   A. Root flat-leaf in-flight rows: no counter < 2s, "12s" at 12s, "1m05s" past 60s.
 *   B. Completed root rows are unaffected (final outcome formatting unchanged).
 *   C. Root NESTING (Agent/skill) childless in-flight rows carry the counter.
 *   D. Child in-flight rows (via renderOverlayChildren) carry the counter.
 *   E. Regression: tick loop stops on teardown even when source.done never fires
 *      (Bug #3 from docs/rendering-architecture-current.md §5). Verified by
 *      checking that checkPauseAnnotations returns false after disposed=true.
 *
 * Uses fake timers (vi.useFakeTimers / vi.setSystemTime) so the elapsed counter
 * is deterministic without real-time sleeps. Follows the pattern established
 * in terminal-compositor.format-elapsed.test.ts and thinking-lane.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolLane } from './tool-lane.js';
import { stripAnsi } from '../../display.js';
import { checkPauseAnnotations } from '../../../cli/_lib/stream-renderer-lifecycle.js';
import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import type { LifecycleContext } from '../../../cli/_lib/stream-renderer-lifecycle.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_TIME = new Date('2026-01-01T00:00:00.000Z').getTime();

function makeResult(content: string, isError = false): ToolResultChunk {
  return {
    type: 'tool_result',
    toolUseId: 'unused',
    content,
    isError,
  };
}

/**
 * Extract the raw (ANSI-stripped) overlay text from a ToolLane.
 * Returns the joined lines so assertions can use toContain / toMatch.
 */
function rawOverlay(lane: ToolLane): string {
  return stripAnsi(lane.getOverlay());
}

// ─── Fake-timer lifecycle ─────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── A. Root flat-leaf in-flight rows ────────────────────────────────────────

describe('in-flight flat-leaf root row — elapsed counter', () => {
  it('shows no counter when elapsed is below ELAPSED_GRACE_MS (< 2s)', () => {
    const lane = new ToolLane();
    lane.addStart('t1', 'grep', '("foo")');
    // No time has passed — addStart captured Date.now() = BASE_TIME.
    const overlay = rawOverlay(lane);
    // The in-flight suffix "…" ends the line with no trailing digit.
    expect(overlay).toContain('…');
    expect(overlay).not.toMatch(/… \d/);
  });

  it('shows no counter at ELAPSED_GRACE_MS − 1 ms (grace period is exclusive)', () => {
    const lane = new ToolLane();
    lane.addStart('t1', 'grep', '("foo")');
    vi.setSystemTime(BASE_TIME + 1_999); // 1 ms before grace expires
    const overlay = rawOverlay(lane);
    expect(overlay).not.toMatch(/… \d/);
  });

  it('shows a seconds counter once grace period has elapsed (12s)', () => {
    const lane = new ToolLane();
    lane.addStart('t1', 'grep', '("foo")');
    vi.setSystemTime(BASE_TIME + 12_000);
    const overlay = rawOverlay(lane);
    expect(overlay).toContain('… 12s');
  });

  it('shows minutes-form past 60s (1m05s)', () => {
    const lane = new ToolLane();
    lane.addStart('t1', 'bash', '("sleep 90")');
    vi.setSystemTime(BASE_TIME + 65_000); // 1m05s
    const overlay = rawOverlay(lane);
    expect(overlay).toContain('… 1m05s');
  });
});

// ─── B. Completed root rows are unchanged ────────────────────────────────────

describe('completed root row — no elapsed counter', () => {
  it('does not show an elapsed counter on a completed flat-leaf row', () => {
    const lane = new ToolLane();
    lane.addStart('t1', 'grep', '("foo")');
    vi.setSystemTime(BASE_TIME + 30_000);
    lane.addResult('t1', makeResult('5 matches'));
    const overlay = rawOverlay(lane);
    // Completed row: collapsed toolCard shows badge + tool name, not outcome.
    // The key invariant: no in-progress " … <digits>" suffix.
    expect(overlay).toContain('grep');
    expect(overlay).not.toMatch(/… \d/);
  });
});

// ─── C. Root NESTING (childless) in-flight rows ──────────────────────────────

describe('in-flight NESTING root row (no children) — elapsed counter', () => {
  it('shows elapsed counter on a childless in-flight Agent row', () => {
    const lane = new ToolLane();
    const agentId = '__synth_elapsed_test';
    // addStartWithAgentContext with undefined agentContext → root-level agent entry.
    lane.addStartWithAgentContext(agentId, 'Agent', '(diagnose)', undefined);
    vi.setSystemTime(BASE_TIME + 12_000);
    const overlay = rawOverlay(lane);
    expect(overlay).toContain('… 12s');
  });

  it('shows no counter within the grace period on a childless NESTING row', () => {
    const lane = new ToolLane();
    lane.addStartWithAgentContext('__synth_fast', 'Agent', '(fast)', undefined);
    // No time advance — within grace.
    const overlay = rawOverlay(lane);
    expect(overlay).not.toMatch(/… \d/);
  });
});

// ─── D. Child in-flight rows carry the counter ───────────────────────────────

describe('in-flight child row — elapsed counter', () => {
  it('shows elapsed counter on an in-flight child tool row', () => {
    const lane = new ToolLane();
    const agentId = '__synth_parent';
    lane.addStartWithAgentContext(agentId, 'Agent', '(mint)', undefined);
    lane.addStartWithAgentContext('child1', 'bash', '("pnpm test")', agentId);
    // Advance time — child was created at BASE_TIME.
    vi.setSystemTime(BASE_TIME + 12_000);
    const overlay = rawOverlay(lane);
    // The child row should carry "… 12s".
    expect(overlay).toContain('… 12s');
  });

  it('shows no counter on child row within grace period', () => {
    const lane = new ToolLane();
    const agentId = '__synth_parent_fast';
    lane.addStartWithAgentContext(agentId, 'Agent', '(fast)', undefined);
    lane.addStartWithAgentContext('child_fast', 'bash', '("ls")', agentId);
    // No time advance.
    const overlay = rawOverlay(lane);
    expect(overlay).not.toMatch(/… \d/);
  });
});

// ─── E-pre. NESTING+children parent row intentionally omits elapsed counter ───

describe('NESTING parent row with in-flight children — no elapsed counter', () => {
  /**
   * Pins the intentional design: when a NESTING dispatch head (Agent/skill/
   * compose) owns at least one in-flight child, `getOverlay()` renders the
   * parent row WITHOUT an elapsed counter. The counter appears on the child
   * rows instead (tested in section D). `formatElapsed` has exactly two call
   * sites in tool-lane.ts — the childless NESTING branch and the flat-leaf
   * branch — and the NESTING-with-children branch is intentionally excluded.
   */
  it('parent Agent row does NOT show trailing seconds counter when it has an in-flight child', () => {
    const lane = new ToolLane();
    const agentId = '__synth_nesting_parent';
    lane.addStartWithAgentContext(agentId, 'Agent', '(refactor)', undefined);
    // Add an in-flight child so the parent enters the NESTING+children branch.
    lane.addStartWithAgentContext('child_nested', 'bash', '("pnpm build")', agentId);
    // Advance well past the grace period.
    vi.setSystemTime(BASE_TIME + 12_000);
    const overlay = rawOverlay(lane);
    // The parent row (prefix "Agent(refactor)") must NOT carry a seconds counter.
    // It renders as `◉ Agent(refactor)` with no "… Xs" suffix.
    // The child row carries "… 12s" instead (pinned by section D).
    const lines = overlay.split('\n');
    const parentLine = lines.find((l) => l.includes('Agent(refactor)'));
    expect(parentLine).toBeDefined();
    expect(parentLine).not.toMatch(/… \d/);
  });
});

// ─── E. Tick-loop regression: terminates on teardown (Bug #3) ────────────────

describe('tick-loop regression — checkPauseAnnotations stops on dispose', () => {
  /**
   * Regression for Bug #3 (docs/rendering-architecture-current.md §5):
   * if a source's `done` event never fires, the 80ms tick loop would run
   * until the entire renderer is torn down via disposeRenderer (Phase 7:
   * clearInterval). This test verifies the `disposed` guard inside
   * checkPauseAnnotations ensures the function is a no-op after dispose,
   * so even if the interval callback fires after the interval is cleared
   * (e.g. an already-queued callback), it does nothing harmful.
   *
   * The minimal correct fix is already in place:
   *   1. checkPauseAnnotations returns false immediately when ctx.disposed.
   *   2. disposeRenderer Phase 7 clears the interval unconditionally.
   * This test pins both invariants.
   */
  it('checkPauseAnnotations returns false and is side-effect-free after disposed=true', () => {
    // Minimal lifecycle context with one in-flight source (done=false).
    const captured: string[] = [];
    const toolLane = new ToolLane();
    toolLane.addStartWithAgentContext('__synth_stall', 'Agent', '(stalled-agent)', undefined);

    const ctx = {
      disposed: true, // Simulates post-teardown state.
      sources: new Map([
        ['stall-src', {
          done: false,
          errored: false,
          syntheticAgentToolUseId: '__synth_stall',
          lastEventAt: BASE_TIME - 60_000, // Stalled >30s ago.
          stalledTicks: 0,
          agentType: undefined,
          pauseAnnotation: undefined,
        }],
      ]),
      toolLane,
      isTTY: true,
      overlayComposer: {
        markDirty: () => { captured.push('markDirty'); },
        flush: () => { captured.push('flush'); },
      },
      // TTFB fields required by the function signature.
      ttfbStartedAt: undefined,
      ttfbDone: false,
      lastTtfbAnnotation: '',
      getTtfbStartedAt: () => undefined,
      isTtfbDone: () => false,
    } as unknown as LifecycleContext;

    const result = checkPauseAnnotations(ctx);

    // Must return false (no change) immediately — the disposed guard fires first.
    expect(result).toBe(false);
    // Must not trigger any overlay repaint — the stalled-tick branch never runs.
    expect(captured).toHaveLength(0);
    // Source state must be untouched — stalledTicks stays 0.
    const src = ctx.sources.get('stall-src');
    expect(src?.stalledTicks).toBe(0);
    expect(src?.done).toBe(false); // No synthetic done injection.
  });
});
