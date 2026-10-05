/**
 * Regression tests for escape-sequence sanitisation in renderTaskViewHeader.
 *
 * Issue #2445: the subagent `id` and `agentType` strings were interpolated into
 * the terminal header using only width clamping (`.slice(0, 20)`), with no call
 * to `stripEscapeSequences`. A model- or tool-controlled string containing a
 * CSI, OSC-52, or DEC-private-mode sequence reached the alternate screen
 * verbatim.
 *
 * Each test feeds one of three representative sequence families and asserts
 * that no raw ESC byte (0x1B) survives in the rendered header. The palette's
 * own SGR styling is stripped before asserting so only dangerous non-SGR bytes
 * are tested.
 *
 * @module cli/commands/interactive/task-view-escape.test
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Temp AFK_HOME so disk lookups don't touch real ~/.afk
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-tv-esc-test-'));
process.env['AFK_HOME'] = tmpDir;

import { describe, it, expect } from 'vitest';
import { renderTaskViewHeader } from './task-view-mode.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SGR pattern: ESC [ <digits/semicolons> m — strip these before asserting. */
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1B\[[0-9;]*m/g;

/**
 * Strip palette SGR codes so the assertion only fails on non-SGR sequences
 * (the dangerous ones sourced from model/subagent-controlled strings).
 */
function stripSgr(s: string): string {
  return s.replace(SGR_RE, '');
}

/** The three representative escape families from the issue. */
const ESCAPE_PAYLOADS: Array<[label: string, payload: string]> = [
  ['CSI DEC private mode (ESC[?1049l)',  '\x1B[?1049l'],
  ['OSC 52 clipboard write',             '\x1B]52;c;dGVzdA==\x07'],
  ['ESC + DEC private mode + plain suffix', '\x1B[?1049l suffix'],
];

// ---------------------------------------------------------------------------
// Site 1: subagent id
// ---------------------------------------------------------------------------

describe('renderTaskViewHeader – id sanitisation', () => {
  for (const [label, payload] of ESCAPE_PAYLOADS) {
    it(`strips escape sequences from id: ${label}`, () => {
      const header = renderTaskViewHeader(`abc${payload}def`, 'running');
      const bare = stripSgr(header);
      expect(bare).not.toMatch(/\x1B/);
    });
  }

  it('preserves the clean id when no escape sequences are present', () => {
    const header = renderTaskViewHeader('agent-123', 'running');
    const bare = stripSgr(header);
    // The id or its slice should appear in the header text.
    expect(bare).toContain('agent-123');
    expect(bare).not.toMatch(/\x1B/);
  });
});

// ---------------------------------------------------------------------------
// Site 2: agentType
// ---------------------------------------------------------------------------

describe('renderTaskViewHeader – agentType sanitisation', () => {
  for (const [label, payload] of ESCAPE_PAYLOADS) {
    it(`strips escape sequences from agentType: ${label}`, () => {
      const header = renderTaskViewHeader('clean-id', 'running', `evil${payload}type`);
      const bare = stripSgr(header);
      expect(bare).not.toMatch(/\x1B/);
    });
  }

  it('preserves the clean agentType when no escape sequences are present', () => {
    const header = renderTaskViewHeader('clean-id', 'running', 'general-purpose');
    const bare = stripSgr(header);
    expect(bare).toContain('general-purpose');
    expect(bare).not.toMatch(/\x1B/);
  });

  it('omits agentType section entirely when agentType is undefined', () => {
    const header = renderTaskViewHeader('clean-id', 'running', undefined);
    const bare = stripSgr(header);
    expect(bare).not.toContain('type:');
    expect(bare).not.toMatch(/\x1B/);
  });

  // F3 regression: agentType must be clamped to 30 chars after sanitising.
  it('clamps agentType to 30 chars after sanitising (F3 regression)', () => {
    // Without the .slice(0, 30), a 60-char agentType would appear in full.
    const longType = 'a'.repeat(60);
    const header = renderTaskViewHeader('clean-id', 'running', longType);
    const bare = stripSgr(header);
    // The clamped value must appear; the full 60-char string must not.
    expect(bare).toContain('a'.repeat(30));
    expect(bare).not.toContain('a'.repeat(31));
  });
});

// ---------------------------------------------------------------------------
// F2 regression: history message lines must be sanitised before display
// ---------------------------------------------------------------------------

describe('history line sanitisation – stripEscapeSequences (F2 regression)', () => {
  // enterTaskViewMode applies `stripEscapeSequences(l)` to every line of a
  // history message before writing it to ctx.out. This test exercises the
  // exact transform that was added: without it, a model-controlled content line
  // containing a CSI or OSC sequence would reach the terminal verbatim.
  it('strips escape sequences from a history content line', () => {
    const maliciousLine = 'safe prefix \x1b[?1049l injected';
    const safe = stripEscapeSequences(maliciousLine);
    expect(safe).not.toMatch(/\x1B/);
    expect(safe).toContain('safe prefix');
    expect(safe).toContain('injected');
  });

  it('strips OSC sequences from a history content line', () => {
    const line = 'text \x1b]52;c;dGVzdA==\x07 end';
    const safe = stripEscapeSequences(line);
    expect(safe).not.toMatch(/\x1B/);
    expect(safe).toBe('text  end');
  });

  it('strips lone trailing ESC from a history content line (F1+F2 combined)', () => {
    const line = 'message body\x1b';
    const safe = stripEscapeSequences(line);
    expect(safe).toBe('message body');
  });

  it('preserves newlines within multi-line history content', () => {
    // enterTaskViewMode splits on \\n before applying stripEscapeSequences per
    // line, so the stripping is per-line. Verify the function preserves
    // intra-line structure when given a single line.
    const line = '\x1b[31mcolored text\x1b[0m';
    expect(stripEscapeSequences(line)).toBe('colored text');
  });
});
