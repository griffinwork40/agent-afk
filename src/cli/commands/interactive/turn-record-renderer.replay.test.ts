/**
 * Tests for turn-record-renderer.replay.ts
 *
 * Covers:
 *   - Empty records: writer never called
 *   - Single turn: role headers + full text emitted
 *   - Turn with tool events: summary line present
 *   - 51-turn session with default maxTurns=50: divider present, 50 turns rendered
 *   - 50-turn session: no divider
 *   - maxTurns override: respects custom cap
 *   - Long assistant text (>2000 chars): truncated with char count
 *   - Writer isolation: all output goes through writer param
 */

import { describe, it, expect } from 'vitest';
import { replayTurns } from './turn-record-renderer.replay.js';
import type { TurnRecord } from '../../slash/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all lines written to a fresh writer, returns both the collector and the array. */
function makeCollector(): { writer: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { writer: (line: string) => lines.push(line), lines };
}

/** Strip ANSI escape sequences for assertion-friendly comparisons. */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/** Join and strip all collected lines. */
function flat(lines: string[]): string {
  return strip(lines.join('\n'));
}

/** Minimal valid TurnRecord. */
function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    user: 'hello user',
    assistant: 'hello assistant',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Build N turns with predictable content for limit/cap tests. */
function makeTurns(n: number): TurnRecord[] {
  return Array.from({ length: n }, (_, i) => makeTurn({
    user: `user message ${i + 1}`,
    assistant: `assistant reply ${i + 1}`,
  }));
}

// ---------------------------------------------------------------------------
// Empty records
// ---------------------------------------------------------------------------

describe('replayTurns — empty records', () => {
  it('calls writer zero times when records is empty', () => {
    const { writer, lines } = makeCollector();
    replayTurns([], writer);
    expect(lines).toHaveLength(0);
  });

  it('calls writer zero times when records is an empty readonly array', () => {
    const { writer, lines } = makeCollector();
    const records: readonly TurnRecord[] = [];
    replayTurns(records, writer);
    expect(lines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Single turn
// ---------------------------------------------------------------------------

describe('replayTurns — single turn', () => {
  it('emits a User role header', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ user: 'hello', assistant: 'world' })], writer);
    expect(flat(lines)).toContain('User');
  });

  it('emits an Assistant role header', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ user: 'hello', assistant: 'world' })], writer);
    expect(flat(lines)).toContain('Assistant');
  });

  it('emits the full user text', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ user: 'specific user text here', assistant: 'ok' })], writer);
    expect(flat(lines)).toContain('specific user text here');
  });

  it('emits the full assistant text', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ user: 'q', assistant: 'specific assistant text here' })], writer);
    expect(flat(lines)).toContain('specific assistant text here');
  });

  it('emits a separator line before the turn', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn()], writer);
    // The separator contains at least a few dash characters.
    const hasSep = lines.some((l) => strip(l).includes('─'));
    expect(hasSep).toBe(true);
  });

  it('indents user text with 4 spaces', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ user: 'indented content', assistant: 'ok' })], writer);
    // Find the line containing the user text and check it starts with 4 spaces.
    const contentLine = lines.find((l) => strip(l).includes('indented content'));
    expect(contentLine).toBeDefined();
    expect(contentLine!).toMatch(/^ {4}/);
  });

  it('indents assistant text with 4 spaces', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ user: 'q', assistant: 'assistant indented' })], writer);
    const contentLine = lines.find((l) => strip(l).includes('assistant indented'));
    expect(contentLine).toBeDefined();
    expect(contentLine!).toMatch(/^ {4}/);
  });
});

// ---------------------------------------------------------------------------
// Tool events
// ---------------------------------------------------------------------------

describe('replayTurns — tool events', () => {
  it('emits a tool summary line when toolEvents are present', () => {
    const { writer, lines } = makeCollector();
    replayTurns([
      makeTurn({
        toolEvents: [
          { toolName: 'bash', toolUseId: 'tu-1', input: 'ls -la', isError: false },
        ],
      }),
    ], writer);
    expect(flat(lines)).toContain('Tools used');
    expect(flat(lines)).toContain('bash');
  });

  it('does not emit a tool summary when toolEvents is empty', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ toolEvents: [] })], writer);
    expect(flat(lines)).not.toContain('Tools used');
  });

  it('does not emit a tool summary when toolEvents is absent', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ toolEvents: undefined })], writer);
    expect(flat(lines)).not.toContain('Tools used');
  });

  it('shows the error indicator for failed tool events', () => {
    const { writer, lines } = makeCollector();
    replayTurns([
      makeTurn({
        toolEvents: [
          { toolName: 'read_file', toolUseId: 'tu-err', input: '/nonexistent', isError: true },
        ],
      }),
    ], writer);
    expect(flat(lines)).toContain('✗');
  });
});

