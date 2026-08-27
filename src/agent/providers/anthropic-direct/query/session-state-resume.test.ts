/**
 * Tests for #1294: context-overflow guard seeded from restored session usage.
 *
 * `createSessionState({ initialUsageInputTokens })` — when a session is
 * resumed with a non-zero token estimate, `lastUsage` must be seeded so the
 * overflow guard fires correctly on the first turn instead of being skipped.
 *
 * Coverage:
 *   1. Fresh session (no initialUsageInputTokens) → lastUsage starts null.
 *   2. Resumed session with token count → lastUsage seeded with inputTokens.
 *   3. Zero token count is treated as absent (null, same as fresh session).
 *   4. seeded lastUsage triggers the overflow guard when the context is full.
 *   5. Seeded lastUsage does NOT trigger the guard when there is headroom.
 *   6. A turn completing normally overwrites the seeded value.
 */

import { describe, it, expect } from 'vitest';
import { createSessionState } from './session-state.js';
import { guardContextOverflow, contextWindowTokensUsed } from '../../../providers/shared/auto-compact.js';

// Minimal stub that satisfies the ToolDispatcher interface without importing
// the real implementation — avoids pulling the full provider graph into a unit test.
const STUB_DISPATCHER = {} as unknown as import('../tool-dispatcher.js').ToolDispatcher;

function makeMinimalOpts() {
  return {
    model: 'claude-test',
    permissionMode: 'default',
    userSystem: null,
    toolDispatcher: STUB_DISPATCHER,
  } as const;
}

// ─── lastUsage initialization ─────────────────────────────────────────────────

describe('createSessionState — lastUsage initialization (#1294)', () => {
  it('starts as null for a fresh session (no initialUsageInputTokens)', () => {
    const state = createSessionState(makeMinimalOpts());
    expect(state.lastUsage).toBeNull();
  });

  it('starts as null when initialUsageInputTokens is 0', () => {
    const state = createSessionState({ ...makeMinimalOpts(), initialUsageInputTokens: 0 });
    expect(state.lastUsage).toBeNull();
  });

  it('seeds lastUsage.inputTokens when initialUsageInputTokens is non-zero', () => {
    const state = createSessionState({ ...makeMinimalOpts(), initialUsageInputTokens: 50_000 });
    expect(state.lastUsage).not.toBeNull();
    expect(state.lastUsage?.inputTokens).toBe(50_000);
  });

  it('seeded lastUsage carries the expected shape (stopReason null, not an error)', () => {
    const state = createSessionState({ ...makeMinimalOpts(), initialUsageInputTokens: 100_000 });
    expect(state.lastUsage?.stopReason).toBeNull();
    expect(state.lastUsage?.isError).toBe(false);
    expect(state.lastUsage?.resultSubtype).toBe('success');
  });

  it('does not seed lastUsage when initialUsageInputTokens is absent', () => {
    const state = createSessionState({ ...makeMinimalOpts() });
    expect(state.lastUsage).toBeNull();
  });
});

// ─── overflow guard interaction ───────────────────────────────────────────────

describe('seeded lastUsage + guardContextOverflow (#1294)', () => {
  it('throws when seeded inputTokens + maxOutput > contextLimit (guard fires on resume)', () => {
    // Simulate: haiku 200k window, 64k output ceiling.
    // Restored session had 137k input tokens → 137k + 64k = 201k > 200k → must throw.
    const state = createSessionState({ ...makeMinimalOpts(), initialUsageInputTokens: 137_000 });
    const usedTokens = contextWindowTokensUsed(state.lastUsage ?? {});
    expect(() =>
      guardContextOverflow(usedTokens, 64_000, 200_000, 'claude-haiku'),
    ).toThrow(/Context-window overflow/);
  });

  it('does NOT throw when seeded inputTokens + maxOutput <= contextLimit (headroom available)', () => {
    // 100k input + 64k output = 164k < 200k → safe.
    const state = createSessionState({ ...makeMinimalOpts(), initialUsageInputTokens: 100_000 });
    const usedTokens = contextWindowTokensUsed(state.lastUsage ?? {});
    expect(() =>
      guardContextOverflow(usedTokens, 64_000, 200_000, 'claude-haiku'),
    ).not.toThrow();
  });

  it('does NOT throw when lastUsage is null (fresh or legacy session without seeding)', () => {
    // No initialUsageInputTokens → lastUsage null → knownInputTokens = 0 → guard skips.
    const state = createSessionState(makeMinimalOpts());
    const usedTokens = contextWindowTokensUsed(state.lastUsage ?? {});
    // usedTokens will be 0 (no usage at all) → guard must not throw.
    expect(() =>
      guardContextOverflow(usedTokens, 64_000, 200_000, 'claude-haiku'),
    ).not.toThrow();
  });

  it('seeded value is overwritten once the first real turn completes', () => {
    // After a real turn the provider updates lastUsage with actual data;
    // the seeded value is no longer in play. This is a behaviour invariant —
    // the state field is mutable and callers replace it freely.
    const state = createSessionState({ ...makeMinimalOpts(), initialUsageInputTokens: 99_000 });
    expect(state.lastUsage?.inputTokens).toBe(99_000);

    // Simulate a completed turn writing real usage:
    state.lastUsage = { inputTokens: 50_000, outputTokens: 1_000, stopReason: 'end_turn', resultSubtype: 'success', isError: false };
    expect(state.lastUsage?.inputTokens).toBe(50_000);
  });
});
