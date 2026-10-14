/**
 * Unit tests for {@link createUnprovenDiagnosisDetectHook}.
 *
 * Coverage targets:
 *   - Hook fires on cause-unknown text with no instrumentation tool calls.
 *   - Hook does NOT fire when instrumentation tool calls are present.
 *   - Hook does NOT fire when AFK_UNPROVEN_DIAGNOSIS_GATE is off (default).
 *   - Hook fires only once (does not fire on the continuation round).
 *   - Pure detection helpers: hasCauseUnknownPhrase, hasInstrumentationEvidence.
 *
 * @module agent/unproven-diagnosis-detect.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createUnprovenDiagnosisDetectHook,
  hasCauseUnknownPhrase,
  hasInstrumentationEvidence,
  INSTRUMENTATION_TOOL_NAMES,
} from './unproven-diagnosis-detect.js';
import type { HookDecision, StopContext } from './hooks.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStopCtx(overrides: Partial<StopContext> = {}): StopContext {
  return {
    event: 'Stop',
    sessionId: 'test-session',
    continuation: 0,
    ...overrides,
  };
}

const CAUSE_UNKNOWN_TEXT =
  'I investigated the speculative-decoding slowdown. The root cause is unknown ' +
  '— I could not determine it from the available sources. The issue is ' +
  'something else in mlx-vlm\'s handling of this model. This is likely upstream.';

const CLEAN_TEXT =
  'I fixed the off-by-one in src/scheduler.ts. All tests pass. Done.';

// ─── hasCauseUnknownPhrase ────────────────────────────────────────────────────

describe('hasCauseUnknownPhrase', () => {
  it('matches "root cause is unknown"', () => {
    expect(hasCauseUnknownPhrase('the root cause is unknown')).toBe(true);
  });

  it('matches "root cause remains unknown"', () => {
    expect(hasCauseUnknownPhrase('root cause remains unknown.')).toBe(true);
  });

  it('matches "root cause not found" phrase with noise between', () => {
    expect(hasCauseUnknownPhrase('the root cause was not found in this session')).toBe(true);
  });

  it('matches "root cause" near "couldn\'t determine"', () => {
    expect(hasCauseUnknownPhrase("I couldn't determine the root cause of this failure.")).toBe(true);
  });

  it('matches "the cause is something else in ..."', () => {
    expect(hasCauseUnknownPhrase("The cause is something else in the library.")).toBe(true);
  });

  it('matches "something else in <external>"', () => {
    expect(hasCauseUnknownPhrase("something else in mlx-vlm is responsible.")).toBe(true);
  });

  it('matches "likely upstream"', () => {
    expect(hasCauseUnknownPhrase("This is likely upstream behavior.")).toBe(true);
  });

  it('matches "probably upstream"', () => {
    expect(hasCauseUnknownPhrase("probably upstream, not our code.")).toBe(true);
  });

  it('matches "I didn\'t find the root cause"', () => {
    expect(hasCauseUnknownPhrase("I didn't find the root cause.")).toBe(true);
  });

  it('matches "could not identify the cause"', () => {
    expect(hasCauseUnknownPhrase("I could not identify the root cause.")).toBe(true);
  });

  it('does not match clean text with no cause-unknown phrases', () => {
    expect(hasCauseUnknownPhrase(CLEAN_TEXT)).toBe(false);
  });

  it('does not match "root" or "cause" in unrelated context', () => {
    expect(hasCauseUnknownPhrase('The root directory contains the cause of the config file.')).toBe(false);
  });

  it('does not match empty string', () => {
    expect(hasCauseUnknownPhrase('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hasCauseUnknownPhrase('ROOT CAUSE IS UNKNOWN')).toBe(true);
    expect(hasCauseUnknownPhrase('LIKELY UPSTREAM')).toBe(true);
  });
});

// ─── hasInstrumentationEvidence ───────────────────────────────────────────────

describe('hasInstrumentationEvidence', () => {
  it('returns true when "bash" is in the list', () => {
    expect(hasInstrumentationEvidence(['read_file', 'bash'])).toBe(true);
  });

  it('returns true when "grep" is in the list', () => {
    expect(hasInstrumentationEvidence(['grep'])).toBe(true);
  });

  it('returns true for every known instrumentation tool', () => {
    for (const name of INSTRUMENTATION_TOOL_NAMES) {
      expect(hasInstrumentationEvidence([name])).toBe(true);
    }
  });

  it('returns false for non-instrumentation tools only', () => {
    expect(hasInstrumentationEvidence(['edit_file', 'write_file', 'agent'])).toBe(false);
  });

  it('returns false for empty list', () => {
    expect(hasInstrumentationEvidence([])).toBe(false);
  });
});

// ─── createUnprovenDiagnosisDetectHook ───────────────────────────────────────

describe('createUnprovenDiagnosisDetectHook', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['AFK_UNPROVEN_DIAGNOSIS_GATE'];
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env['AFK_UNPROVEN_DIAGNOSIS_GATE'];
    } else {
      process.env['AFK_UNPROVEN_DIAGNOSIS_GATE'] = savedEnv;
    }
  });

  // ── Flag off (default) ──────────────────────────────────────────────────

  it('does not fire when the flag is off (default)', () => {
    delete process.env['AFK_UNPROVEN_DIAGNOSIS_GATE'];
    const hook = createUnprovenDiagnosisDetectHook();
    const ctx = makeStopCtx({ assistantText: CAUSE_UNKNOWN_TEXT, successfulToolNames: [] });
    const result = hook(ctx);
    expect(result).toEqual({});
  });

  it('does not fire when the flag is 0', () => {
    process.env['AFK_UNPROVEN_DIAGNOSIS_GATE'] = '0';
    const hook = createUnprovenDiagnosisDetectHook();
    const ctx = makeStopCtx({ assistantText: CAUSE_UNKNOWN_TEXT, successfulToolNames: [] });
    const result = hook(ctx);
    expect(result).toEqual({});
  });

  // ── Flag on ───────────────────────────────────────────────────────────────

  it('fires with injectContext when cause-unknown text and no instrumentation', () => {
    const hook = createUnprovenDiagnosisDetectHook({ isEnabled: () => true });
    const ctx = makeStopCtx({ assistantText: CAUSE_UNKNOWN_TEXT, successfulToolNames: [] });
    const result = hook(ctx) as HookDecision;
    expect(result).toHaveProperty('injectContext');
    expect(typeof result.injectContext).toBe('string');
    expect(result.injectContext).toMatch(/elimination ladder/i);
  });

  it('does not fire when instrumentation tool calls are present (bash)', () => {
    const hook = createUnprovenDiagnosisDetectHook({ isEnabled: () => true });
    const ctx = makeStopCtx({
      assistantText: CAUSE_UNKNOWN_TEXT,
      successfulToolNames: ['read_file', 'bash'],
    });
    const result = hook(ctx);
    expect(result).toEqual({});
  });

  it('does not fire when instrumentation tool calls are present (grep only)', () => {
    const hook = createUnprovenDiagnosisDetectHook({ isEnabled: () => true });
    const ctx = makeStopCtx({
      assistantText: CAUSE_UNKNOWN_TEXT,
      successfulToolNames: ['grep'],
    });
    const result = hook(ctx);
    expect(result).toEqual({});
  });

  it('does not fire when clean text (no cause-unknown phrases)', () => {
    const hook = createUnprovenDiagnosisDetectHook({ isEnabled: () => true });
    const ctx = makeStopCtx({ assistantText: CLEAN_TEXT, successfulToolNames: [] });
    const result = hook(ctx);
    expect(result).toEqual({});
  });

  it('does not fire when the event is not Stop', () => {
    const hook = createUnprovenDiagnosisDetectHook({ isEnabled: () => true });
    const ctx = { event: 'SessionEnd' as const, sessionId: 'test' };
    const result = hook(ctx);
    expect(result).toEqual({});
  });

  // ── Fires only once (continuation guard) ──────────────────────────────────

  it('does not fire on the continuation round (stopHookActive=true)', () => {
    const hook = createUnprovenDiagnosisDetectHook({ isEnabled: () => true });
    const ctx = makeStopCtx({
      assistantText: CAUSE_UNKNOWN_TEXT,
      successfulToolNames: [],
      stopHookActive: true,
      continuation: 1,
    });
    const result = hook(ctx);
    expect(result).toEqual({});
  });

  it('fires on the first dispatch (continuation=0, stopHookActive absent)', () => {
    const hook = createUnprovenDiagnosisDetectHook({ isEnabled: () => true });
    const ctx = makeStopCtx({
      assistantText: CAUSE_UNKNOWN_TEXT,
      successfulToolNames: [],
      continuation: 0,
    });
    const result = hook(ctx);
    expect(result).toHaveProperty('injectContext');
  });

  // ── Subagent guard ────────────────────────────────────────────────────────

  it('does not fire for subagent turns (parentSessionId set)', () => {
    const hook = createUnprovenDiagnosisDetectHook({ isEnabled: () => true });
    const ctx = makeStopCtx({
      assistantText: CAUSE_UNKNOWN_TEXT,
      successfulToolNames: [],
      parentSessionId: 'parent-123',
    });
    const result = hook(ctx);
    expect(result).toEqual({});
  });

  // ── Missing assistantText (graceful fallback) ─────────────────────────────

  it('returns {} when assistantText is absent (no false trigger)', () => {
    const hook = createUnprovenDiagnosisDetectHook({ isEnabled: () => true });
    // No assistantText → empty string → no phrase match → no injection.
    const ctx = makeStopCtx({ successfulToolNames: [] });
    const result = hook(ctx);
    expect(result).toEqual({});
  });

  // ── Issue reproduction: the 2026-10-05 case ───────────────────────────────

  it('reproduces the motivating case (speculative-decoding slowdown)', () => {
    const hook = createUnprovenDiagnosisDetectHook({ isEnabled: () => true });
    const motivatingText =
      'The speculative-decoding path is ~10x slower than expected. ' +
      'The cause is something else in mlx-vlm\'s handling of this model. ' +
      "I didn't find the root cause. Done.";
    const ctx = makeStopCtx({
      assistantText: motivatingText,
      successfulToolNames: [], // no instrumentation was run
      terminalState: 'done',
    });
    const result = hook(ctx) as HookDecision;
    expect(result).toHaveProperty('injectContext');
    expect(result.injectContext).toMatch(/byte-for-byte|hash-check/i);
  });

  it('does NOT fire on the motivating case when a call counter was inserted (bash)', () => {
    const hook = createUnprovenDiagnosisDetectHook({ isEnabled: () => true });
    const motivatingText =
      "The exact-verify path ran 0 of 22 times — this points to mlx-vlm#2430.";
    const ctx = makeStopCtx({
      assistantText: motivatingText,
      // 'bash' was used to add the counter
      successfulToolNames: ['read_file', 'edit_file', 'bash'],
    });
    const result = hook(ctx);
    // Text doesn't contain cause-unknown phrase either, so no fire regardless.
    expect(result).toEqual({});
  });
});
