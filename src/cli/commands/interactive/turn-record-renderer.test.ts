/**
 * Tests for turn-record-renderer.ts
 *
 * Covers:
 *   - renderResumeViewHeader — includes session name/id and turn count
 *   - buildResumeFooterLine — correct text per state
 *   - renderTurnRecords — renders user/assistant/tool events correctly,
 *     handles empty turns, handles missing fields, handles limit cap
 */

import { describe, it, expect } from 'vitest';
import {
  renderResumeViewHeader,
  buildResumeFooterLine,
  renderTurnRecords,
} from './turn-record-renderer.js';
import type { TurnRecord } from '../../slash/types.js';
import type { Writer } from '../../slash/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Writer that captures all lines. */
function makeWriter(): { out: Writer; lines: string[] } {
  const lines: string[] = [];
  const out: Writer = {
    line: (t = ''): void => { lines.push(t); },
    raw: (t): void => { lines.push(t); },
    success: (t): void => { lines.push(`SUCCESS:${t}`); },
    info: (t): void => { lines.push(`INFO:${t}`); },
    warn: (t): void => { lines.push(`WARN:${t}`); },
    error: (t): void => { lines.push(`ERROR:${t}`); },
  };
  return { out, lines };
}

/** Strip ANSI escape sequences for assertion-friendly comparisons. */
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Join lines and strip ANSI. */
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

// ---------------------------------------------------------------------------
// renderResumeViewHeader
// ---------------------------------------------------------------------------

describe('renderResumeViewHeader', () => {
  it('includes the session id (truncated) when no name given', () => {
    const header = strip(renderResumeViewHeader({ id: 'abc-123-def-456-789', totalTurns: 3 }));
    expect(header).toContain('abc-123-def-');
    expect(header).toContain('3 turns');
  });

  it('includes the session name when provided', () => {
    const header = strip(renderResumeViewHeader({ name: 'my-session', id: 'abc', totalTurns: 1 }));
    expect(header).toContain('my-session');
    expect(header).toContain('1 turn');
  });

  it('singularizes "turn" for totalTurns=1', () => {
    const header = strip(renderResumeViewHeader({ id: 'x', totalTurns: 1 }));
    expect(header).toMatch(/\b1 turn\b/);
    expect(header).not.toMatch(/\b1 turns\b/);
  });

  it('pluralizes "turns" for totalTurns > 1', () => {
    const header = strip(renderResumeViewHeader({ id: 'x', totalTurns: 5 }));
    expect(header).toContain('5 turns');
  });

  it('includes separator lines', () => {
    const header = renderResumeViewHeader({ id: 'x', totalTurns: 2 });
    // Header should have at least two separator lines (─ chars)
    const sepCount = (header.match(/─/g) ?? []).length;
    expect(sepCount).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// buildResumeFooterLine
// ---------------------------------------------------------------------------

describe('buildResumeFooterLine', () => {
  it('preview state shows Enter and Esc hints', () => {
    const line = strip(buildResumeFooterLine('preview'));
    expect(line).toContain('Enter');
    expect(line).toContain('Esc');
    expect(line).toContain('resume');
  });

  it('cancelled state shows cancellation message', () => {
    const line = strip(buildResumeFooterLine('cancelled'));
    expect(line.toLowerCase()).toContain('cancel');
  });

  it('resuming state shows resuming message', () => {
    const line = strip(buildResumeFooterLine('resuming'));
    expect(line.toLowerCase()).toContain('resum');
  });
});

// ---------------------------------------------------------------------------
// renderTurnRecords — basic rendering
// ---------------------------------------------------------------------------

describe('renderTurnRecords — basic rendering', () => {
  it('renders user text for each turn', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([makeTurn({ user: 'what is 2+2?' })], out);
    expect(flat(lines)).toContain('what is 2+2?');
  });

  it('renders assistant text for each turn', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([makeTurn({ assistant: 'The answer is 4.' })], out);
    expect(flat(lines)).toContain('The answer is 4.');
  });

  it('renders role headers — User and Assistant', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([makeTurn()], out);
    const text = flat(lines);
    expect(text).toContain('User');
    expect(text).toContain('Assistant');
  });

  it('renders a separator between turns', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([makeTurn(), makeTurn()], out);
    // Should have separator (─ chars) after each turn
    const sepLines = lines.filter(l => strip(l).match(/^─{4,}/));
    expect(sepLines.length).toBeGreaterThanOrEqual(2);
  });

  it('renders multiple turns in order', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([
      makeTurn({ user: 'first question', assistant: 'first answer' }),
      makeTurn({ user: 'second question', assistant: 'second answer' }),
    ], out);
    const text = flat(lines);
    const idx1 = text.indexOf('first question');
    const idx2 = text.indexOf('second question');
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
  });
});

// ---------------------------------------------------------------------------
// renderTurnRecords — empty turns
// ---------------------------------------------------------------------------

