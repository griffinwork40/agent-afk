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
