/**
 * Fix #2471: assembleChildConfig reads parentApiKey via a getter at fork time
 * so a mid-session credential hot-swap is visible to every child forked after
 * it, rather than using a boot-time snapshot.
 *
 * Run with: pnpm test src/agent/subagent/fork-child-config.credential-swap.test.ts
 */

import { describe, expect, it, vi } from 'vitest';
import type { AssembleChildConfigArgs } from './fork-child-config.js';

vi.mock('../providers/shared/soft-deadline.js', () => ({
  resolveSoftDeadlineMs: vi.fn().mockReturnValue(0),
}));

import { assembleChildConfig } from './fork-child-config.js';

const ANTHROPIC_CHILD = 'claude-sonnet-5';

function makeArgs(
  overrides: Partial<AssembleChildConfigArgs<unknown>> = {},
): AssembleChildConfigArgs<unknown> {
  return {
    options: {
      parent: { sessionId: 'parent-sess' },
      config: {},
      agentType: 'general-purpose',
    },
    id: 'child-1',
    resume: undefined,
    registry: undefined,
    effectiveChildModel: ANTHROPIC_CHILD,
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

describe('assembleChildConfig — parentApiKey getter (fix #2471)', () => {
  it('resolves a static-string getter at fork time', () => {
    const bootToken = 'sk-ant-oat01-boot';
    const args = makeArgs({ parentApiKey: () => bootToken });
    const config = assembleChildConfig(args);
    // The forked child's apiKey must match the getter's return value.
    expect(config.apiKey).toBe(bootToken);
  });

  it('reflects a hot-swapped token: getter returns new account after credential swap', () => {
    let liveToken = 'sk-ant-oat01-account-A';
    // A getter that always reads `liveToken` — simulates what a closure over
    // the live credential store (or loadAnthropicCredential()) does.
    const getter = (): string => liveToken;

    // Fork #1 before account switch — child gets boot token.
    const args1 = makeArgs({ parentApiKey: getter });
    expect(assembleChildConfig(args1).apiKey).toBe('sk-ant-oat01-account-A');

    // Operator switches accounts (turn-start credential catch-up swaps the client).
    liveToken = 'sk-ant-oat01-account-B';

    // Fork #2 after account switch — child must get the NEW token, not the boot one.
    const args2 = makeArgs({ parentApiKey: getter });
    expect(assembleChildConfig(args2).apiKey).toBe('sk-ant-oat01-account-B');
  });

  it('handles an absent parentApiKey (undefined getter)', () => {
    const args = makeArgs({ parentApiKey: undefined });
    const config = assembleChildConfig(args);
    // No parent credential: child's apiKey resolves via its own per-model
    // resolution (which in this test setup is also empty → undefined).
    expect(config.apiKey).toBeUndefined();
  });
});
