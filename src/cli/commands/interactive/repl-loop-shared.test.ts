/**
 * Tests for buildPrompt (repl-loop-shared.ts).
 *
 * The caret carries the brand plus a GLYPH-ONLY echo of the non-default
 * permission mode (` ●` / ` ◐` / ` ⚡`) — never the worded chip, which lives
 * on the status line. The glyph must stay at the caret because the status
 * row is painted outside the scroll region and never enters scrollback: the
 * prompt is the only mode signal that survives into the linear transcript.
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

  it('renders a glyph-only bypass marker (no word)', () => {
    const out = strip(buildPrompt('bypassPermissions'));
    expect(out).toContain('⚡');
    expect(out).not.toContain('bypass');
  });

  it('always ends with the caret', () => {
    for (const mode of ['default', 'plan', 'autonomous', 'bypassPermissions'] as const) {
      expect(strip(buildPrompt(mode))).toMatch(/› $/);
    }
  });
});
