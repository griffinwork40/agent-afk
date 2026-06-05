/**
 * Tests for --max-budget-usd / --task-budget parsing + env-var fallbacks.
 *
 * Mirrors the structure of cli-thinking-options.test.ts so reviewers can
 * cross-check the parser contract at a glance.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { parseBudget, getMaxBudgetUsd, getTaskBudget } from './shared-helpers.js';

describe('parseBudget', () => {
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
  });

  it('returns undefined when AFK_MAX_BUDGET_USD is not set', () => {
    expect(getMaxBudgetUsd()).toBeUndefined();
  });

  it('reads AFK_MAX_BUDGET_USD when set', () => {
    process.env['AFK_MAX_BUDGET_USD'] = '10';
    expect(getMaxBudgetUsd()).toBe(10);
  });

  it('returns undefined when AFK_TASK_BUDGET is not set', () => {
    expect(getTaskBudget()).toBeUndefined();
  });

  it('reads AFK_TASK_BUDGET when set', () => {
    process.env['AFK_TASK_BUDGET'] = '0.5';
    expect(getTaskBudget()).toBeCloseTo(0.5);
  });

  it('propagates parser errors for malformed env values', () => {
    process.env['AFK_MAX_BUDGET_USD'] = 'unlimited';
    expect(() => getMaxBudgetUsd()).toThrow(/Invalid --max-budget-usd value/);
  });
});
