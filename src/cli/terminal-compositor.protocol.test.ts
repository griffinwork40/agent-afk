/**
 * Tests for TerminalCompositor — protocol invariants.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369).
 * Behavior unchanged; shared mock factories live in ./terminal-compositor.test-helpers.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

// Module-level reset mirrors the original monolith's top-level beforeEach:
// clear the process-wide StdinClaim singleton before every test.
beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('TerminalCompositor — protocol invariants', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
  });

  describe('arm() — log-update anchor protocol', () => {
    it('writes CUP to bottom row before the first repaint', async () => {
      // External constraint (log-update anchor protocol): the FIRST log-update
      // render writes at the current cursor row with no preceding cursor
      // movement; all subsequent repaints anchor relative to that row.
      //
      // Prevents recurrence of ce1dcfe: without the explicit CUP to
      // (rows-1, 1), the overlay anchors wherever the welcome banner +
      // status-line save/restore left the cursor (mid-screen) — producing
      // a frame split where the overlay paints at the top and input
      // drifts to the bottom.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      const out = writes.all();
      const anchorRow = (stdout.rows ?? 24) - 1;
      const expectedCUP = `\x1b[${anchorRow};1H`;
      const cupIdx = out.indexOf(expectedCUP);
      expect(cupIdx).toBeGreaterThanOrEqual(0);
      // CUP must precede any log-update frame content. The first frame
      // includes the input-row caret render. We assert the CUP appears
      // within the first 64 bytes of arm()'s output to keep the test
      // robust against minor preamble changes (e.g. raw-mode setup
      // sequences) without losing the "comes first" guarantee.
      expect(cupIdx).toBeLessThan(64);
    });

    it('skips the CUP write when stdout is not a TTY', async () => {
      // Negative complement: non-TTY surfaces (pipes, CI) have no cursor
      // to position. Writing the CUP would inject literal escape bytes
      // into piped output — visible garbage in logs.
      const nonTTY = makeMockStdout(false);
      const nonTTYWrites = collectWrites(nonTTY);
      const c = new TerminalCompositor({
        stdout: nonTTY,
        stdin,
        onCancel: vi.fn(),
      });
      await c.arm();
      // No CUP escape should appear (the regex matches `\x1b[<n>;1H`).
      expect(nonTTYWrites.all()).not.toMatch(/\x1b\[\d+;1H/);
    });
  });

  describe('commitAbove() — DECSTBM contract', () => {
    it('routes the newline write through withFullScrollRegion when scrollRegion is provided', async () => {
      // External constraint (DECSTBM contract): when a status line is active,
      // the bottom row is reserved via a persistent scroll region. A raw `\n`
      // at the bottom of that sub-region triggers a sub-region scroll and the
      // displaced top line silently exits without entering scrollback.
      //
      // Prevents recurrence of f962403-family bugs: removing the
      // withFullScrollRegion guard would resurface "tool-lane lines vanish
      // into the void" the moment the status line is active.
      const scrollRegion = {
        withFullScrollRegion: vi.fn(<T,>(fn: () => T): T => fn()),
        // getExtraRows is part of the CompositorScrollRegionGuard contract:
        // arm()→repaint() reads it to keep the frame above any reserved
        // status-bar rows. A mock that omits it throws on arm(); 0 means
        // "no reserved rows", isolating this test to the routing invariant.
        getExtraRows: vi.fn(() => 0),
      };
      const c = new TerminalCompositor({
        stdout,
        stdin,
        onCancel: vi.fn(),
        scrollRegion,
      });
      await c.arm();
      writes.clear();
      c.commitAbove('COMMITTED_BLOCK');

      // The guard-call is the load-bearing assertion: removing
      // `writeWithGuard(...)` from commitAbove would make this fail
      // immediately, regardless of how the inner write is shaped.
      expect(scrollRegion.withFullScrollRegion).toHaveBeenCalled();
      // Content reaches stdout. Armed-path commitAbove (CommittedBand.commitAbove)
      // positions the cursor at the row above the frame and erases the line
      // before writing the block, so the committed text appears as
      // `CUP-to-row → EL (\x1b[2K) → text`. We pin that exact positioned
      // shape rather than a bare substring so the test fails if the block
      // ever stops being placed via the centralized cursor-positioned write.
      const out = writes.all();
      expect(out).toContain('COMMITTED_BLOCK');
      expect(out).toMatch(/\x1b\[\d+;1H\x1b\[2KCOMMITTED_BLOCK/);
    });

    it('writes directly without invoking the guard when scrollRegion is absent', async () => {
      // Negative complement: callers without an active status line shouldn't
      // pay for indirection; the bare write still commits to scrollback
      // because no DECSTBM is in effect.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('NO_GUARD_BLOCK');
      // Same positioned emission shape as the guarded path — armed
      // commitAbove writes `CUP-to-row → EL (\x1b[2K) → text`. The only
      // difference from the guarded case is that withFullScrollRegion is
      // never invoked (asserted implicitly: no scrollRegion was provided).
      const out = writes.all();
      expect(out).toContain('NO_GUARD_BLOCK');
      expect(out).toMatch(/\x1b\[\d+;1H\x1b\[2KNO_GUARD_BLOCK/);
    });
  });

  describe('disarm() — cursor visibility restore', () => {
    it('calls logUpdate.done() after logUpdate.clear() so the cursor stays visible', async () => {
      // External constraint (cliCursor visibility): log-update hides the
      // cursor on every render() when showCursor is false (the default).
      // Only done() calls cliCursor.show(); clear() alone leaves the cursor
      // hidden, leaking that state for the rest of the session.
      //
      // Prevents recurrence of "cursor stays invisible after a turn ends"
      // by asserting the (clear, done) sequence is intact.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();

      const internals = c as unknown as {
        logUpdate: { clear: () => void; done: () => void };
      };
      const calls: string[] = [];
      const originalClear = internals.logUpdate.clear.bind(internals.logUpdate);
      const originalDone = internals.logUpdate.done.bind(internals.logUpdate);
      internals.logUpdate.clear = () => {
        calls.push('clear');
        originalClear();
      };
      internals.logUpdate.done = () => {
        calls.push('done');
        originalDone();
      };

      c.disarm();
      expect(calls).toEqual(['clear', 'done']);
    });
  });
});
