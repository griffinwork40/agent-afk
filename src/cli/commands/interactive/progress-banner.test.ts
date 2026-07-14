/**
 * Regression tests for progress-banner terminal-width clamping.
 *
 * Verifies that every public function in progress-banner.ts enforces a hard
 * upper bound on rendered line width so that long descriptions, summaries, and
 * agent labels never wrap onto a second terminal row and corrupt multi-line
 * REPL layout.
 *
 * The `columns` parameter is used to inject a deterministic width so these
 * tests are not coupled to the real `process.stdout.columns` value.
 *
 * The `displayWidth` helper from display.ts is used to measure stripped lines
 * in the same way the clamping logic does internally, ensuring the assertions
 * are about display columns rather than raw byte length.
 */

import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { displayWidth, stripAnsi } from '../../display.js';
import {
  deriveProgressActivity,
  formatProgressBanner,
  formatProgressSummary,
  formatRateLimitActivity,
  formatSubagentCompletion,
  emitSubagentCompletion,
} from './progress-banner.js';
import type { ProgressEvent } from '../../../agent/types.js';
import type { CompletionWriter } from './shared.js';
import type { SubagentCompleteInfo } from '../../../agent/default-hook-registry.js';

// Force color output so ANSI sequences are present in the rendered strings and
// the ANSI-aware truncation path is exercised (not just plain-text slicing).
const savedLevel = chalk.level;
chalk.level = 3;

const mkEvent = (overrides: Partial<ProgressEvent> & { description: string }): ProgressEvent => ({
  taskId: 'test-task',
  totalTokens: 0,
  toolUses: 0,
  durationMs: 0,
  ...overrides,
});

// A string long enough to overflow any reasonable narrow terminal.
const LONG = 'A'.repeat(300);

