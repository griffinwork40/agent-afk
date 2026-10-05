/**
 * Tests for --max-budget-usd / --task-budget parsing + env-var fallbacks.
 *
 * Mirrors the structure of cli-thinking-options.test.ts so reviewers can
 * cross-check the parser contract at a glance.
 *
 * Two parsers exist:
 *   - parseBudget     — for CLI flags: throws on any invalid input
 *   - parseBudgetEnv  — for env-var reads: warns + returns undefined on
 *                       empty/whitespace/malformed; never throws
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { parseBudget, parseBudgetEnv, getMaxBudgetUsd, getTaskBudget } from './shared-helpers.js';

describe('parseBudget (CLI flag parser — throws on invalid)', () => {
  it('parses integer budget', () => {
    expect(parseBudget('5')).toBe(5);
  });

  it('parses fractional budget', () => {
    expect(parseBudget('0.25')).toBeCloseTo(0.25);
  });

  it('accepts zero (hard-stop sentinel)', () => {
    expect(parseBudget('0')).toBe(0);
  });

  it('returns undefined when input is undefined', () => {
    expect(parseBudget(undefined)).toBeUndefined();
  });

  it('throws on non-numeric input', () => {
    expect(() => parseBudget('lots')).toThrow(/Invalid --max-budget-usd value/);
  });

  it('throws on empty string', () => {
    expect(() => parseBudget('')).toThrow(/Invalid --max-budget-usd value/);
  });

  it('throws on negative budget', () => {
    expect(() => parseBudget('-1')).toThrow(/non-negative/);
  });

  it('throws on NaN string like "NaN"', () => {
    expect(() => parseBudget('NaN')).toThrow(/Invalid --max-budget-usd value/);
  });
});

describe('parseBudgetEnv (env-var parser — warns, never throws)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when input is undefined', () => {
    expect(parseBudgetEnv(undefined, 'TEST_VAR')).toBeUndefined();
  });

  it('returns undefined for empty string (treated as unset, not $0 hard-stop)', () => {
    expect(parseBudgetEnv('', 'TEST_VAR')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string (treated as unset)', () => {
    expect(parseBudgetEnv('   ', 'TEST_VAR')).toBeUndefined();
  });

  it('returns undefined for whitespace-only string without warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseBudgetEnv('  ', 'TEST_VAR');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('parses a valid non-negative number', () => {
    expect(parseBudgetEnv('5', 'TEST_VAR')).toBe(5);
  });

  it('parses a fractional budget', () => {
    expect(parseBudgetEnv('0.25', 'TEST_VAR')).toBeCloseTo(0.25);
  });

  it('accepts zero (hard-stop sentinel)', () => {
    expect(parseBudgetEnv('0', 'TEST_VAR')).toBe(0);
  });

  it('warns and returns undefined for malformed input (does not throw)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseBudgetEnv('unlimited', 'AFK_MAX_BUDGET_USD');
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/AFK_MAX_BUDGET_USD/);
  });

  it('warns and returns undefined for NaN string', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseBudgetEnv('NaN', 'AFK_MAX_BUDGET_USD');
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns and returns undefined for negative value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = parseBudgetEnv('-5', 'AFK_MAX_BUDGET_USD');
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/negative/);
  });

  it('includes the var name in the warning message', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseBudgetEnv('bad', 'MY_CUSTOM_VAR');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('MY_CUSTOM_VAR');
  });
});

describe('getMaxBudgetUsd / getTaskBudget (env-var readers)', () => {
  let originalMax: string | undefined;
  let originalTask: string | undefined;

  beforeEach(() => {
    originalMax = process.env['AFK_MAX_BUDGET_USD'];
    originalTask = process.env['AFK_TASK_BUDGET'];
    delete process.env['AFK_MAX_BUDGET_USD'];
    delete process.env['AFK_TASK_BUDGET'];
  });

  afterEach(() => {
    if (originalMax !== undefined) process.env['AFK_MAX_BUDGET_USD'] = originalMax;
    else delete process.env['AFK_MAX_BUDGET_USD'];
    if (originalTask !== undefined) process.env['AFK_TASK_BUDGET'] = originalTask;
    else delete process.env['AFK_TASK_BUDGET'];
    vi.restoreAllMocks();
  });

  it('returns undefined when AFK_MAX_BUDGET_USD is not set', () => {
    expect(getMaxBudgetUsd()).toBeUndefined();
  });

  it('reads AFK_MAX_BUDGET_USD when set to a valid number', () => {
    process.env['AFK_MAX_BUDGET_USD'] = '10';
    expect(getMaxBudgetUsd()).toBe(10);
  });

  it('returns undefined when AFK_MAX_BUDGET_USD is empty (not a $0 hard-stop)', () => {
    process.env['AFK_MAX_BUDGET_USD'] = '';
    expect(getMaxBudgetUsd()).toBeUndefined();
  });

  it('returns undefined when AFK_MAX_BUDGET_USD is whitespace-only', () => {
    process.env['AFK_MAX_BUDGET_USD'] = '   ';
    expect(getMaxBudgetUsd()).toBeUndefined();
  });

  it('returns undefined and warns for malformed AFK_MAX_BUDGET_USD (does not throw)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env['AFK_MAX_BUDGET_USD'] = 'unlimited';
    const result = getMaxBudgetUsd();
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/AFK_MAX_BUDGET_USD/);
  });

  it('returns undefined when AFK_TASK_BUDGET is not set', () => {
    expect(getTaskBudget()).toBeUndefined();
  });

  it('reads AFK_TASK_BUDGET when set to a valid number', () => {
    process.env['AFK_TASK_BUDGET'] = '0.5';
    expect(getTaskBudget()).toBeCloseTo(0.5);
  });

  it('still propagates parser errors for malformed AFK_TASK_BUDGET', () => {
    process.env['AFK_TASK_BUDGET'] = 'lots';
    expect(() => getTaskBudget()).toThrow(/Invalid --max-budget-usd value/);
  });
});
