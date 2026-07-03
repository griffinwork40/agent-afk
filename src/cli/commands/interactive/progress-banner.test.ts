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
  formatSubagentCompletion,
} from './progress-banner.js';
import type { ProgressEvent } from '../../../agent/types.js';

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
});

// Restore chalk level after tests run.
chalk.level = savedLevel;