describe('progress-banner — terminal width clamping', () => {
  describe('formatProgressBanner', () => {
    it('clamps each line to the provided column width', () => {
      const cols = 60;
      const lines = formatProgressBanner(mkEvent({ description: LONG }), cols);
      for (const line of lines) {
        expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(cols);
      }
    });

    it('clamps the description line when no summary is present', () => {
      const cols = 40;
      const lines = formatProgressBanner(mkEvent({ description: LONG }), cols);
      expect(lines).toHaveLength(1);
      expect(displayWidth(stripAnsi(lines[0]!))).toBeLessThanOrEqual(cols);
    });

    it('clamps both lines independently when summary is present', () => {
      const cols = 50;
      const lines = formatProgressBanner(
        mkEvent({ description: LONG, summary: LONG }),
        cols,
      );
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(cols);
      }
    });

    it('appends an ellipsis when a line is truncated', () => {
      const cols = 30;
      const lines = formatProgressBanner(mkEvent({ description: LONG }), cols);
      expect(stripAnsi(lines[0]!)).toMatch(/…$/);
    });

    it('does NOT truncate lines that fit within the column width', () => {
      const cols = 200;
      const description = 'Short description';
      const lines = formatProgressBanner(mkEvent({ description }), cols);
      const stripped = stripAnsi(lines[0]!);
      expect(stripped).toContain(description);
      expect(stripped).not.toMatch(/…/);
    });

    it('clamps lines containing ANSI color codes without corrupting escapes', () => {
      const cols = 60;
      const lines = formatProgressBanner(
        mkEvent({ description: LONG, lastToolName: 'Bash', toolUses: 5 }),
        cols,
      );
      for (const line of lines) {
        // displayWidth strips ANSI before measuring — the bound is on visible chars.
        expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(cols);
        // The raw string must not contain a stray ESC that is not part of a
        // complete CSI/SGR sequence (i.e. no broken ANSI mid-truncation).
        const stripped = stripAnsi(line);
        // After stripping all valid ANSI, nothing that looks like a broken
        // escape sequence should remain.
        expect(stripped).not.toMatch(/\x1b/);
      }
    });

    it('falls back gracefully when columns is Infinity (no clamping)', () => {
      const lines = formatProgressBanner(mkEvent({ description: LONG }), Infinity);
      // With Infinity, the full description should be present (no truncation).
      expect(stripAnsi(lines[0]!)).toContain(LONG);
    });
  });

  describe('formatProgressBanner — sanitization (LLM-sourced fields)', () => {
    it('strips ANSI escapes injected via description', () => {
      const lines = formatProgressBanner(
        mkEvent({ description: 'evil\x1b[2Jtask' }),
        Infinity,
      );
      // stripAnsi in the assertion would mask the bug — assert on the RAW
      // string: the injected CSI must not survive into the rendered output.
      expect(lines[0]!).not.toContain('\x1b[2J');
      // sanitizeLabel strips the complete CSI sequence (no residual space).
      expect(stripAnsi(lines[0]!)).toContain('eviltask');
    });

    it('strips control bytes injected via summary', () => {
      const lines = formatProgressBanner(
        mkEvent({ description: 'task', summary: 'sum\x07mary\x0d' }),
        Infinity,
      );
      expect(lines[1]!).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      expect(stripAnsi(lines[1]!)).toContain('sum mary');
    });

    it('collapses newlines in the activity clause to a single line', () => {
      const lines = formatProgressBanner(
        mkEvent({ description: 'task' }),
        Infinity,
        'line one\nline two',
      );
      expect(lines).toHaveLength(2);
      expect(lines[1]!).not.toContain('\n');
      expect(stripAnsi(lines[1]!)).toContain('line one line two');
    });
  });

  describe('formatProgressBanner — activity precedence', () => {
    it('prefers activity over summary on the detail line', () => {
      const lines = formatProgressBanner(
        mkEvent({ description: 'task', summary: 'round 3: bash ls' }),
        Infinity,
        'Now checking the config loader',
      );
      expect(lines).toHaveLength(2);
      expect(stripAnsi(lines[1]!)).toContain('Now checking the config loader');
      expect(stripAnsi(lines[1]!)).not.toContain('round 3: bash ls');
    });

    it('falls back to summary when activity is undefined', () => {
      const lines = formatProgressBanner(
        mkEvent({ description: 'task', summary: 'round 3: bash ls' }),
        Infinity,
      );
      expect(lines).toHaveLength(2);
      expect(stripAnsi(lines[1]!)).toContain('round 3: bash ls');
    });

    it('falls back to summary when activity is whitespace-only', () => {
      const lines = formatProgressBanner(
        mkEvent({ description: 'task', summary: 'round 3: bash ls' }),
        Infinity,
        '   ',
      );
      expect(stripAnsi(lines[1]!)).toContain('round 3: bash ls');
    });

    it('renders single-line description form when neither activity nor summary exists', () => {
      const lines = formatProgressBanner(mkEvent({ description: 'task' }), Infinity);
      expect(lines).toHaveLength(1);
    });
  });

  describe('deriveProgressActivity', () => {
    it('returns undefined for an empty buffer', () => {
      expect(deriveProgressActivity('', 80)).toBeUndefined();
    });

    it('returns undefined for a whitespace-only buffer', () => {
      expect(deriveProgressActivity('   \n  ', 80)).toBeUndefined();
    });

    it('extracts the latest in-flight clause after a sentence boundary', () => {
      const buffer = 'First I read the file. Now checking the dispatcher wiring';
      expect(deriveProgressActivity(buffer, 120)).toBe('Now checking the dispatcher wiring');
    });

    it('truncates overlong clauses with an ellipsis', () => {
      const clause = 'B'.repeat(500);
      const out = deriveProgressActivity(clause, 60);
      expect(out).toBeDefined();
      expect(out!.length).toBeLessThanOrEqual(60 - 10);
      expect(out).toMatch(/…$/);
    });
  });

  describe('formatProgressSummary', () => {
    it('clamps the summary line to the provided column width', () => {
      const cols = 60;
      const line = formatProgressSummary(mkEvent({ description: LONG }), cols);
      expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(cols);
    });

    it('appends an ellipsis when the summary line is truncated', () => {
      const cols = 30;
      const line = formatProgressSummary(mkEvent({ description: LONG }), cols);
      expect(stripAnsi(line)).toMatch(/…$/);
    });

    it('does NOT truncate when the line fits within the column width', () => {
      const cols = 200;
      const description = 'Short task';
      const line = formatProgressSummary(mkEvent({ description }), cols);
      expect(stripAnsi(line)).toContain(description);
      expect(stripAnsi(line)).not.toMatch(/…/);
    });

    it('falls back gracefully when columns is Infinity (no clamping)', () => {
      const line = formatProgressSummary(mkEvent({ description: LONG }), Infinity);
      expect(stripAnsi(line)).toContain(LONG);
    });
  });

  describe('formatSubagentCompletion', () => {
    it('clamps the completion line to the provided column width', () => {
      const cols = 50;
      const line = formatSubagentCompletion(
        { subagentId: LONG, status: 'succeeded' },
        cols,
      );
      expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(cols);
    });

    it('clamps lines with a very long agentType label', () => {
      const cols = 40;
      const line = formatSubagentCompletion(
        { subagentId: 'sa-1', status: 'failed', agentType: LONG },
        cols,
      );
      expect(displayWidth(stripAnsi(line))).toBeLessThanOrEqual(cols);
    });

    it('appends an ellipsis when the line is truncated', () => {
      const cols = 20;
      const line = formatSubagentCompletion(
        { subagentId: LONG, status: 'succeeded' },
        cols,
      );
      expect(stripAnsi(line)).toMatch(/…$/);
    });

    it('does NOT truncate when the label fits within the column width', () => {
      const cols = 200;
      const label = 'research-agent';
      const line = formatSubagentCompletion(
        { subagentId: 'sa-x', status: 'succeeded', agentType: label },
        cols,
      );
      expect(stripAnsi(line)).toContain(label);
      expect(stripAnsi(line)).not.toMatch(/…/);
    });

    it('falls back gracefully when columns is Infinity (no clamping)', () => {
      const line = formatSubagentCompletion(
        { subagentId: LONG, status: 'succeeded' },
        Infinity,
      );
      expect(stripAnsi(line)).toContain(LONG);
    });
  });

  // Regression: the compositor/scrollback overlap on parallel subagent
  // completion (`compose`/devils-advocate). The SubagentStop hook fires
  // Channel B (`✓ <node> · <time>`) independently of the parent turn's SDK
  // events; in the REPL the ToolLane (Channel A) already renders each
  // foreground subagent, so Channel B must be suppressed WHILE the live
  // overlay owns the surface — otherwise its uncoordinated commitAbove races
  // the OverlayComposer and corrupts the compositor's row-accounting (ghost
  // ◉ markers + swallowed committed lines). Previously UNCOVERED: no test
  // combined concurrent subagent completions with a live-overlay commit gate.
  describe('emitSubagentCompletion — turn-scoped suppression gate', () => {
    function makeWriter(): { writer: CompletionWriter; committed: string[] } {
      const committed: string[] = [];
      const writer: CompletionWriter = {
        fn: (line) => committed.push(line),
        idleFn: (line) => committed.push(line),
      };
      return { writer, committed };
    }
    const info = (id: string): SubagentCompleteInfo => ({
      subagentId: id,
      status: 'succeeded',
      durationMs: 28_000,
      agentType: id,
    });

    it('emits the completion line when NOT suppressed (between turns / chat)', () => {
      const { writer, committed } = makeWriter();
      emitSubagentCompletion(writer, info('da-paranoid'));
      expect(committed).toHaveLength(1);
      expect(stripAnsi(committed[0]!)).toContain('da-paranoid');
    });

    it('drops the completion line when suppressed (live foreground overlay)', () => {
      const { writer, committed } = makeWriter();
      writer.suppressSubagentCompletion = true;
      emitSubagentCompletion(writer, info('da-pragmatist'));
      expect(committed).toHaveLength(0);
    });

    it('suppresses every concurrent sibling while the overlay is live (no double-render)', () => {
      // The screenshot case: 3 parallel critics finishing on independent
      // schedules. With the overlay live, NONE of the ✓ lines commit — the
      // ToolLane tree is the sole completion record, so no interleaved
      // commitAbove perturbs the frame geometry.
      const { writer, committed } = makeWriter();
      writer.suppressSubagentCompletion = true;
      for (const id of ['da-paranoid', 'da-pragmatist', 'da-architect']) {
        emitSubagentCompletion(writer, info(id));
      }
      expect(committed).toHaveLength(0);

      // Once the turn ends and suppression clears, a late (backgrounded)
      // completion surfaces again — Channel B is only muted, never removed.
      writer.suppressSubagentCompletion = false;
      emitSubagentCompletion(writer, info('bg-late'));
      expect(committed).toHaveLength(1);
      expect(stripAnsi(committed[0]!)).toContain('bg-late');
    });

    it('treats an undefined flag as not-suppressed (default behavior preserved)', () => {
      const { writer, committed } = makeWriter();
      expect(writer.suppressSubagentCompletion).toBeUndefined();
      emitSubagentCompletion(writer, info('sa-default'));
      expect(committed).toHaveLength(1);
    });
  });
});

