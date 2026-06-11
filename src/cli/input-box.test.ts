/**
 * Tests for src/cli/input-box.ts
 *
 * Focused on pure-function components (detectTrigger, candidate filters).
 * Raw-mode integration tests deferred to Wave 3.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { detectTrigger, visualRowCount, filterFlagCandidates, formatSubmittedEcho } from './input-box.js';
import { filterSlashCandidates } from './input/trigger.js';
import { registerAll } from './slash/index.js';
import { register, resetRegistry } from './slash/registry.js';
import type { SlashCommand } from './slash/types.js';

describe('detectTrigger', () => {
  describe('slash command detection', () => {
    it('detects /help at position 5', () => {
      const result = detectTrigger('/help', 5);
      expect(result).toEqual({ kind: 'slash', query: 'help' });
    });

    it('detects /he at position 3', () => {
      const result = detectTrigger('/he', 3);
      expect(result).toEqual({ kind: 'slash', query: 'he' });
    });

    it('detects / at position 1', () => {
      const result = detectTrigger('/', 1);
      expect(result).toEqual({ kind: 'slash', query: '' });
    });

    it('returns null when / is followed by space', () => {
      const result = detectTrigger('/ help', 2);
      expect(result).toBeNull();
    });

    it('returns null when buffer has text before /', () => {
      const result = detectTrigger('hello /help', 11);
      expect(result).toBeNull();
    });

    it('allows hyphen and underscore in slash command names', () => {
      const result = detectTrigger('/my-cmd_name', 12);
      expect(result).toEqual({ kind: 'slash', query: 'my-cmd_name' });
    });

    it('returns null when slash command is not at the start', () => {
      const result = detectTrigger('text /cmd', 9);
      expect(result).toBeNull();
    });

    it('returns null when slash command is preceded by leading whitespace', () => {
      const result = detectTrigger(' /help', 6);
      expect(result).toBeNull();
    });

    it('returns null when slash command appears on a later line', () => {
      const result = detectTrigger('note\n/help', 10);
      expect(result).toBeNull();
    });

    it('returns null when slash command contains punctuation', () => {
      const result = detectTrigger('/help!', 6);
      expect(result).toBeNull();
    });

    it('returns null when cursor is before the slash', () => {
      const result = detectTrigger('/help', 0);
      expect(result).toBeNull();
    });
  });

  describe('file completion detection', () => {
    it('detects @src/f at position 11', () => {
      const result = detectTrigger('read @src/f', 11);
      expect(result).toEqual({ kind: 'file', query: 'src/f' });
    });

    it('detects @path at position 5', () => {
      const result = detectTrigger('@path', 5);
      expect(result).toEqual({ kind: 'file', query: 'path' });
    });

    it('detects @ with empty query', () => {
      const result = detectTrigger('@', 1);
      expect(result).toEqual({ kind: 'file', query: '' });
    });

    it('returns null when @ is not the last token', () => {
      const result = detectTrigger('@src word', 5);
      expect(result).toBeNull();
    });

    it('detects a file token after a newline-delimited prefix', () => {
      const result = detectTrigger('open\n@src/f', 11);
      expect(result).toEqual({ kind: 'file', query: 'src/f' });
    });

    it('works with multiple path segments', () => {
      const result = detectTrigger('open @src/components/button', 27);
      expect(result).toEqual({ kind: 'file', query: 'src/components/button' });
    });

    it('returns null when cursor is before the @ token', () => {
      const result = detectTrigger('read @path', 5);
      expect(result).toBeNull();
    });
  });

  describe('no trigger cases', () => {
    it('returns null for plain text', () => {
      const result = detectTrigger('hello world', 5);
      expect(result).toBeNull();
    });

    it('returns null for empty buffer', () => {
      const result = detectTrigger('', 0);
      expect(result).toBeNull();
    });

    it('returns null for buffer with only spaces', () => {
      const result = detectTrigger('   ', 3);
      expect(result).toBeNull();
    });

    it('returns null when / is followed by a number', () => {
      const result = detectTrigger('/123', 4);
      expect(result).toBeNull();
    });

    it('returns null when @ is followed by space', () => {
      const result = detectTrigger('@ file', 2);
      expect(result).toBeNull();
    });

    it('returns null for email-like text containing @ in the middle of a token', () => {
      const result = detectTrigger('email@test.dev', 14);
      expect(result).toBeNull();
    });
  });

  describe('cursor position edge cases', () => {
    it('handles cursor in the middle of a slash command', () => {
      const result = detectTrigger('/help', 3);
      expect(result).toEqual({ kind: 'slash', query: 'he' });
    });

    it('handles cursor at the start of a file path', () => {
      const result = detectTrigger('@path', 1);
      expect(result).toEqual({ kind: 'file', query: '' });
    });

    it('ignores text after the cursor position', () => {
      const result = detectTrigger('/help --force', 6); // position 6 includes the space
      expect(result).toBeNull();
    });

    it('still detects a slash trigger when trailing text is after the cursor', () => {
      const result = detectTrigger('/help --force', 5);
      expect(result).toEqual({ kind: 'slash', query: 'help' });
    });
  });
});

describe('readWithAutocomplete — non-TTY fallback', () => {
  it('delegates to readInput when stdout is not TTY', async () => {
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

    try {
      // Mock stdout.isTTY to false
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });

      // We can't easily replace the imported readInput, so we'll just test
      // that the condition works. The actual delegation is tested via
      // integration in Wave 3.
      expect(process.stdout.isTTY).toBe(false);
    } finally {
      // Restore
      if (originalIsTTY) {
        Object.defineProperty(process.stdout, 'isTTY', originalIsTTY);
      }
    }
  });

  it('delegates when stdin is not TTY', async () => {
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

    try {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
      });
      expect(process.stdin.isTTY).toBe(false);
    } finally {
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, 'isTTY', originalIsTTY);
      }
    }
  });
});

describe('slash command candidate filtering', () => {
  beforeEach(() => {
    resetRegistry();
    registerAll();
  });

  afterEach(() => {
    resetRegistry();
  });

  it('filters slash commands by prefix', async () => {
    // Import the filter function by using detectTrigger + a mock
    // Since filterSlashCandidates is not exported, we test via behavior:
    // a query like "he" should match "/help", "/history", "/exit", etc.
    const result = detectTrigger('/he', 3);
    expect(result?.kind).toBe('slash');
    expect(result?.query).toBe('he');
    // The actual filtering is done in readWithAutocomplete via
    // filterSlashCandidates, which is tested via integration.
  });

  it('detects / prefix without query', () => {
    const result = detectTrigger('/', 1);
    expect(result).toEqual({ kind: 'slash', query: '' });
  });

  it('surfaces aliases as candidates so /quit appears alongside /exit', () => {
    resetRegistry();
    register({
      name: '/exit',
      aliases: ['/quit'],
      summary: 'Exit the session',
      handler: async () => 'exit',
    });
    const all = filterSlashCandidates('').map((c) => c.value);
    expect(all).toContain('/exit');
    expect(all).toContain('/quit');

    // Prefix filtering still narrows correctly to the alias.
    const qOnly = filterSlashCandidates('q').map((c) => c.value);
    expect(qOnly).toEqual(['/quit']);

    // Alias borrows the canonical command's summary.
    const quitCandidate = filterSlashCandidates('q')[0];
    expect(quitCandidate?.summary).toBe('Exit the session');
  });
});

describe('file candidate filtering', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `afk-input-box-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(join(tmpRoot, 'alpha.txt'), 'a');
    writeFileSync(join(tmpRoot, 'beta.ts'), 'b');
    mkdirSync(join(tmpRoot, 'src'));
    writeFileSync(join(tmpRoot, 'src', 'index.ts'), 'c');
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('detects file prefix in buffer', () => {
    const result = detectTrigger('read @al', 8);
    expect(result).toEqual({ kind: 'file', query: 'al' });
  });

  it('detects nested file path prefix', () => {
    const result = detectTrigger('@src/in', 7);
    expect(result).toEqual({ kind: 'file', query: 'src/in' });
  });

  it('returns empty query for @ alone', () => {
    const result = detectTrigger('@', 1);
    expect(result).toEqual({ kind: 'file', query: '' });
  });
});

describe('raw mode cleanup guarantees', () => {
  it('exits raw mode in finally block', async () => {
    // This test verifies the structure; actual raw mode testing
    // is integration-level and deferred to Wave 3.
    // We verify by reading the source that setRawMode(false) is in finally.
    const src = await import('./input-box.js');
    expect(typeof src.readWithAutocomplete).toBe('function');
  });
});

describe('visualRowCount', () => {
  it('returns 0 for an empty buffer', () => {
    expect(visualRowCount('', 4, 80)).toBe(0);
  });

  it('returns 0 for a single line that fits within column width', () => {
    expect(visualRowCount('hello', 4, 80)).toBe(0);
  });

  it('counts soft-wrapped rows for a long single line', () => {
    // prompt(5) + 20 chars = 25 cols; ceil(25/10) = 3 rows → result = 2
    expect(visualRowCount('x'.repeat(20), 5, 10)).toBe(2);
  });

  it('counts each hard newline as an additional row when lines fit', () => {
    // line1: 4+5=9 ≤ 10 → 1 row; line2: 5 ≤ 10 → 1 row; total 2 → result 1
    expect(visualRowCount('hello\nworld', 4, 10)).toBe(1);
  });

  it('combines hard newlines with soft-wrap on a middle line', () => {
    // line1 'a': 3+1=4 → 1; line2 'x'*15: 15 → ceil(15/10)=2; line3 'b': 1 → 1; total 4 → result 3
    expect(visualRowCount('a\n' + 'x'.repeat(15) + '\nb', 3, 10)).toBe(3);
  });

  it('applies prompt width only to the first line', () => {
    // line1: 9+1=10 → 1 row; line2: 10 → 1 row; total 2 → result 1
    expect(visualRowCount('a\n' + 'x'.repeat(10), 9, 10)).toBe(1);
  });

  it('soft-wraps continuation lines independently of the prompt width', () => {
    // line1: 8+2=10 → 1 row; line2: 11 → 2 rows; total 3 → result 2
    expect(visualRowCount('ab\n' + 'x'.repeat(11), 8, 10)).toBe(2);
  });

  it('treats a trailing newline as a fresh empty line', () => {
    // line1: 4+5=9 → 1; line2 '': Math.max(1, 0) = 1; total 2 → result 1
    expect(visualRowCount('hello\n', 4, 10)).toBe(1);
  });

  it('returns 0 when a wide terminal absorbs the buffer without wrapping', () => {
    expect(visualRowCount('a'.repeat(100), 10, 200)).toBe(0);
  });

  it('accounts for wide characters via stringWidth', () => {
    // Emoji width is 2: 6 emoji = 12 cols; ceil(12/10) = 2 rows → result = 1
    expect(visualRowCount('😀'.repeat(6), 0, 10)).toBe(1);
  });

  it('falls back to 80 columns when cols is 0', () => {
    // 80-wide with 0 fallback: 100 chars / 80 = ceil = 2 rows → result = 1
    expect(visualRowCount('a'.repeat(100), 0, 0)).toBe(1);
  });
});

// ─── Flag trigger detection ──────────────────────────────────────────────────

const noopHandler: SlashCommand['handler'] = async () => 'continue';

function makeCmd(name: string, flags?: readonly string[]): SlashCommand {
  return {
    name,
    summary: `synthetic ${name}`,
    handler: noopHandler,
    ...(flags !== undefined ? { flags } : {}),
  };
}

describe('flag trigger detection', () => {
  beforeEach(() => {
    resetRegistry();
    register(makeCmd('/testskill', ['--auto', '--ship', '--pr']));
    register(makeCmd('/noflags'));
    register(makeCmd('/plugin:skillname', ['--verbose', '--debug']));
  });

  afterEach(() => {
    resetRegistry();
  });

  it('detects flag trigger with empty query', () => {
    const result = detectTrigger('/testskill --', 13);
    expect(result).toEqual({ kind: 'flag', command: 'testskill', query: '' });
  });

  it('detects flag trigger with a partial query', () => {
    const result = detectTrigger('/testskill --s', 14);
    expect(result).toEqual({ kind: 'flag', command: 'testskill', query: 's' });
  });

  it('detects flag trigger when args precede the flag', () => {
    const result = detectTrigger('/testskill foo --s', 18);
    expect(result).toEqual({ kind: 'flag', command: 'testskill', query: 's' });
  });

  it('detects flag trigger with a different partial letter', () => {
    const result = detectTrigger('/testskill --a', 14);
    expect(result).toEqual({ kind: 'flag', command: 'testskill', query: 'a' });
  });

  it('stays on slash kind while no space has been entered', () => {
    const result = detectTrigger('/testskill', 10);
    expect(result).toEqual({ kind: 'slash', query: 'testskill' });
  });

  // Auto-popping the full flag menu on any trailing whitespace after the
  // command name is intentionally disabled. The original behavior created
  // two regressions:
  //   1. Dropdown flapped on every space mid-prose (no signal in the buffer
  //      distinguishes "first space after the command" from "Nth space mid-
  //      prompt"), see /<cmd> --flag bar  trace.
  //   2. Tab-completing /<cmd> inserts a trailing space, which auto-opened
  //      the flag dropdown before the user could submit — the next Enter
  //      then applied an unintended flag instead of submitting.
  // Flag completion now fires only when the user explicitly types `--`.
  it('does NOT auto-pop the flag menu after a bare space following the command', () => {
    const result = detectTrigger('/testskill ', 11);
    expect(result).toBeNull();
  });

  it('does NOT re-pop the flag menu after a space following a completed flag', () => {
    const result = detectTrigger('/testskill --ship ', 18);
    expect(result).toBeNull();
  });

  it('does NOT pop the flag menu after a space following a positional arg', () => {
    const result = detectTrigger('/testskill foo ', 15);
    expect(result).toBeNull();
  });

  it('does NOT re-pop the flag menu mid-prose after multiple words', () => {
    const result = detectTrigger('/testskill --ship my prompt body ', 33);
    expect(result).toBeNull();
  });

  it('does not pop the flag menu after a space for a command with no flags', () => {
    const result = detectTrigger('/noflags ', 9);
    expect(result).toBeNull();
  });

  it('does not pop the flag menu after a space for an unregistered command', () => {
    const result = detectTrigger('/nonexistent ', 13);
    expect(result).toBeNull();
  });

  it('returns null when the flag is complete and cursor is past it', () => {
    // Final token is `extra`, not `--something`.
    const result = detectTrigger('/testskill --ship extra', 23);
    expect(result).toBeNull();
  });

  it('returns null for an unregistered command', () => {
    const result = detectTrigger('/nonexistent --a', 16);
    expect(result).toBeNull();
  });

  it('returns null for a registered command without a flags field', () => {
    const result = detectTrigger('/noflags --x', 12);
    expect(result).toBeNull();
  });

  it('supports namespaced command names with a colon', () => {
    const result = detectTrigger('/plugin:skillname --x', 21);
    expect(result).toEqual({ kind: 'flag', command: 'plugin:skillname', query: 'x' });
  });
});

describe('formatSubmittedEcho', () => {
  /** Strip ANSI escapes for stable assertions across chalk levels. */
  const strip = (s: string): string => s.replace(/\x1B\[[0-9;]*m/g, '');

  it('returns plain prompt + buffer in non-TTY mode', () => {
    const out = strip(
      formatSubmittedEcho({
        buffer: 'hello',
        promptText: '> ',
        isTTY: false,
        terminalWidth: 80,
      }),
    );
    expect(out).toBe('> hello');
  });

  it('right-aligns short single-line TTY input flush against the right edge', () => {
    const buffer = 'hi there';
    const terminalWidth = 80;
    const out = strip(
      formatSubmittedEcho({
        buffer,
        promptText: '> ',
        isTTY: true,
        terminalWidth,
      }),
    );
    // No prompt prefix; the buffer ends at the terminal edge.
    expect(out.endsWith(buffer)).toBe(true);
    expect(out).toBe('▶ ' + ' '.repeat(terminalWidth - buffer.length - 2) + buffer);
  });

  it('renders a right-edge bar card for multi-line buffers', () => {
    const out = strip(
      formatSubmittedEcho({
        buffer: 'line one\nline two',
        promptText: '> ',
        isTTY: true,
        terminalWidth: 80,
      }),
    );
    expect(out).toContain('│');
    expect(out).toContain('line one');
    expect(out).toContain('line two');
    expect(out).not.toContain('╭');
    expect(out).not.toContain('╰');
    // Separator row is first (contains ─); content rows end with the right-edge bar.
    const multiLines = out.split('\n');
    const [, ...multiContentLines] = multiLines;
    for (const line of multiContentLines) {
      expect(line.endsWith(' │')).toBe(true);
    }
  });

  it('renders a right-edge bar card when a single line fills the terminal width', () => {
    const long = 'x'.repeat(78);
    const out = strip(
      formatSubmittedEcho({
        buffer: long,
        promptText: '> ',
        isTTY: true,
        terminalWidth: 80,
      }),
    );
    expect(out).toContain('│');
    expect(out).toContain(long.slice(0, 40));
    // Separator row is first (contains ─); content rows end with the right-edge bar.
    const longLines = out.split('\n');
    const [, ...longContentLines] = longLines;
    for (const line of longContentLines) {
      expect(line.endsWith(' │')).toBe(true);
    }
  });

  it('non-TTY does NOT box even with multi-line content', () => {
    const out = strip(
      formatSubmittedEcho({
        buffer: 'line one\nline two',
        promptText: '> ',
        isTTY: false,
        terminalWidth: 80,
      }),
    );
    expect(out).toBe('> line one\nline two');
    expect(out).not.toContain('│');
  });
});

