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
    expect(result).toContain('c');
    // 'd' and 'e' are in the overflow summary, not rendered individually
    expect(result).not.toContain(' d ');
    expect(result).not.toContain(' e ');
    expect(result).toContain('+2 more running');
  });

  it('respects custom maxLines', () => {
    const entries = [
      { label: 'a', elapsedMs: 1000 },
      { label: 'b', elapsedMs: 2000 },
      { label: 'c', elapsedMs: 3000 },
    ];
    const result = stripAnsi(subagentStatusStack(entries, 1));
    expect(result).toContain('a');
    expect(result).toContain('+2 more running');
  });
});
