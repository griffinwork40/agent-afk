import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../display.js';
import { interruptPeek } from './interrupt-peek.js';

describe('interruptPeek', () => {
  it("renders 'interrupting' status correctly", () => {
    const result = stripAnsi(interruptPeek({ status: 'interrupting' }));
    expect(result).toContain('⚠ interrupting…');
    expect(result).toContain('Ctrl+C again to exit');
  });

  it("renders 'interrupted' status correctly", () => {
    const result = stripAnsi(interruptPeek({ status: 'interrupted' }));
    expect(result).toContain('⚠ interrupted');
    expect(result).not.toContain('interrupting…');
  });

  it('renders active subagent with name, tool, and elapsed', () => {
    const result = stripAnsi(
      interruptPeek({
        status: 'interrupting',
        activeSubagent: {
          name: 'research-agent',
          currentTool: 'bash',
          elapsed: 12000,
        },
      }),
    );
    expect(result).toContain('▸ research-agent — bash (12s)');
    expect(result).toContain('⚠ interrupting…');
  });

  it('renders active subagent with name only (no tool or elapsed)', () => {
    const result = stripAnsi(
      interruptPeek({
        status: 'interrupting',
        activeSubagent: { name: 'fix-agent' },
      }),
    );
    expect(result).toContain('▸ fix-agent — thinking');
    // No elapsed part when elapsed is undefined
    expect(result).not.toMatch(/thinking \(/);
  });

  it('renders active subagent with name and tool, no elapsed', () => {
    const result = stripAnsi(
      interruptPeek({
        status: 'interrupting',
        activeSubagent: { name: 'review-agent', currentTool: 'read_file' },
      }),
    );
    expect(result).toContain('▸ review-agent — read_file');
    expect(result).not.toMatch(/read_file \(/);
  });

  it('renders fallback (no subagent) with just warning and hint', () => {
    const result = stripAnsi(interruptPeek({ status: 'interrupting' }));
    const lines = result.split('\n').filter(Boolean);
    // Should be 2 lines: warning + hint (no subagent context)
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('⚠ interrupting…');
    expect(lines[1]).toContain('Ctrl+C again to exit');
  });

  it('renders custom hint text', () => {
    const result = stripAnsi(
      interruptPeek({ status: 'interrupted', hint: 'Press Enter to continue' }),
    );
    expect(result).toContain('Press Enter to continue');
    expect(result).not.toContain('Ctrl+C again to exit');
  });

  it('uses default hint when none is provided', () => {
    const result = stripAnsi(interruptPeek({ status: 'interrupting' }));
    expect(result).toContain('Ctrl+C again to exit');
  });

  it('formats sub-second elapsed as <1s', () => {
    const result = stripAnsi(
      interruptPeek({
        status: 'interrupting',
        activeSubagent: { name: 'agent', elapsed: 500 },
      }),
    );
    expect(result).toContain('(<1s)');
  });

  it('formats minute-range elapsed correctly', () => {
    const result = stripAnsi(
      interruptPeek({
        status: 'interrupting',
        activeSubagent: { name: 'agent', elapsed: 125000 },
      }),
    );
    expect(result).toContain('(2m 5s)');
  });

  it('produces 3 lines when subagent info is present', () => {
    const result = stripAnsi(
      interruptPeek({
        status: 'interrupting',
        activeSubagent: { name: 'agent', currentTool: 'bash', elapsed: 3000 },
      }),
    );
    const lines = result.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
  });

  it('truncates lines to the specified width', () => {
    const result = stripAnsi(
      interruptPeek({
        status: 'interrupting',
        activeSubagent: {
          name: 'a-very-long-subagent-name-that-exceeds-limits',
          currentTool: 'bash',
          elapsed: 99000,
        },
        hint: 'This is a very long hint text that should be truncated by the width option',
        width: 30,
      }),
    );
    const lines = result.split('\n').filter(Boolean);
    // Every line must be at most 30 columns wide (including the 2-char indent).
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });
});