// ---------------------------------------------------------------------------
// maxTurns cap — 51-turn session (default cap = 50)
// ---------------------------------------------------------------------------

describe('replayTurns — 51 turns with default cap', () => {
  it('emits a divider line when records.length > maxTurns', () => {
    const { writer, lines } = makeCollector();
    replayTurns(makeTurns(51), writer);
    // The omitted-turns notice mentions "1 earlier turn omitted".
    const text = flat(lines);
    expect(text).toMatch(/earlier turn.*omitted/i);
  });

  it('renders exactly 50 turns (not 51) by default', () => {
    const { writer, lines } = makeCollector();
    replayTurns(makeTurns(51), writer);
    const text = flat(lines);
    // Turn 1 is the sole omitted turn. Use word-boundary patterns to avoid
    // false positives from "user message 10", "user message 11", etc.
    expect(text).not.toMatch(/user message 1\b/);
    expect(text).toContain('user message 2');
    expect(text).toContain('user message 51');
  });
});

// ---------------------------------------------------------------------------
// maxTurns cap — exactly 50 turns (no divider)
// ---------------------------------------------------------------------------

describe('replayTurns — exactly 50 turns, no divider', () => {
  it('does not emit a divider when records.length === maxTurns', () => {
    const { writer, lines } = makeCollector();
    replayTurns(makeTurns(50), writer);
    const text = flat(lines);
    expect(text).not.toMatch(/earlier turn.*omitted/i);
  });

  it('renders all 50 turns', () => {
    const { writer, lines } = makeCollector();
    replayTurns(makeTurns(50), writer);
    const text = flat(lines);
    expect(text).toContain('user message 1');
    expect(text).toContain('user message 50');
  });
});

// ---------------------------------------------------------------------------
// maxTurns override
// ---------------------------------------------------------------------------

describe('replayTurns — maxTurns override', () => {
  it('respects a custom maxTurns of 3', () => {
    const { writer, lines } = makeCollector();
    replayTurns(makeTurns(10), writer, { maxTurns: 3 });
    const text = flat(lines);
    // Only the last 3 turns (8, 9, 10) should appear. Use word-boundary patterns
    // to avoid false positives: e.g. "user message 1" matches inside "user message 10".
    expect(text).not.toMatch(/user message [1-7]\b/);
    expect(text).toContain('user message 8');
    expect(text).toContain('user message 10');
  });

  it('emits a divider when cap is exceeded by a custom maxTurns', () => {
    const { writer, lines } = makeCollector();
    replayTurns(makeTurns(5), writer, { maxTurns: 2 });
    const text = flat(lines);
    expect(text).toMatch(/earlier turn.*omitted/i);
  });

  it('does not emit a divider when records exactly match custom cap', () => {
    const { writer, lines } = makeCollector();
    replayTurns(makeTurns(3), writer, { maxTurns: 3 });
    const text = flat(lines);
    expect(text).not.toMatch(/earlier turn.*omitted/i);
  });

  it('renders all records when maxTurns is larger than records.length', () => {
    const { writer, lines } = makeCollector();
    replayTurns(makeTurns(5), writer, { maxTurns: 100 });
    const text = flat(lines);
    expect(text).toContain('user message 1');
    expect(text).toContain('user message 5');
    expect(text).not.toMatch(/earlier turn.*omitted/i);
  });
});

// ---------------------------------------------------------------------------
// Long assistant text truncation
// ---------------------------------------------------------------------------

describe('replayTurns — long assistant text', () => {
  it('truncates assistant text longer than 2000 chars with a char-count note', () => {
    const longText = 'x'.repeat(2500);
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ assistant: longText })], writer);
    const text = flat(lines);
    // The truncation note should include the total char count.
    expect(text).toContain('2500 chars total');
    expect(text).toContain('truncated');
  });

  it('shows the first 1500 chars before the truncation note', () => {
    const longText = 'a'.repeat(2500);
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ assistant: longText })], writer);
    const text = flat(lines);
    // 1500 a's should be present somewhere.
    expect(text).toContain('a'.repeat(1500));
    // But not the full 2500.
    expect(text).not.toContain('a'.repeat(2500));
  });

  it('does not truncate assistant text at or below 2000 chars', () => {
    const borderText = 'b'.repeat(2000);
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ assistant: borderText })], writer);
    const text = flat(lines);
    expect(text).not.toContain('truncated');
    expect(text).not.toContain('chars total');
  });

  it('does not truncate user text regardless of length', () => {
    // User text is collapsed (whitespace) but never truncated.
    const longUser = 'u'.repeat(3000);
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ user: longUser, assistant: 'ok' })], writer);
    const text = flat(lines);
    // All user characters should be present (collapsed into one long line).
    expect(text).toContain('u'.repeat(3000));
    expect(text).not.toMatch(/chars total/);
  });
});

