/**
 * Tests for renderUserCard height cap (src/cli/render/card.ts).
 *
 * Verifies that long user prompts are clamped to MAX_USER_CARD_ROWS (default 24)
 * and that a dim "…(N lines collapsed)" summary row is appended preserving the
 * right-aligned │ treatment. Also covers the env-registry parity check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { card } from '../render.js';
import { ENV_REGISTRY } from '../../config/env.js';

/** Strip ANSI escape sequences so assertions work regardless of chalk level. */
function strip(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate an array of N distinct short body lines. */
function lines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`);
}

// ─── Height cap tests ─────────────────────────────────────────────────────────

describe('renderUserCard height cap', () => {
  // Force a known terminal width so wrap behavior is deterministic.
  beforeEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true });
  });

  it('clamps 30-line body to ≤ 24 (MAX_USER_CARD_ROWS) output lines', () => {
    const out = strip(card({ kind: 'user', body: lines(30).join('\n') }));
    const rows = out.split('\n');
    expect(rows.length).toBeLessThanOrEqual(24);
  });

  it('last output line contains "lines collapsed" when body exceeds cap', () => {
    const out = strip(card({ kind: 'user', body: lines(30).join('\n') }));
    const rows = out.split('\n');
    const lastRow = rows[rows.length - 1] ?? '';
    expect(lastRow).toContain('lines collapsed');
  });

  it('last output line ends with " │" even when it is the summary row', () => {
    const out = strip(card({ kind: 'user', body: lines(30).join('\n') }));
    const rows = out.split('\n');
    const lastRow = rows[rows.length - 1] ?? '';
    expect(lastRow.endsWith(' │')).toBe(true);
  });

  it('every output line ends with " │" after strip (│ discipline preserved)', () => {
    const out = strip(card({ kind: 'user', body: lines(30).join('\n') }));
    for (const row of out.split('\n')) {
      expect(row.endsWith(' │')).toBe(true);
    }
  });

  it('body with 10 lines (under default cap) produces exactly 10 output lines — no summary', () => {
    const out = strip(card({ kind: 'user', body: lines(10).join('\n') }));
    const rows = out.split('\n');
    expect(rows.length).toBe(10);
    // No "lines collapsed" summary should appear.
    expect(out).not.toContain('lines collapsed');
  });

  it('collapsed count is (total wrapped rows) - (MAX - 1) when capped', () => {
    // With 30 short lines at cols=120, each line wraps to 1 visual row (well
    // under innerW = 116). Total wrapped = 30. Cap = 24. Kept = 23. Collapsed = 7.
    const out = strip(card({ kind: 'user', body: lines(30).join('\n') }));
    expect(out).toContain('7 lines collapsed');
  });

  it('summary row uses "…(N lines collapsed)" format', () => {
    const out = strip(card({ kind: 'user', body: lines(30).join('\n') }));
    expect(out).toMatch(/…\(\d+ lines collapsed\)/);
  });

  it('AFK_USER_CARD_MAX_ROWS is registered in ENV_REGISTRY with correct metadata', () => {
    // Verifies the env var is registered so scan:env:check passes and the
    // override mechanism is wired correctly (even though the module-scope
    // constant is evaluated at import time, the registry entry ensures
    // documentation and CI parity).
    const entry = ENV_REGISTRY.find((e) => e.name === 'AFK_USER_CARD_MAX_ROWS');
    expect(entry).toBeDefined();
    expect(entry?.type).toBe('number');
    expect(entry?.required).toBe(false);
    expect(entry?.category).toBe('misc');
  });
});
