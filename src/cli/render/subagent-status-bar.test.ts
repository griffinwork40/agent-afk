import { describe, it, expect } from 'vitest';
import { stripAnsi } from '../display.js';
import { subagentStatusBar, subagentStatusStack } from './subagent-status-bar.js';

describe('subagentStatusBar', () => {
  it('renders label and elapsed', () => {
    const result = stripAnsi(
      subagentStatusBar({ label: 'research-agent', elapsedMs: 5000 }),
    );
    expect(result).toContain('◉');
    expect(result).toContain('research-agent');
    expect(result).toContain('5s');
  });

  it('renders phase when provided', () => {
    const result = stripAnsi(
      subagentStatusBar({
        label: 'Agent(review)',
        phase: 'thinking…',
        elapsedMs: 12000,
      }),
    );
    expect(result).toContain('thinking…');
    expect(result).toContain('12s');
  });

  it('renders batch badge when batch info provided', () => {
    const result = stripAnsi(
      subagentStatusBar({
        label: 'explore',
        elapsedMs: 3000,
        batchIndex: 2,
        batchSize: 4,
      }),
    );
    expect(result).toContain('∥2/4');
  });

  it('omits batch badge when no batch info', () => {
    const result = stripAnsi(
      subagentStatusBar({ label: 'explore', elapsedMs: 3000 }),
    );
    expect(result).not.toContain('∥');
  });

  it('formats sub-second elapsed as <1s', () => {
    const result = stripAnsi(
      subagentStatusBar({ label: 'test', elapsedMs: 500 }),
    );
    expect(result).toContain('<1s');
  });

  it('formats minutes correctly', () => {
    const result = stripAnsi(
      subagentStatusBar({ label: 'test', elapsedMs: 125000 }),
    );
    expect(result).toContain('2m 5s');
  });

  it('formats exact minutes without remainder', () => {
    const result = stripAnsi(
      subagentStatusBar({ label: 'test', elapsedMs: 120000 }),
    );
    expect(result).toContain('2m');
    expect(result).not.toContain('2m 0s');
  });
});

describe('subagentStatusStack', () => {
  it('returns empty string for no entries', () => {
    expect(subagentStatusStack([])).toBe('');
  });

  it('renders all entries when under maxLines', () => {
    const entries = [
      { label: 'agent-a', elapsedMs: 1000 },
      { label: 'agent-b', elapsedMs: 2000 },
    ];
    const result = stripAnsi(subagentStatusStack(entries));
    expect(result).toContain('agent-a');
    expect(result).toContain('agent-b');
    expect(result.split('\n')).toHaveLength(2);
  });

  it('caps at maxLines and shows overflow', () => {
    // 5 entries, maxLines=3: reserve 1 slot for overflow → show 2 entries +
    // 1 overflow line = 3 total lines (respects the cap).
    const entries = [
      { label: 'a', elapsedMs: 1000 },
      { label: 'b', elapsedMs: 2000 },
      { label: 'c', elapsedMs: 3000 },
      { label: 'd', elapsedMs: 4000 },
      { label: 'e', elapsedMs: 5000 },
    ];
    const result = stripAnsi(subagentStatusStack(entries, 3));
    expect(result).toContain('a');
    expect(result).toContain('b');
    // 'c', 'd', 'e' are in the overflow summary, not rendered individually
    expect(result).not.toContain(' c ');
    expect(result).not.toContain(' d ');
    expect(result).not.toContain(' e ');
    expect(result).toContain('+3 more running');
    // Total line count must not exceed maxLines (3)
    expect(result.split('\n')).toHaveLength(3);
  });

  it('respects custom maxLines', () => {
    // 3 entries, maxLines=1: reserve 1 slot for overflow → show 0 entries +
    // 1 overflow line = 1 total line (respects the cap).
    const entries = [
      { label: 'a', elapsedMs: 1000 },
      { label: 'b', elapsedMs: 2000 },
      { label: 'c', elapsedMs: 3000 },
    ];
    const result = stripAnsi(subagentStatusStack(entries, 1));
    expect(result).toContain('+3 more running');
    expect(result.split('\n')).toHaveLength(1);
  });
});