describe('formatRateLimitActivity', () => {
  it('rounds a whole-second retry-after to ~Ns', () => {
    expect(formatRateLimitActivity(70_000)).toBe('rate-limited · retrying in ~70s');
  });

  it('rounds a fractional retry-after UP to the next whole second', () => {
    // 70_001ms → 71s (ceil), so a partial second is never under-reported.
    expect(formatRateLimitActivity(70_001)).toBe('rate-limited · retrying in ~71s');
    // 29_500ms → 30s.
    expect(formatRateLimitActivity(29_500)).toBe('rate-limited · retrying in ~30s');
  });

  it('shows ~1s for a sub-second retry-after rather than ~0s', () => {
    expect(formatRateLimitActivity(500)).toBe('rate-limited · retrying in ~1s');
    expect(formatRateLimitActivity(1)).toBe('rate-limited · retrying in ~1s');
  });

  it('drops the ETA when retryAfterMs is undefined', () => {
    expect(formatRateLimitActivity(undefined)).toBe('rate-limited · retrying…');
  });

  it('drops the ETA for a zero or negative delay (no positive time to show)', () => {
    expect(formatRateLimitActivity(0)).toBe('rate-limited · retrying…');
    expect(formatRateLimitActivity(-5_000)).toBe('rate-limited · retrying…');
  });

  it('drops the ETA for a non-finite delay (defensive)', () => {
    expect(formatRateLimitActivity(Number.NaN)).toBe('rate-limited · retrying…');
    expect(formatRateLimitActivity(Number.POSITIVE_INFINITY)).toBe('rate-limited · retrying…');
  });
});

// Restore chalk level after tests run.
chalk.level = savedLevel;
