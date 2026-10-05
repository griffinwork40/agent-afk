/**
 * Unmocked composition test for `assembleChildConfig`.
 *
 * Unlike `fork-helpers.test.ts`, this file does NOT mock the identity or
 * budget preamble injectors. It exercises the real composition so the
 * ordering invariant — `# Subagent context` (identity) comes before
 * `# Tool budget` (budget) — is caught by an actual string-match rather
 * than by an invocation-order spy. See issue #2266 finding (low).
 *
 * Infrastructure that would touch the network or filesystem at import time
 * (providers, credential helpers, nesting) is still mocked.
 */

import { describe, it, expect, vi } from 'vitest';

// ── mocks (must precede imports under test) ───────────────────────────────────

vi.mock('../providers/index.js', () => ({
  providerForModel: vi.fn().mockReturnValue('anthropic'),
}));

vi.mock('../tools/nesting.js', () => ({
  buildPhaseRestrictedProvider: vi.fn().mockReturnValue({ __stub: 'read-only-provider' }),
  resolveMaxNestingDepth: vi.fn().mockReturnValue(6),
}));

vi.mock('../tools/child-credential.js', () => ({
  applyManagerApiKeyFallback: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../providers/shared/soft-deadline.js', () => ({
  resolveSoftDeadlineMs: vi.fn().mockReturnValue(0),
}));

// ── subject imports ───────────────────────────────────────────────────────────

import { assembleChildConfig, type AssembleChildConfigArgs } from './fork-child-config.js';

/** Minimal valid args for assembleChildConfig. Override per test. */
function makeArgs(
  overrides: Partial<AssembleChildConfigArgs<unknown>> = {},
): AssembleChildConfigArgs<unknown> {
  return {
    options: {
      parent: { sessionId: 'parent-sess' },
      config: {},
      agentType: 'test-agent',
    },
    id: 'child-id',
    resume: undefined,
    registry: undefined,
    effectiveChildModel: 'claude-sonnet-5',
    effectiveTimeoutMs: 30_000,
    inheritedReadRoots: undefined,
    composedWriteRoots: undefined,
    childController: new AbortController(),
    parentCwd: undefined,
    parentApiKey: undefined,
    parentBaseUrl: undefined,
    parentProvider: undefined,
    parentTraceWriter: undefined,
    parentSurface: undefined,
    parentCanUseTool: undefined,
    ...overrides,
  };
}

describe('assembleChildConfig — real preamble composition (unmocked injectors)', () => {
  it('emits # Subagent context before # Tool budget in the assembled system prompt (issue #2266)', () => {
    const cfg = assembleChildConfig(makeArgs({
      options: {
        parent: { sessionId: 'p' },
        config: { maxToolUseIterations: 50, depth: 2, maxDepth: 6 },
        agentType: 't',
      },
    }));

    const sp = cfg.systemPrompt as string;
    expect(sp).toContain('# Subagent context');
    expect(sp).toContain('# Tool budget');
    const identityIdx = sp.indexOf('# Subagent context');
    const budgetIdx = sp.indexOf('# Tool budget');
    expect(identityIdx).toBeLessThan(budgetIdx);
  });

  it('at-cap: emits the depth-refusal line when depth equals maxDepth', () => {
    const cfg = assembleChildConfig(makeArgs({
      options: {
        parent: { sessionId: 'p' },
        config: { maxToolUseIterations: 50, depth: 6, maxDepth: 6 },
        agentType: 't',
      },
    }));

    const sp = cfg.systemPrompt as string;
    expect(sp).toContain('You are at the maximum nesting depth (6/6)');
    expect(sp).not.toContain('Guidance about coordinating parallel subagents');
  });
});
