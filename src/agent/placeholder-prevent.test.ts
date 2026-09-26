/**
 * Tests for the SessionStart placeholder-prevention hook (Layer 1).
 *
 * Covers:
 *   - Top-level sessions receive the prevention instruction via injectContext
 *   - Subagent forks (parentSessionId set) are skipped
 *   - Non-SessionStart events are ignored
 *   - Never blocks (continue/decision never set)
 *   - Instruction text contains key guidance elements
 */

import { describe, it, expect } from 'vitest';
import { createPlaceholderPreventHook } from './placeholder-prevent.js';
import type { SessionStartContext } from './hooks.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeSessionStartCtx = (
  overrides?: Partial<SessionStartContext>,
): SessionStartContext => ({
  event: 'SessionStart',
  sessionId: 'sess-test-1',
  ...overrides,
});

// ─── Core behaviour ───────────────────────────────────────────────────────────

describe('createPlaceholderPreventHook', () => {
  it('injects prevention instruction for a top-level session', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook(makeSessionStartCtx());
    expect(result.injectContext).toBeDefined();
    expect(typeof result.injectContext).toBe('string');
    expect((result.injectContext as string).length).toBeGreaterThan(0);
  });

  it('instruction carries the [placeholder-prevent] tag', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook(makeSessionStartCtx());
    expect(result.injectContext).toContain('[placeholder-prevent]');
  });

  it('instruction mentions resolving placeholders before presenting commands', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook(makeSessionStartCtx());
    expect(result.injectContext).toMatch(/resolve|resolving/i);
  });

  it('instruction mentions wrapping unresolvable values in a callout', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook(makeSessionStartCtx());
    expect(result.injectContext).toMatch(/callout|prominent|⚠/i);
  });

  it('instruction names concrete placeholder examples', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook(makeSessionStartCtx());
    // The instruction should name recognisable placeholder patterns so the
    // model understands what "placeholder" means in this context.
    expect(result.injectContext).toMatch(/your-user|YOUR_API_KEY|REPLACE_ME/);
  });

  // ─── Subagent skip ─────────────────────────────────────────────────────────

  it('skips subagent forks (parentSessionId set) — returns empty decision', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook(makeSessionStartCtx({ parentSessionId: 'parent-sess-1' }));
    expect(result.injectContext).toBeUndefined();
  });

  it('skips even when parentSessionId is an empty string (falsy)', () => {
    // An empty string is falsy, so a parentSessionId of '' should NOT skip.
    // This test documents the current behaviour: only a non-empty string skips.
    const hook = createPlaceholderPreventHook();
    const result = hook(makeSessionStartCtx({ parentSessionId: '' }));
    // '' is falsy, so the hook fires normally.
    expect(result.injectContext).toBeDefined();
  });

  // ─── Non-SessionStart events ───────────────────────────────────────────────

  it('ignores Stop events', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook({ event: 'Stop', sessionId: 'sess-1' });
    expect(result.injectContext).toBeUndefined();
  });

  it('ignores SessionEnd events', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook({ event: 'SessionEnd', sessionId: 'sess-1' });
    expect(result.injectContext).toBeUndefined();
  });

  it('ignores PreToolUse events', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook({ event: 'PreToolUse', toolName: 'bash' });
    expect(result.injectContext).toBeUndefined();
  });

  // ─── Non-blocking contract ─────────────────────────────────────────────────

  it('never blocks — decision field is undefined', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook(makeSessionStartCtx());
    expect(result.decision).toBeUndefined();
  });

  it('never sets continue:false', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook(makeSessionStartCtx());
    expect(result.continue).toBeUndefined();
  });

  it('fires independently on each SessionStart (stateless)', () => {
    // Each call to createPlaceholderPreventHook returns a fresh handler.
    // Two separate sessions each get the same instruction.
    const hook = createPlaceholderPreventHook();
    const r1 = hook(makeSessionStartCtx({ sessionId: 'sess-a' }));
    const r2 = hook(makeSessionStartCtx({ sessionId: 'sess-b' }));
    expect(r1.injectContext).toBe(r2.injectContext);
  });

  it('is safe to call without a sessionId', () => {
    const hook = createPlaceholderPreventHook();
    const result = hook({ event: 'SessionStart' });
    expect(result.injectContext).toBeDefined();
  });
});