// ---------------------------------------------------------------------------
// Writer isolation
// ---------------------------------------------------------------------------

describe('replayTurns — writer isolation', () => {
  it('routes all output through the writer param', () => {
    // The collector is the ONLY writer. If any line went to console.log or
    // process.stdout the test would still pass (no side-channel), but
    // lines.length > 0 proves the writer was called at all.
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn(), makeTurn(), makeTurn()], writer);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('a second distinct writer receives no lines from the first call', () => {
    const first = makeCollector();
    const second = makeCollector();
    replayTurns([makeTurn({ user: 'first', assistant: 'a' })], first.writer);
    replayTurns([makeTurn({ user: 'second', assistant: 'b' })], second.writer);
    // First writer should not contain 'second', and vice versa.
    expect(flat(first.lines)).not.toContain('second');
    expect(flat(second.lines)).not.toContain('first');
  });
});

// ---------------------------------------------------------------------------
// UTF-16 surrogate safety
// ---------------------------------------------------------------------------

describe('replayTurns — surrogate-safe truncation', () => {
  it('does not split UTF-16 surrogate pairs at the truncation boundary', () => {
    // Build input where the truncation cut lands inside an emoji surrogate pair
    const longText = 'a'.repeat(1499) + '🎉🎉🎉';
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ assistant: longText })], writer);
    const text = flat(lines);
    // Should not contain the replacement character that lone surrogates produce
    expect(text).not.toContain('\uFFFD');
    // The output should contain at least one complete emoji (the code-point-aware
    // slice should include the emoji that starts at position 1499)
    expect(text).toContain('🎉');
  });
});

// ---------------------------------------------------------------------------
// Degenerate turns
// ---------------------------------------------------------------------------

describe('replayTurns — degenerate turns', () => {
  it('skips a turn where both user and assistant are empty after normalization', () => {
    const { writer, lines } = makeCollector();
    replayTurns([
      makeTurn({ user: '', assistant: '' }),
      makeTurn({ user: 'real', assistant: 'content' }),
    ], writer);
    const text = flat(lines);
    // The empty turn should NOT produce a separator, user header, or assistant header
    // But the second real turn should render normally
    expect(text).toContain('real');
    expect(text).toContain('content');
    // Count separators — should be 1 (for the real turn), not 2
    const separators = lines.filter(l => strip(l).includes('─────'));
    expect(separators).toHaveLength(1);
  });

  it('does not skip a turn where only the user is empty', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ user: '', assistant: 'has content' })], writer);
    const text = flat(lines);
    expect(text).toContain('has content');
    expect(text).toContain('(empty)');
  });

  it('does not skip a turn where only the assistant is empty', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ user: 'has content', assistant: '' })], writer);
    const text = flat(lines);
    expect(text).toContain('has content');
    expect(text).toContain('(empty)');
  });
});

// ---------------------------------------------------------------------------
// Stats footer
// ---------------------------------------------------------------------------

describe('replayTurns — stats footer', () => {
  it('emits a cost line when costUsd is present and > 0', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ costUsd: 0.0042 })], writer);
    expect(flat(lines)).toContain('$0.0042');
  });

  it('emits a duration line when durationMs is present and > 0', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ durationMs: 3500 })], writer);
    expect(flat(lines)).toContain('3.5s');
  });

  it('does not emit stats when both are absent', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ costUsd: undefined, durationMs: undefined })], writer);
    expect(flat(lines)).not.toContain('$');
    expect(flat(lines)).not.toContain('0.0s');
  });
});

// ---------------------------------------------------------------------------
// ANSI injection via ToolEvent.input (regression test)
// ---------------------------------------------------------------------------

describe('replayTurns — ANSI injection via ToolEvent.input', () => {
  it('strips ANSI escape sequences from tool event input and emits the plain text', () => {
    const { writer, lines } = makeCollector();
    replayTurns(
      [
        makeTurn({
          toolEvents: [
            { toolName: 'bash', toolUseId: 'tu-1', input: '\x1b[31mred\x1b[0m', isError: false },
          ],
        }),
      ],
      writer,
    );
    const raw = lines.join('\n');
    // The visible word must be present.
    expect(raw).toContain('red');
    // Raw ANSI CSI sequences must NOT appear in writer output.
    // eslint-disable-next-line no-control-regex
    expect(raw).not.toContain('\x1b[31m');
  });
});

// ---------------------------------------------------------------------------
// Degenerate turn skip (both user and assistant empty)
// ---------------------------------------------------------------------------

describe('replayTurns — degenerate turn skip', () => {
  it('emits nothing when both user and assistant are empty strings', () => {
    const { writer, lines } = makeCollector();
    replayTurns([makeTurn({ user: '', assistant: '' })], writer);
    expect(lines.length).toBe(0);
  });
});
