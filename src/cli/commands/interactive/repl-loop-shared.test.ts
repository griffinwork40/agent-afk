/**
 * Tests for buildPrompt (repl-loop-shared.ts).
 *
 * The caret carries the brand plus a compact echo of the non-default
 * permission mode (` ●` / ` ◐` / ` ⚡bp`) — never the worded chip, which lives
 * on the status line. The echo must stay at the caret because the status
 * row is painted outside the scroll region and never enters scrollback: the
 * prompt is the only mode signal that survives into the linear transcript.
 * Plan and AFK are glyph-only; bypass ALSO keeps a short ASCII tag (`bp`)
 * because it is security-sensitive and must stay grep-able in piped logs.
 */

import { describe, it, expect } from 'vitest';
import { buildPrompt } from './repl-loop-shared.js';

const BROAD_ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function strip(s: string): string {
  return s.replace(BROAD_ANSI_RE, '');
}

describe('buildPrompt', () => {
  it('renders bare brand + caret with no marker in default mode', () => {
    const out = strip(buildPrompt('default'));
    expect(out).toBe('afk  › ');
  });

  it('renders a glyph-only plan marker (no word)', () => {
    const out = strip(buildPrompt('plan'));
    expect(out).toContain('●');
    expect(out).not.toContain('plan');
  });

  it('renders a glyph-only autonomous marker (no word)', () => {
    const out = strip(buildPrompt('autonomous'));
    expect(out).toContain('◐');
    expect(out).not.toContain('AFK');
  });

  it('renders the bypass marker with a grep-able ASCII token (glyph + bp)', () => {
    const out = strip(buildPrompt('bypassPermissions'));
    expect(out).toContain('⚡');
    // Bypass is security-sensitive: it keeps an ASCII tag so a post-hoc grep
    // of a piped transcript can still locate permission-off windows.
    expect(out).toContain('bp');
    // …but still not the full worded chip (that lives on the status line).
    expect(out).not.toContain('bypass');
  });

  it('always ends with the caret', () => {
    for (const mode of ['default', 'plan', 'autonomous', 'bypassPermissions'] as const) {
      expect(strip(buildPrompt(mode))).toMatch(/› $/);
    }
  });
});
