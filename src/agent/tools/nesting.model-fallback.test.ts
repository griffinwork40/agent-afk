/**
 * Regression tests: createChildSkillExecutorFactory must thread the resolved
 * `defaultSubagentModel` policy into every nested SkillExecutor it builds.
 *
 * Bug (closed here): the factory received only `defaultModel`, leaving each
 * nested SkillExecutor's `defaultSubagentModel` undefined. That undefined then
 * flows into the child SubagentExecutor those skills construct
 * (skill-executor.ts buildForkedChildConfig, which passes
 * `defaultSubagentModel: this.ctx.defaultSubagentModel`). The `agent`-tool
 * default resolution there is `parsed.model ?? defaultSubagentModel ??
 * 'sonnet'` — with NO `defaultModel` link — so an unset `defaultSubagentModel`
 * routes straight to Anthropic `sonnet` even under an OpenAI-only parent,
 * surfacing as "subagent dispatch unavailable due missing Anthropic
 * credentials".
 *
 * These tests mock SkillExecutor to capture the exact ctx the factory builds,
 * proving the resolved policy is threaded at depth 1 AND recursively at
 * depth 2+ (skill→skill→skill), and that omitting it preserves back-compat.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every SkillExecutor construction. Hoisted so the (also-hoisted)
// vi.mock factory below can close over it (mirrors the appendRoutingDecision
// pattern in orchestration-telemetry.test.ts).
const constructed = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('./skill-executor.js', () => ({
  // Capturing constructor: records each ctx and returns a light stub. The
  // factory only stores the reference into the child ctx and reads nothing
  // back, so a stub suffices.
  SkillExecutor: vi.fn(function (this: unknown, ctx: Record<string, unknown>) {
    constructed.push(ctx);
    return { ctx } as unknown;
  }),
}));

import { createChildSkillExecutorFactory } from './nesting.js';
import type { ChildProviderFactoryArgs } from './nesting.js';
import type { ModelProvider } from '../provider.js';

// No-op provider factory — never invoked here (the factory only stores the
// reference into the child ctx).
const stubProviderFactory = (_args: ChildProviderFactoryArgs): ModelProvider =>
  ({}) as ModelProvider;

describe('createChildSkillExecutorFactory — defaultSubagentModel threading', () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  it('threads the resolved defaultSubagentModel into the depth-1 nested SkillExecutor', () => {
    const factory = createChildSkillExecutorFactory(
      'gpt-5.5', // 1 defaultModel (parent model)
      undefined, // 2 apiKey
      stubProviderFactory, // 3 childProviderFactory
      undefined, // 4 baseUrl
      undefined, // 5 traceWriter
      undefined, // 6 backgroundRegistry
      undefined, // 7 cwd
      undefined, // 8 resolveApiKeyForModel
      'cli', // 9 surface
      'sonnet', // 10 defaultSubagentModel (resolved policy)
    );
    factory(1, 3, new AbortController().signal);

    expect(constructed).toHaveLength(1);
    expect(constructed[0]!['defaultSubagentModel']).toBe('sonnet');
    // defaultModel is still threaded — it drives provider routing and its own
    // fallback; the fix ADDS defaultSubagentModel, it does not replace it.
    expect(constructed[0]!['defaultModel']).toBe('gpt-5.5');
  });

  it('propagates defaultSubagentModel recursively (skill→skill→skill)', () => {
    const factory = createChildSkillExecutorFactory(
      'gpt-5.5',
      undefined,
      stubProviderFactory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'cli',
      'sonnet',
    );
    factory(1, 3, new AbortController().signal);

    // The nested executor's own childSkillExecutorFactory must carry the policy
    // forward. Invoke it to build a grandchild and assert it too — this is the
    // depth-2+ path where the pre-fix leak actually manifested.
    const recursive = constructed[0]!['childSkillExecutorFactory'] as (
      depth: number,
      maxDepth: number,
      signal: AbortSignal,
    ) => unknown;
    expect(typeof recursive).toBe('function');
    recursive(2, 3, new AbortController().signal);

    expect(constructed).toHaveLength(2);
    expect(constructed[1]!['defaultSubagentModel']).toBe('sonnet');
  });

  it('omits defaultSubagentModel when the caller does not supply it (back-compat)', () => {
    const factory = createChildSkillExecutorFactory(
      'sonnet',
      undefined,
      stubProviderFactory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'cli',
      // 10th arg omitted — legacy/test callers keep the pre-fix shape.
    );
    factory(1, 3, new AbortController().signal);

    expect(constructed[0]!).not.toHaveProperty('defaultSubagentModel');
  });
});