describe('renderTurnRecords — empty turns array', () => {
  it('renders a placeholder when turns is empty', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([], out);
    expect(flat(lines)).toContain('no turns recorded');
  });

  it('renders nothing beyond the placeholder for empty input', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([], out);
    // Only the placeholder line
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    expect(nonEmpty.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// renderTurnRecords — missing fields
// ---------------------------------------------------------------------------

describe('renderTurnRecords — missing/empty fields', () => {
  it('handles missing user field gracefully', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([makeTurn({ user: '' })], out);
    const text = flat(lines);
    // Should render "empty" placeholder, not crash
    expect(text).toContain('empty');
    expect(text).toContain('Assistant');
  });

  it('handles missing assistant field gracefully', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([makeTurn({ assistant: '' })], out);
    const text = flat(lines);
    expect(text).toContain('User');
    expect(text).toContain('empty');
  });

  it('skips turns where both user and assistant are empty', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([makeTurn({ user: '', assistant: '' })], out);
    // An all-empty turn is skipped — no User/Assistant headers appear
    const text = flat(lines);
    expect(text).not.toContain('User');
    expect(text).not.toContain('Assistant');
  });

  it('renders turns without toolEvents without errors', () => {
    const { out, lines } = makeWriter();
    expect(() =>
      renderTurnRecords([makeTurn({ toolEvents: undefined })], out)
    ).not.toThrow();
    expect(lines.length).toBeGreaterThan(0);
  });

  it('renders turns with empty toolEvents without tool summary', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([makeTurn({ toolEvents: [] })], out);
    // "Tools used" should NOT appear since there are no tool events
    const text = flat(lines);
    expect(text).not.toContain('Tools used');
  });
});

// ---------------------------------------------------------------------------
// renderTurnRecords — tool events
// ---------------------------------------------------------------------------

describe('renderTurnRecords — tool events', () => {
  it('renders tool event summary when toolEvents are present', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([
      makeTurn({
        toolEvents: [
          {
            toolName: 'bash',
            toolUseId: 'tu-1',
            input: 'ls -la',
            result: 'file1.ts\nfile2.ts',
            isError: false,
          },
        ],
      }),
    ], out);
    const text = flat(lines);
    expect(text).toContain('bash');
    expect(text).toContain('Tools used');
  });

  it('shows error indicator for failed tool events', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords([
      makeTurn({
        toolEvents: [
          {
            toolName: 'read_file',
            toolUseId: 'tu-err',
            input: '/nonexistent',
            result: 'ENOENT',
            isError: true,
          },
        ],
      }),
    ], out);
    const text = flat(lines);
    expect(text).toContain('read_file');
    // Error indicator (✗) in the tool summary
    expect(text).toContain('✗');
  });
});

// ---------------------------------------------------------------------------
// renderTurnRecords — limit cap
// ---------------------------------------------------------------------------

describe('renderTurnRecords — limit cap', () => {
  it('renders only the last N turns when limit is set', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords(
      [
        makeTurn({ user: 'turn one', assistant: 'answer one' }),
        makeTurn({ user: 'turn two', assistant: 'answer two' }),
        makeTurn({ user: 'turn three', assistant: 'answer three' }),
      ],
      out,
      2,
    );
    const text = flat(lines);
    // The last 2 turns should be visible; the first should not
    expect(text).toContain('turn two');
    expect(text).toContain('turn three');
    expect(text).not.toContain('turn one');
  });

  it('shows an "earlier turns not shown" notice when capped', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords(
      [
        makeTurn({ user: 'a' }),
        makeTurn({ user: 'b' }),
        makeTurn({ user: 'c' }),
      ],
      out,
      2,
    );
    const text = flat(lines);
    expect(text).toMatch(/earlier turn/i);
  });

  it('renders all turns when limit equals turn count', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords(
      [makeTurn({ user: 'alpha' }), makeTurn({ user: 'beta' })],
      out,
      2,
    );
    const text = flat(lines);
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    // No "earlier turns" notice when limit exactly matches
    expect(text).not.toMatch(/earlier turn/i);
  });

  it('respects limit=0 as "no limit" (renders all)', () => {
    const { out, lines } = makeWriter();
    renderTurnRecords(
      [makeTurn({ user: 'x' }), makeTurn({ user: 'y' })],
      out,
      0,
    );
    const text = flat(lines);
    expect(text).toContain('x');
    expect(text).toContain('y');
  });
});

// ---------------------------------------------------------------------------
// renderTurnRecords — content truncation
// ---------------------------------------------------------------------------

describe('renderTurnRecords — content truncation', () => {
  it('truncates very long user messages without crashing', () => {
    const longText = 'a'.repeat(2000);
    const { out, lines } = makeWriter();
    expect(() => renderTurnRecords([makeTurn({ user: longText })], out)).not.toThrow();
    // Output should be shorter than the raw 2000-char string
    const text = flat(lines);
    expect(text.length).toBeLessThan(longText.length + 500);
  });

  it('truncates very long assistant messages without crashing', () => {
    const longText = 'b'.repeat(2000);
    const { out, lines } = makeWriter();
    expect(() => renderTurnRecords([makeTurn({ assistant: longText })], out)).not.toThrow();
    const text = flat(lines);
    expect(text.length).toBeLessThan(longText.length + 500);
  });
});
