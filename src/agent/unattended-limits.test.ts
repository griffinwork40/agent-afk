import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveUnattendedLimits } from './unattended-limits.js';

afterEach(() => vi.restoreAllMocks());

describe('unattended resource defaults', () => {
  it.each([undefined, '', '  '])('defaults unset or empty limits (%s)', (raw) => {
    expect(resolveUnattendedLimits(raw, raw)).toEqual({ maxBudgetUsd: 5, maxToolUseIterations: 100 });
  });

  it('preserves valid environment values', () => {
    expect(resolveUnattendedLimits('3.7', '2.5')).toEqual({ maxBudgetUsd: 2.5, maxToolUseIterations: 3 });
  });

  it.each(['0', '-1'])('preserves the numeric unlimited-round escape hatch (%s)', (raw) => {
    expect(resolveUnattendedLimits(raw, '0')).toEqual({ maxBudgetUsd: 0, maxToolUseIterations: 0 });
  });

  it('does not turn a positive fractional limit into unlimited', () => {
    expect(resolveUnattendedLimits('0.5', undefined).maxToolUseIterations).toBe(1);
  });

  it('explicit config wins over environment, including zero', () => {
    expect(resolveUnattendedLimits('50', '3', { maxBudgetUsd: 0, maxToolUseIterations: 0 }))
      .toEqual({ maxBudgetUsd: 0, maxToolUseIterations: 0 });
    expect(resolveUnattendedLimits('50', '3', { maxBudgetUsd: 8, maxToolUseIterations: 25 }))
      .toEqual({ maxBudgetUsd: 8, maxToolUseIterations: 25 });
  });

  it.each(['Infinity', 'NaN', 'sk-proj-misplaced-value'])('invalid environment falls back without leaking raw input (%s)', (raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveUnattendedLimits(raw, raw)).toEqual({ maxBudgetUsd: 5, maxToolUseIterations: 100 });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join(' ')).not.toContain(raw);
  });
});
