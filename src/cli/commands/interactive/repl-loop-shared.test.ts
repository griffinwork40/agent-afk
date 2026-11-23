/**
 * Tests for buildPrompt (repl-loop-shared.ts).
 *
 * The caret carries the brand plus a compact echo of the non-default
 * permission mode (` ●` / ` ⚡ ur`) — never the worded chip, which lives
 * on the status line. The echo must stay at the caret because the status
 * row is painted outside the scroll region and never enters scrollback: the
 * prompt is the only mode signal that survives into the linear transcript.
 * Plan is glyph-only; unrestricted ALSO keeps a short ASCII tag (`ur`)
 * because it is security-sensitive and must stay grep-able in piped logs.
 */

import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { buildPrompt } from './repl-loop-shared.js';
import { palette } from '../../palette.js';

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

  it('renders the unrestricted marker with a grep-able ASCII token (glyph + ur)', () => {
    const out = strip(buildPrompt('bypassPermissions'));
    expect(out).toContain('⚡');
    // Unrestricted is security-sensitive: it keeps an ASCII tag so a post-hoc
    // grep of a piped transcript can still locate permission-off windows.
    expect(out).toContain('ur');
    // …but still not the full worded chip (that lives on the status line).
    expect(out).not.toContain('unrestricted');
  });

  it('always ends with the caret', () => {
    for (const mode of ['default', 'plan', 'bypassPermissions'] as const) {
      expect(strip(buildPrompt(mode))).toMatch(/[›$] $/);
    }
  });

  it('switches to a shell prompt when the live buffer starts with `!`', () => {
    expect(strip(buildPrompt('default', '!git status'))).toBe('afk  $ ');
    expect(strip(buildPrompt('default', ' !git status'))).toBe('afk  › ');
  });

  it('renders the caret in the brand tone, not dim', () => {
    // The caret was lifted from `dim` to `brand` so the input point reads as a
    // deliberate affordance. Lock the tone (glyph is covered by the tests above)
    // so a future change cannot silently re-dim it back to receding chrome.
    const prev = chalk.level;
    chalk.level = 3;
    try {
      const out = buildPrompt('default');
      expect(out).toContain(palette.brand('  › '));
      expect(out).not.toContain(palette.dim('  › '));
    } finally {
      chalk.level = prev;
    }
  });
});