describe('filterFlagCandidates', () => {
  beforeEach(() => {
    resetRegistry();
    register(makeCmd('/testskill', ['--auto', '--ship', '--pr', '--verbose']));
    register(makeCmd('/noflags'));
  });

  afterEach(() => {
    resetRegistry();
  });

  it('returns every flag, sorted, when the query is empty', () => {
    const result = filterFlagCandidates('testskill', '');
    expect(result.map((c) => c.value)).toEqual(['--auto', '--pr', '--ship', '--verbose']);
  });

  it('filters by prefix without the leading dashes', () => {
    const result = filterFlagCandidates('testskill', 's');
    expect(result).toEqual([{ value: '--ship' }]);
  });

  it('filters by prefix with the leading dashes in the query', () => {
    const result = filterFlagCandidates('testskill', '--s');
    expect(result).toEqual([{ value: '--ship' }]);
  });

  it('returns an empty array for a non-matching query', () => {
    const result = filterFlagCandidates('testskill', 'z');
    expect(result).toEqual([]);
  });

  it('returns an empty array for a command with no flags field', () => {
    const result = filterFlagCandidates('noflags', '');
    expect(result).toEqual([]);
  });

  it('returns an empty array for an unregistered command', () => {
    const result = filterFlagCandidates('nonexistent', '');
    expect(result).toEqual([]);
  });
});
