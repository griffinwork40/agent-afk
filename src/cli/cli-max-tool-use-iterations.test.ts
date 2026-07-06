/**
 * Tests for AFK_MAX_TOOL_USE_ITERATIONS parsing + env-var fallback and the
 * top-level `explicit ?? envDefault` precedence contract.
 *
 * Mirrors the structure of cli-budget-options.test.ts so reviewers can
 * cross-check the parser contract at a glance. The env var is the opt-in
 * mechanism for a TOP-LEVEL tool-use-round ceiling (PR #454 follow-up): unset
 * or <=0 means unlimited (0) = zero behavior change; a positive integer N caps
 * top-level turns at N rounds on BOTH providers via resolveMaxToolIterations().
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { parseMaxToolUseIterations, getMaxToolUseIterations } from './shared-helpers.js';
import { resolveMaxToolIterations } from '../agent/providers/shared/tool-loop-cap.js';

describe('parseMaxToolUseIterations', () => {
  it('returns undefined when input is undefined (unset → unlimited)', () => {
    expect(parseMaxToolUseIterations(undefined)).toBeUndefined();
  });

  it('parses a positive integer', () => {
    expect(parseMaxToolUseIterations('150')).toBe(150);
  });

  it('floors a positive fractional value to an integer', () => {
    expect(parseMaxToolUseIterations('4.9')).toBe(4);
  });

  it('treats 0 as unlimited (undefined)', () => {
    expect(parseMaxToolUseIterations('0')).toBeUndefined();
  });

  it('treats a negative value as unlimited (undefined)', () => {
    expect(parseMaxToolUseIterations('-5')).toBeUndefined();
  });

  it('treats empty string as unlimited (undefined)', () => {
    expect(parseMaxToolUseIterations('')).toBeUndefined();
  });

  it('treats non-numeric input as unlimited (undefined) — lenient, never throws', () => {
    expect(parseMaxToolUseIterations('unlimited')).toBeUndefined();
    expect(parseMaxToolUseIterations('NaN')).toBeUndefined();
    expect(parseMaxToolUseIterations('12abc')).toBeUndefined();
  });
});

describe('getMaxToolUseIterations (env-var reader)', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env['AFK_MAX_TOOL_USE_ITERATIONS'];
    delete process.env['AFK_MAX_TOOL_USE_ITERATIONS'];
  });

  afterEach(() => {
    if (original !== undefined) process.env['AFK_MAX_TOOL_USE_ITERATIONS'] = original;
    else delete process.env['AFK_MAX_TOOL_USE_ITERATIONS'];
  });

  // (a) env unset → top-level config resolves to unlimited (0).
  it('returns undefined when AFK_MAX_TOOL_USE_ITERATIONS is unset', () => {
    expect(getMaxToolUseIterations()).toBeUndefined();
    // A top-level config that leaves the field undefined resolves to 0 = no cap.
    expect(resolveMaxToolIterations(getMaxToolUseIterations())).toBe(0);
  });

  // (b) env=N>0 → top-level config defaults to N.
  it('reads a positive AFK_MAX_TOOL_USE_ITERATIONS and resolves to that cap', () => {
    process.env['AFK_MAX_TOOL_USE_ITERATIONS'] = '150';
    expect(getMaxToolUseIterations()).toBe(150);
    expect(resolveMaxToolIterations(getMaxToolUseIterations())).toBe(150);
  });

  it('treats AFK_MAX_TOOL_USE_ITERATIONS=0 as unlimited (undefined → resolves to 0)', () => {
    process.env['AFK_MAX_TOOL_USE_ITERATIONS'] = '0';
    expect(getMaxToolUseIterations()).toBeUndefined();
    expect(resolveMaxToolIterations(getMaxToolUseIterations())).toBe(0);
  });

  it('is lenient on malformed env values (unlimited, never throws)', () => {
    process.env['AFK_MAX_TOOL_USE_ITERATIONS'] = 'lots';
    expect(() => getMaxToolUseIterations()).not.toThrow();
    expect(getMaxToolUseIterations()).toBeUndefined();
  });

  // (c) explicit value beats the env default — the precedence expression used at
  // every top-level injection site is `explicit ?? getMaxToolUseIterations()`.
  it('explicit config value wins over the env default (explicit ?? envDefault)', () => {
    process.env['AFK_MAX_TOOL_USE_ITERATIONS'] = '150';
    const explicit = 7;
    // An explicit config value is preferred over the env fallback.
    expect(explicit ?? getMaxToolUseIterations()).toBe(7);
    // With no explicit value, the env default fills in.
    const noExplicit: number | undefined = undefined;
    expect(noExplicit ?? getMaxToolUseIterations()).toBe(150);
  });
});
