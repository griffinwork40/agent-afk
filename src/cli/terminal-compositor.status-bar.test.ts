/**
 * Tests for TerminalCompositor — background-status-bar coexistence.
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

describe('TerminalCompositor — background-status-bar coexistence', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
  });

  /**
   * Extract all CUP row numbers from an ANSI escape sequence string.
   * CUP format: ESC [ <row> ; <col> H
   */
  function extractCupRows(out: string): number[] {
    const rows: number[] = [];
    const re = /\x1b\[(\d+);\d+H/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      rows.push(parseInt(m[1]!, 10));
    }
    return rows;
  }

  it('keeps compositor frame above bg bar rows when extraRows > 0', async () => {
    // rows=24, extraRows=2 → targetBottomRow = 24-1-2 = 21
    // All CUP rows emitted by repaint() must be ≤ 21 so the compositor
    // never writes into the two rows owned by BackgroundStatusBar.
    const mockScrollRegion = {
      withFullScrollRegion<T>(fn: () => T): T { return fn(); },
      getExtraRows(): number { return 2; },
    };
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      scrollRegion: mockScrollRegion,
    });
    await c.arm();
    writes.clear();

    // Trigger a repaint by setting overlay content.
    c.setOverlay('test overlay line');
    const out = writes.all();

    const cupRows = extractCupRows(out);
    expect(cupRows.length).toBeGreaterThan(0);
    const maxCupRow = Math.max(...cupRows);
    // Must stay at or below targetBottomRow = 21 (rows=24, extraRows=2).
    expect(maxCupRow).toBeLessThanOrEqual(21);
    c.disarm();
  });

  it('uses full bottom row when extraRows is 0', async () => {
    // rows=24, extraRows=0 → targetBottomRow = 24-1-0 = 23
    // The compositor should use the full available space (no reserved rows).
    const mockScrollRegion = {
      withFullScrollRegion<T>(fn: () => T): T { return fn(); },
      getExtraRows(): number { return 0; },
    };
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      scrollRegion: mockScrollRegion,
    });
    await c.arm();
    writes.clear();

    c.setOverlay('test overlay line');
    const out = writes.all();

    const cupRows = extractCupRows(out);
    expect(cupRows.length).toBeGreaterThan(0);
    const maxCupRow = Math.max(...cupRows);
    // Should reach the full bottom row = 23 (rows=24, extraRows=0).
    expect(maxCupRow).toBeLessThanOrEqual(23);
    // Also verify it actually uses the bottom (not unnecessarily clamped).
    expect(maxCupRow).toBeGreaterThanOrEqual(22);
    c.disarm();
  });
});

