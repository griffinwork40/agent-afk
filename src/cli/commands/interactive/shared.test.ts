/**
 * Tests for `printResumeBanner` — the "where was I" cue printed after a
 * resume to surface the last stored turn without flooding scrollback.
 *
 * Coverage targets:
 *   - Empty turns array → silent no-op (legacy sidecars)
 *   - Single turn → user + assistant + /history pointer (3 lines)
 *   - Long user message → flattened and truncated with ellipsis
 *   - Assistant with control bytes / multi-line → sanitized
 *   - Empty user or empty assistant fields → that line is skipped
 *   - Picks the LAST turn from a multi-turn array
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { printResumeBanner, resolveResumeCwd } from './shared.js';
import type { SessionStats, TurnRecord } from '../../slash/types.js';
import type { CompletionWriter } from './shared.js';

function makeStats(turns: TurnRecord[]): SessionStats {
  return {
    totalTurns: turns.length,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: 0,
    turnCosts: [],
    turnTokens: [],
    turns,
    model: 'sonnet',
    permissionMode: 'default',
  };
}

function makeWriter(): { writer: CompletionWriter; lines: string[] } {
  const lines: string[] = [];
  return {
    writer: { fn: (line: string) => lines.push(line) },
    lines,
  };
}

// Strip ANSI styling so assertions can match on the underlying text without
// caring about palette.dim's escape codes. Same regex shape the helper uses
// internally to sanitize tool output.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

describe('printResumeBanner', () => {
  it('is a silent no-op when turns is empty', () => {
    const { writer, lines } = makeWriter();
    printResumeBanner(makeStats([]), writer);
    expect(lines).toEqual([]);
  });

  it('emits user + assistant + /history pointer for a single turn', () => {
    const { writer, lines } = makeWriter();
    const turn: TurnRecord = {
      user: 'fix the auth bug',
      assistant: 'I patched the token check in middleware.ts. Tests pass.',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);

    expect(lines).toHaveLength(3);
    expect(stripAnsi(lines[0]!)).toBe('  Last: fix the auth bug');
    expect(stripAnsi(lines[1]!)).toBe('  ↳ I patched the token check in middleware.ts.');
    expect(stripAnsi(lines[2]!)).toBe('  ↪ /history for full review');
  });

  it('picks the LAST turn when multiple are present', () => {
    const { writer, lines } = makeWriter();
    const turns: TurnRecord[] = [
      { user: 'first ask', assistant: 'first reply.', timestamp: 0 },
      { user: 'second ask', assistant: 'second reply.', timestamp: 1 },
      { user: 'third ask', assistant: 'third reply.', timestamp: 2 },
    ];
    printResumeBanner(makeStats(turns), writer);

    expect(stripAnsi(lines[0]!)).toContain('third ask');
    expect(stripAnsi(lines[1]!)).toContain('third reply.');
  });

  it('truncates long user messages with an ellipsis', () => {
    const { writer, lines } = makeWriter();
    const longUser = 'a'.repeat(200);
    const turn: TurnRecord = { user: longUser, assistant: 'short reply.', timestamp: 0 };
    printResumeBanner(makeStats([turn]), writer);

    const userLine = stripAnsi(lines[0]!);
    expect(userLine).toMatch(/^  Last: a+…$/);
    // Format: "  Last: " (8 chars) + content up to 80 incl. ellipsis = 88 total max
    expect(userLine.length).toBeLessThanOrEqual(88);
  });

  it('flattens multi-line content into a single line', () => {
    const { writer, lines } = makeWriter();
    const turn: TurnRecord = {
      user: 'multi\nline\nuser\nmessage',
      assistant: 'multi\n\n\nline\n  reply.  trailing',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);

    // No newlines should appear in any banner line — flattening must happen
    // inside the helper, not be left for the writer to handle.
    for (const line of lines) {
      expect(line).not.toContain('\n');
    }
    expect(stripAnsi(lines[0]!)).toBe('  Last: multi line user message');
    expect(stripAnsi(lines[1]!)).toBe('  ↳ multi line reply.');
  });

  it('strips ANSI cursor-control sequences from stored content', () => {
    const { writer, lines } = makeWriter();
    // Simulate stored bash output with cursor moves + colors that would
    // corrupt scroll state if replayed raw.
    const turn: TurnRecord = {
      user: 'run \x1b[31mthe\x1b[0m thing',
      assistant: '\x1b[2Jcleared\x1b[H screen but kept output.',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);

    // After ANSI strip, the user line should not contain any \x1b bytes —
    // the helper's own palette.dim styling is applied AFTER stripping, so
    // dim escapes are fine; the danger is unsanitized control bytes inside
    // the content slot. Check the content region only.
    expect(stripAnsi(lines[0]!)).toBe('  Last: run the thing');
    expect(stripAnsi(lines[1]!)).toBe('  ↳ cleared screen but kept output.');
  });

  it('strips OSC 8 hyperlinks (ESC ] ... BEL) from stored content', () => {
    const { writer, lines } = makeWriter();
    // OSC 8 hyperlink form: ESC ] 8 ; ; <url> BEL <text> ESC ] 8 ; ; BEL
    // The basic CSI regex (\x1b\[…) misses this entirely — confirm the
    // broadened pattern catches both opener and closer.
    const turn: TurnRecord = {
      user: 'see \x1b]8;;https://example.com\x07docs\x1b]8;;\x07 here',
      assistant: 'opened the link.',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);
    expect(stripAnsi(lines[0]!)).toBe('  Last: see docs here');
    // No OSC opener or BEL should survive in the banner.
    expect(lines[0]).not.toContain('\u001b]');
    expect(lines[0]).not.toContain('\u0007');
  });

  it('strips Fe single-char escapes (ESC 7 / ESC 8 / ESC M) from stored content', () => {
    const { writer, lines } = makeWriter();
    // ESC 7 (save cursor), ESC 8 (restore cursor), ESC M (reverse index)
    // — single-byte escapes that the original CSI-only regex missed and
    // that even `ansi-regex@6` still misses for the digit forms.
    const turn: TurnRecord = {
      user: '\x1b7saved\x1b8restored',
      assistant: 'used \x1bM reverse index here.',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);
    expect(stripAnsi(lines[0]!)).toBe('  Last: savedrestored');
    expect(stripAnsi(lines[1]!)).toBe('  ↳ used reverse index here.');
    // No raw ESC bytes should leak through.
    for (const line of lines) {
      expect(line.includes('\u001b7')).toBe(false);
      expect(line.includes('\u001b8')).toBe(false);
      expect(line.includes('\u001bM')).toBe(false);
    }
  });

  it('strips DCS sequences (ESC P ... ST) from stored content', () => {
    const { writer, lines } = makeWriter();
    // Device Control String — used by sixel/Kitty image protocols and
    // some legacy terminal features. `ansi-regex@6` does not strip this.
    const turn: TurnRecord = {
      user: 'before\x1bP1;0|payload\x1b\\after',
      assistant: 'ok.',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);
    expect(stripAnsi(lines[0]!)).toBe('  Last: beforeafter');
  });

  it('strips 8-bit C1 CSI bytes (\\x9B) from stored content', () => {
    const { writer, lines } = makeWriter();
    // Some legacy systems emit the single-byte C1 CSI (0x9B) instead of
    // the 7-bit two-byte ESC [ form.
    const turn: TurnRecord = {
      user: '\u009b31mred-via-c1',
      assistant: 'ok.',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);
    expect(stripAnsi(lines[0]!)).toBe('  Last: red-via-c1');
  });

  it('skips the user line when the user field is empty', () => {
    const { writer, lines } = makeWriter();
    const turn: TurnRecord = { user: '', assistant: 'standalone reply.', timestamp: 0 };
    printResumeBanner(makeStats([turn]), writer);

    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[0]!)).toBe('  ↳ standalone reply.');
    expect(stripAnsi(lines[1]!)).toBe('  ↪ /history for full review');
  });

  it('skips the assistant line when the assistant field is empty', () => {
    const { writer, lines } = makeWriter();
    const turn: TurnRecord = { user: 'incomplete turn', assistant: '', timestamp: 0 };
    printResumeBanner(makeStats([turn]), writer);

    expect(lines).toHaveLength(2);
    expect(stripAnsi(lines[0]!)).toBe('  Last: incomplete turn');
    expect(stripAnsi(lines[1]!)).toBe('  ↪ /history for full review');
  });

  it('still emits the /history pointer when both user and assistant are empty', () => {
    const { writer, lines } = makeWriter();
    const turn: TurnRecord = { user: '', assistant: '', timestamp: 0 };
    printResumeBanner(makeStats([turn]), writer);

    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toBe('  ↪ /history for full review');
  });

  it('extracts only the first sentence from a long assistant reply', () => {
    const { writer, lines } = makeWriter();
    const turn: TurnRecord = {
      user: 'q',
      assistant: 'First sentence here. Second sentence that should be omitted. Third one too!',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);

    expect(stripAnsi(lines[1]!)).toBe('  ↳ First sentence here.');
  });

  it('does not false-stop at `e.g.` / `i.e.` abbreviations', () => {
    const { writer, lines } = makeWriter();
    // The old regex `/^.*?[.!?](?=\s|$)/` stopped at "Use e.g." because
    // `g.` is followed by whitespace. The abbreviation-aware lookbehind
    // skips letter.letter terminators so sentence boundaries land at the
    // genuine sentence end.
    const turn: TurnRecord = {
      user: 'q',
      assistant: 'Use e.g. middleware.ts to patch the bug. Then run tests.',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);
    expect(stripAnsi(lines[1]!)).toBe('  ↳ Use e.g. middleware.ts to patch the bug.');
  });

  it('still stops at sentence boundaries when the next sentence is lowercase', () => {
    const { writer, lines } = makeWriter();
    // A common pattern in programmatic output ("PASS: 5/5 passed. fail: 0/0")
    // and casual prose ("done. it worked"). The reviewer's proposed
    // `/^.*?[.!?](?=\s+[A-Z]|$)/` regex regressed here — the lookbehind
    // approach handles it correctly.
    const turn: TurnRecord = {
      user: 'q',
      assistant: 'PASS: 5/5 passed. fail: 0/0',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);
    expect(stripAnsi(lines[1]!)).toBe('  ↳ PASS: 5/5 passed.');
  });

  it('does not split UTF-16 surrogate pairs at the truncation boundary', () => {
    const { writer, lines } = makeWriter();
    // Build an 83-code-point payload where the truncation cut (max=80,
    // boundary at index 79) lands AT an emoji. With UTF-16-unit slicing
    // (the old behavior) the cut at unit 79 lands INSIDE the second
    // emoji's surrogate pair, leaving a lone high surrogate that renders
    // as the U+FFFD replacement glyph in most terminals.
    //
    // Code-point iteration: 78 a's + 5 🎉. slice(0, max-1) = slice(0, 79)
    // takes 78 a's + 1 emoji = 79 code points, joined with '…' = "...🎉…".
    const turn: TurnRecord = {
      user: 'a'.repeat(78) + '🎉🎉🎉🎉🎉', // 83 code points, 88 UTF-16 units
      assistant: 'ok.',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);
    const line = stripAnsi(lines[0]!);
    // The truncated line should END at a complete emoji + ellipsis, NOT
    // a lone surrogate.
    expect(line).toMatch(/🎉…$/);
    // No lone surrogate in the output. A lone high surrogate (0xD800–0xDBFF)
    // or lone low surrogate (0xDC00–0xDFFF) without its pair would survive
    // UTF-16-unit slicing but not code-point slicing.
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        // High surrogate must be followed by a low surrogate.
        const next = line.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++; // skip the low surrogate we just verified
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        // Found a low surrogate not preceded by a high surrogate → lone surrogate.
        expect.fail(`Lone low surrogate at index ${i}`);
      }
    }
  });

  it('does not truncate an all-emoji string whose code-point count fits within max', () => {
    const { writer, lines } = makeWriter();
    // 80 emoji = 80 code points = 160 UTF-16 units. The old `s.length`
    // early-return check would spuriously truncate this (160 > 80). The
    // code-point-aware check preserves it.
    const turn: TurnRecord = {
      user: '🎉'.repeat(80),
      assistant: 'ok.',
      timestamp: 0,
    };
    printResumeBanner(makeStats([turn]), writer);
    const line = stripAnsi(lines[0]!);
    // No ellipsis means no truncation happened.
    expect(line).not.toContain('…');
    expect(line).toBe('  Last: ' + '🎉'.repeat(80));
  });
});

/**
 * Tests for `resolveResumeCwd` — the precedence helper that lets a resumed
 * interactive session run in the directory it was saved in (the fork/resume
 * cwd-restore fix), without clobbering an explicit `--worktree` override.
 *
 * Precedence under test:
 *   (a) stored cwd that EXISTS on disk is used
 *   (b) stored cwd that does NOT exist falls back (returns undefined)
 *   (c) an explicit extras.cwd (--worktree) always wins over stored cwd
 */
