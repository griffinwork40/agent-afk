/**
 * Unit tests for the shadow-verify nudge SubagentStop handler.
 *
 * Mirrors the conservative-heuristic behavior of the Python reference
 * (`agent-workflow-amplifiers-private/hooks/shadow_verify_nudge.py`): the
 * handler stays silent unless the child's output is long enough, has at
 * least two decision markers, the agent isn't already inside a verifying
 * orchestrator, and the output isn't a verifier response itself.
 */
import { describe, expect, it } from 'vitest';
import type { SubagentStopContext } from './hooks.js';
import { createShadowVerifyNudge, shadowVerifyNudge } from './shadow-verify-nudge.js';

function stopCtx(
  lastMessage: string | undefined,
  agentType?: string,
  subagentId = 'test-id',
): SubagentStopContext {
  return {
    event: 'SubagentStop',
    subagentId,
    status: 'succeeded',
    lastMessage,
    agentType,
  };
}

describe('shadowVerifyNudge', () => {
  it('returns {} for non-SubagentStop events', () => {
    const result = shadowVerifyNudge({ event: 'SessionStart' });
    expect(result).toEqual({});
  });

  it('returns {} when lastMessage is undefined', () => {
    expect(shadowVerifyNudge(stopCtx(undefined))).toEqual({});
  });

  it('returns {} when output is shorter than MIN_OUTPUT_CHARS', () => {
    const shortButMarkerHeavy =
      'The verdict: should delete. I found 3 critical severity bugs.';
    expect(shadowVerifyNudge(stopCtx(shortButMarkerHeavy))).toEqual({});
  });

  it('returns {} when output is long but has no decision markers', () => {
    const bland = 'The sky is blue. '.repeat(80);
    expect(shadowVerifyNudge(stopCtx(bland))).toEqual({});
  });

  it('returns {} when output has only one decision marker', () => {
    const oneMarker = `The verdict is straightforward. ${'lorem ipsum dolor sit amet. '.repeat(30)}`;
    expect(shadowVerifyNudge(stopCtx(oneMarker))).toEqual({});
  });

  it.each([
    ['shadow-verify'],
    ['diagnose'],
    ['mint'],
    ['resolve'],
    ['appmap'],
    ['research-diagnose'],
    // `review` is read-only + self-verifies critical/high internally; the
    // skill dispatch labels its fork `skill-<name>`, so the substring match
    // must catch both the bare name and the skill-prefixed form.
    ['review'],
    ['skill-review'],
  ])('returns {} when agentType matches verified orchestrator %s', (agentType) => {
    const decisionHeavy =
      'Verdict: the auth module is broken. Recommend removing several unused helpers. ' +
      'I found 4 critical severity bugs. ' +
      'lorem ipsum '.repeat(70);
    expect(shadowVerifyNudge(stopCtx(decisionHeavy, agentType))).toEqual({});
  });

  it.each([
    ['preview'],
    ['reviewer'],
    ['code-previewer'],
    ['resolver'],
    ['minty-fresh'],
  ])(
    'still nudges for look-alike agentType %s (hyphen-boundary match, not substring)',
    (agentType) => {
      // Regression guard: the orchestrator match must be hyphen-bounded, not a
      // bare `includes`. `preview`/`reviewer`/`resolver`/`minty-fresh` contain
      // `review`/`resolve`/`mint` as substrings but are NOT verified
      // orchestrators, so the nudge must still fire.
      const decisionHeavy =
        'Verdict: the auth module is broken. Recommend removing several unused helpers. ' +
        'I found 4 critical severity bugs. ' +
        'lorem ipsum '.repeat(70);
      expect(shadowVerifyNudge(stopCtx(decisionHeavy, agentType)).injectContext).toBeDefined();
    },
  );

  it('returns {} when output looks like a verifier response', () => {
    const verifierOutput =
      'verifier_verdict: CONFIRMS. I independently re-derived the claim and the verifier agrees. ' +
      'Recommend removing the broken helper. I found 3 critical severity bugs. ' +
      'lorem ipsum '.repeat(60);
    expect(shadowVerifyNudge(stopCtx(verifierOutput))).toEqual({});
  });

  it('returns injectContext when output is decision-driving and long enough', () => {
    const output =
      'After careful review, verdict: the auth module has several broken paths. ' +
      'Recommend removing the duplicated helpers. ' +
      'I found 4 critical severity bugs in the validator. ' +
      'The unused imports should delete. ' +
      'lorem ipsum '.repeat(60);
    const result = shadowVerifyNudge(stopCtx(output));
    expect(result.injectContext).toBeDefined();
    expect(result.injectContext).toMatch(/^\[framework-generated context: shadow-verify nudge\]/);
    expect(result.injectContext).toContain('/shadow-verify');
  });

  it('treats unknown agentType as unverified (nudge fires if heuristics match)', () => {
    const output =
      'After review, verdict: broken module. Recommend removing the helpers. ' +
      'Found 3 critical severity bugs. I fixed the issue. ' +
      'lorem ipsum '.repeat(60);
    const result = shadowVerifyNudge(stopCtx(output, 'research'));
    expect(result.injectContext).toBeDefined();
  });

  // --- #355 regression guards: self-trigger on verifier output ---

  it('returns {} for verdict-table verifier output (CONFIRMED/REFUTED rows)', () => {
    const verdictTable =
      'Verification wave complete. Verdict table:\n\n' +
      '| Claim | Result | Evidence |\n' +
      '|-------|--------|----------|\n' +
      '| The sweep never deletes branches | CONFIRMED | worktree-sweep.ts:607 |\n' +
      '| The failure is swallowed silently | CONFIRMED | .catch(() => {}) at :618 |\n' +
      '| 210 branches are orphaned fallout | REFUTED | some predate the sweep |\n\n' +
      'Recommend acting only on the confirmed claims. ' +
      'lorem ipsum '.repeat(40);
    expect(shadowVerifyNudge(stopCtx(verdictTable, 'sv-claim1'))).toEqual({});
  });

  it('returns {} for a | Claim | table header even without repeated verdict tokens', () => {
    const table =
      'Findings below.\n| Claim | Status |\n|---|---|\n| module is broken | holds |\n' +
      'Recommend removing the unused helpers; found 3 critical severity bugs. ' +
      'lorem ipsum '.repeat(50);
    expect(shadowVerifyNudge(stopCtx(table))).toEqual({});
  });

  it.each([['verify-claim1'], ['sv-verifier'], ['skill-fork-verify']])(
    'suppresses when id prefix carries a verify token (%s)',
    (agentType) => {
      const decisionHeavy =
        'Verdict: the auth module is broken. Recommend removing several unused helpers. ' +
        'I found 4 critical severity bugs. ' +
        'lorem ipsum '.repeat(70);
      expect(shadowVerifyNudge(stopCtx(decisionHeavy, agentType))).toEqual({});
    },
  );

  it('still nudges for look-alike prefix verification-x (hyphen-boundary match)', () => {
    const decisionHeavy =
      'Verdict: the auth module is broken. Recommend removing several unused helpers. ' +
      'I found 4 critical severity bugs. ' +
      'lorem ipsum '.repeat(70);
    expect(shadowVerifyNudge(stopCtx(decisionHeavy, 'verification-x')).injectContext).toBeDefined();
  });

  describe('createShadowVerifyNudge dedup latch', () => {
    const decisionHeavy =
      'Verdict: the auth module is broken. Recommend removing several unused helpers. ' +
      'I found 4 critical severity bugs. ' +
      'lorem ipsum '.repeat(70);

    it('injects at most once per turn across a parallel wave', () => {
      const nudge = createShadowVerifyNudge();
      expect(nudge(stopCtx(decisionHeavy, 'research', 'child-1')).injectContext).toBeDefined();
      expect(nudge(stopCtx(decisionHeavy, 'research', 'child-2'))).toEqual({});
      expect(nudge(stopCtx(decisionHeavy, 'research', 'child-3'))).toEqual({});
    });

    it('re-arms after a Stop (next turn) but never re-fires for the same child', () => {
      const nudge = createShadowVerifyNudge();
      expect(nudge(stopCtx(decisionHeavy, 'research', 'child-1')).injectContext).toBeDefined();
      nudge({ event: 'Stop' });
      // Same child again (duplicate SubagentStop delivery) — stays silent.
      expect(nudge(stopCtx(decisionHeavy, 'research', 'child-1'))).toEqual({});
      // A genuinely new child on the new turn nudges again.
      expect(nudge(stopCtx(decisionHeavy, 'research', 'child-2')).injectContext).toBeDefined();
    });

    it('a suppressed (verifier-looking) child does not consume the turn latch', () => {
      const nudge = createShadowVerifyNudge();
      const verdictTable =
        '| Claim | Result |\n|---|---|\n| x | CONFIRMED |\n| y | REFUTED |\n' +
        'Recommend acting only on confirmed claims. ' +
        'lorem ipsum '.repeat(50);
      expect(nudge(stopCtx(verdictTable, 'sv-1', 'verifier-child'))).toEqual({});
      expect(nudge(stopCtx(decisionHeavy, 'research', 'real-child')).injectContext).toBeDefined();
    });
  });
});
