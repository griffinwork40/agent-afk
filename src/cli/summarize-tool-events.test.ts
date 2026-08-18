import { describe, expect, it } from 'vitest';
import { summarizeToolEvents } from './summarize-tool-events.js';
import type { ToolEvent } from './slash/types.js';

function makeEvent(overrides: Partial<ToolEvent> = {}): ToolEvent {
  return {
    toolName: 'bash',
    toolUseId: 'tu_1',
    input: 'echo hello',
    ...overrides,
  };
}

describe('summarizeToolEvents', () => {
  it('returns empty string for undefined events', () => {
    expect(summarizeToolEvents(undefined)).toBe('');
  });

  it('returns empty string for empty events array', () => {
    expect(summarizeToolEvents([])).toBe('');
  });

  it('formats a single successful tool call with name, input, and ✓', () => {
    const result = summarizeToolEvents([makeEvent({ toolName: 'read_file', input: '/path/to/file.ts' })]);
    expect(result).toBe('\n[Tools used: read_file(/path/to/file.ts)✓]');
  });

  it('formats a tool call with error flag → ✗', () => {
    const result = summarizeToolEvents([makeEvent({ toolName: 'bash', input: 'bad command', isError: true })]);
    expect(result).toBe('\n[Tools used: bash(bad command)✗]');
  });

  it('truncates long inputs at 80 chars with ellipsis', () => {
    const longInput = 'x'.repeat(100);
    const result = summarizeToolEvents([makeEvent({ input: longInput })]);
    // Should be 77 chars of input + '…'
    const expected = 'x'.repeat(77) + '…';
    expect(result).toBe(`\n[Tools used: bash(${expected})✓]`);
  });

  it('handles exactly 80-char input without truncation', () => {
    const input80 = 'a'.repeat(80);
    const result = summarizeToolEvents([makeEvent({ input: input80 })]);
    expect(result).toBe(`\n[Tools used: bash(${input80})✓]`);
  });

  it('handles missing input gracefully (empty string)', () => {
    const result = summarizeToolEvents([makeEvent({ input: '', inputRaw: undefined })]);
    expect(result).toBe('\n[Tools used: bash()✓]');
  });

  it('formats multiple tool calls with comma separation', () => {
    const events: ToolEvent[] = [
      makeEvent({ toolName: 'read_file', input: 'foo.ts', toolUseId: 'tu_1' }),
      makeEvent({ toolName: 'bash', input: 'ls', toolUseId: 'tu_2', isError: false }),
      makeEvent({ toolName: 'write_file', input: 'bar.ts', toolUseId: 'tu_3', isError: true }),
    ];
    const result = summarizeToolEvents(events);
    expect(result).toBe('\n[Tools used: read_file(foo.ts)✓, bash(ls)✓, write_file(bar.ts)✗]');
  });

  it('falls back to inputRaw when input is empty', () => {
    const result = summarizeToolEvents([
      makeEvent({ toolName: 'glob', input: '', inputRaw: '{"pattern":"**/*.ts"}' }),
    ]);
    expect(result).toBe('\n[Tools used: glob({"pattern":"**/*.ts"})✓]');
  });

  it('truncates inputRaw fallback at 80 chars', () => {
    const longRaw = '"' + 'r'.repeat(100) + '"';
    const result = summarizeToolEvents([makeEvent({ input: '', inputRaw: longRaw })]);
    // inputRaw is sliced to 80 before passing through the truncation
    const raw80 = longRaw.slice(0, 80);
    expect(result).toBe(`\n[Tools used: bash(${raw80})✓]`);
  });

  it('starts with \\n so it appends cleanly after assistant text', () => {
    const result = summarizeToolEvents([makeEvent()]);
    expect(result.startsWith('\n')).toBe(true);
  });

  it('prefers input over inputRaw when both are present', () => {
    const result = summarizeToolEvents([
      makeEvent({ input: 'display-input', inputRaw: '{"raw":"value"}' }),
    ]);
    expect(result).toContain('display-input');
    expect(result).not.toContain('raw');
  });
});