describe('resolveResumeCwd — resume cwd precedence', () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('uses the stored cwd when it still exists on disk', () => {
    tmp = mkdtempSync(join(tmpdir(), 'afk-resume-cwd-'));
    // No --worktree override → fall back to the (existing) stored cwd.
    expect(resolveResumeCwd(undefined, tmp)).toBe(tmp);
  });

  it('falls back (undefined) when the stored cwd no longer exists', () => {
    // A cleaned-up worktree: the stored path is gone. The helper returns
    // undefined so the caller degrades to process.cwd().
    const gone = join(tmpdir(), `afk-resume-cwd-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    expect(resolveResumeCwd(undefined, gone)).toBeUndefined();
  });

  it('lets an explicit extras.cwd (--worktree) win over the stored cwd', () => {
    tmp = mkdtempSync(join(tmpdir(), 'afk-resume-cwd-'));
    // Even though the stored cwd exists, the explicit override takes priority
    // and is returned WITHOUT an existsSync check.
    expect(resolveResumeCwd('/explicit/worktree', tmp)).toBe('/explicit/worktree');
  });

  it('returns undefined when neither an override nor a stored cwd is present', () => {
    expect(resolveResumeCwd(undefined, undefined)).toBeUndefined();
  });

  it('returns the explicit override even when there is no stored cwd', () => {
    expect(resolveResumeCwd('/explicit/worktree', undefined)).toBe('/explicit/worktree');
  });
});
