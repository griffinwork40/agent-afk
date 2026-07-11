/**
 * Tests for TerminalCompositor — input bottom-pin placement.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369).
 * Behavior unchanged; shared mock factories live in ./terminal-compositor.test-helpers.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { CupFrameRenderer } from './cup-frame-renderer.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

// Module-level reset mirrors the original monolith's top-level beforeEach:
// clear the process-wide StdinClaim singleton before every test.
beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('TerminalCompositor — input bottom-pin placement', () => {
  // These tests verify that the live input frame is ALWAYS bottom-pinned
  // (targetBottomRow === absoluteBottom) — on a fresh session, with or without
  // a banner, and after any number of commits.
  //
  // Core invariant: the input line is the last frameLines entry and always
  // lands on absoluteBottom (rows-1-extraRows); the dropdown / hint / streaming
  // overlay grow UPWARD into the empty viewport above it. This is what lets the
  // slash-command completion menu open on a brand-new session without shoving
  // the prompt down to make headroom.
  //
  // History: this used to be a two-regime "content-following" placement — the
  // frame pinned just below the banner at
  //   targetBottomRow = min(absoluteBottom, max(anchorRow, committedBandBottomRow) + physicalRows)
  // while idle with a banner, marching down to absoluteBottom only as committed
  // content accumulated. That left a fresh-session prompt one row under the
  // banner with no headroom, so opening the dropdown grew physicalRows and
  // pushed the whole frame down. The regime was removed in favour of
  // unconditional bottom-pinning; the banner is still protected as a ceiling by
  // the anchorRow floor (frame-preserve.ts / committed-band-repin.ts).

  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
  });

  it('cold start: no banner, no content — frame stays bottom-pinned', async () => {
    // Before any commit and without a banner, the frame must land at the
    // standard bottom row (rows-1).
    stdout.rows = 70;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), promptText: '> ' });
    await c.arm();
    const out = writes.all();
    // 1-line idle frame → bottom-pinned at row 69 (70-1).
    expect(out).toContain('\x1b[69;1H');
    c.disarm();
  });

  it('tall terminal + banner: frame stays bottom-pinned (no content-following) so the dropdown has headroom', async () => {
    // Regression guard for the fresh-session dropdown-jump fix: rows=70,
    // anchorRow=15 (14-row welcome banner). Even with a small committed band
    // sitting near the banner (committedBandBottomRow=16, far above
    // absoluteBottom=69), the next standalone repaint must bottom-pin the input
    // frame — NOT follow the content up to ~row 19. Bottom-pinning is what
    // leaves the empty viewport above the prompt for the completion dropdown to
    // grow into without shoving the input down.
    stdout.rows = 70;
    const c2 = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      anchorRow: 15,
    });
    await c2.arm();
    // Manually force a small committedBandBottomRow by patching internal state
    // via the typed cast the compositor tests already use.
    const internals = c2 as unknown as {
      committedBand: string[];
      committedBandTopRow: number;
      committedBandBottomRow: number;
      hasCommitted: boolean;
      logUpdate: { resetGeometry?: () => void };
    };
    internals.committedBand = ['COMMITTED'];
    internals.committedBandTopRow = 16;
    internals.committedBandBottomRow = 16;
    internals.hasCommitted = true;
    // Reset CupFrameRenderer geometry so its erase pass on the next render
    // doesn't re-visit the stale previous-frame row (row 69 from arm()).
    internals.logUpdate.resetGeometry?.();
    writes.clear();
    c2.setOverlay('FOLLOW_TEST');
    const out2 = writes.all();
    // Input frame must land at absoluteBottom = row 69 (70-1), NOT follow the
    // band up to ~row 19.
    expect(out2).toContain('\x1b[69;1H');
    // The overlay text must appear in the output (frame rendered).
    expect(out2).toContain('FOLLOW_TEST');
    c2.disarm();
  });

  it('no-banner session: frame stays bottom-pinned regardless of committed content', async () => {
    // Without a banner (anchorRow undefined or ≤1) the frame is always at
    // absoluteBottom = rows-1-extraRows regardless of how many commits have
    // accumulated — this preserves all resize-ghost, shrink-gap, and
    // scrollback-gap invariants.
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), promptText: '> ' });
    await c.arm();

    // Commit several lines — with no banner the frame should stay bottom-pinned.
    for (let i = 0; i < 5; i++) {
      c.commitAbove(`LINE_${i}`);
    }
    writes.clear();
    c.setOverlay('AFTER_COMMITS');
    const out = writes.all();

    // Frame must always be at absoluteBottom = rows-1 = 23, regardless of
    // committed content.
    expect(out).toContain('\x1b[23;1H');
    c.disarm();
  });

  it('reserved extraRows: targetBottomRow never enters reserved rows', async () => {
    // extraRows=2 → absoluteBottom = 24-1-2 = 21.
    // With a banner (anchorRow=5) and committed content, the bottom-pinned frame
    // must cap at absoluteBottom=21 — never write into bg-status-bar rows 22-23.
    const mockScrollRegion = {
      withFullScrollRegion<T>(fn: () => T): T { return fn(); },
      getExtraRows(): number { return 2; },
    };
    stdout.rows = 24;
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      anchorRow: 5,
      scrollRegion: mockScrollRegion,
    });
    await c.arm();
    // Commit enough lines to fill the viewport; the frame stays bottom-pinned.
    for (let i = 0; i < 25; i++) {
      c.commitAbove(`LINE_${i}`);
    }
    writes.clear();
    c.setOverlay('EXTRA_ROW_TEST');
    const out = writes.all();
    // Collect CUP rows, excluding the eviction-scroll CUP at physicalBottom=24.
    // evictRowsToScrollback writes `\x1b[24;1H\n...` to trigger DECSTBM scroll;
    // that row is intentionally at the physical margin (not a frame content row).
    const physicalBottom = stdout.rows; // 24
    const re = /\x1b\[(\d+);\d+H/g;
    let m: RegExpExecArray | null;
    let maxFrameRow = 0;
    while ((m = re.exec(out)) !== null) {
      const row = parseInt(m[1]!, 10);
      if (row !== physicalBottom) {
        maxFrameRow = Math.max(maxFrameRow, row);
      }
    }
    expect(maxFrameRow).toBeGreaterThan(0);
    // Frame content must stay at or below absoluteBottom = 21 (extraRows=2).
    expect(maxFrameRow).toBeLessThanOrEqual(21);
    c.disarm();
  });
});

// ─── Protocol invariants ─────────────────────────────────────────────────────
//
// These tests guard the externally-governed contracts catalogued in
// docs/tui-invariants.md. Each test names the historical bug it prevents from
// recurring. If you find yourself disabling one of these, you are also opting
// out of the invariant — confirm in the PR description that the contract has
// genuinely changed at the protocol level (VT spec, log-update source) before
// merging.

