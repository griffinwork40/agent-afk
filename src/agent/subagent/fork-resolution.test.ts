/**
 * Unit tests for `resolveForkInputs` — the pure, synchronous resolution chain
 * that derives every field of `ForkResolved` from explicit inputs.
 *
 * Four independent precedence paths are exercised:
 *  1. Hook registry cascade: per-fork config → manager-level → parent session
 *  2. Trace writer selection: per-fork config → manager-level writer
 *  3. Model coercion: `coerceCrossProviderChildModel` feeds `effectiveChildModel`
 *     and `coercedFrom`
 *  4. Timeout resolution: explicit config → env-resolved default
 *
 * Plus: `id` embeds the supplied counter value and idPrefix.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveForkInputs } from './fork-resolution.js';
import { SUBAGENT_DEFAULT_TIMEOUT_MS } from './constants.js';
import type { ResolveForkInputsArgs } from './fork-resolution.js';
import type { HookRegistry } from '../hooks.js';
import type { TraceSink } from '../trace/index.js';

// ---------------------------------------------------------------------------
// Mocking strategy:
//   - `coerceCrossProviderChildModel` is mocked so model-coercion tests are
//     pure and don't depend on provider-detection env plumbing.
//   - `resolveSubagentTimeoutMs` is mocked for timeout-precedence tests.
//   Both mocks are reset before each test.
// ---------------------------------------------------------------------------
vi.mock('./child-model-fallback.js', () => ({
  coerceCrossProviderChildModel: vi.fn(),
}));

vi.mock('./constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./constants.js')>();
  return {
    ...actual,
    resolveSubagentTimeoutMs: vi.fn(() => actual.SUBAGENT_DEFAULT_TIMEOUT_MS),
  };
});

import { coerceCrossProviderChildModel } from './child-model-fallback.js';
import { resolveSubagentTimeoutMs } from './constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub HookRegistry — shape only, no real dispatch logic needed. */
const makeRegistry = (label: string): HookRegistry =>
  ({ _label: label }) as unknown as HookRegistry;

/** Minimal stub TraceSink. */
const makeTraceWriter = (label: string): TraceSink =>
  ({ _label: label }) as unknown as TraceSink;

/** Build a minimal `ResolveForkInputsArgs` with all three registry tiers and
 *  sane defaults — tests override only the fields they care about. */
function makeArgs(overrides: Partial<ResolveForkInputsArgs> = {}): ResolveForkInputsArgs {
  return {
    options: {
      parent: {
        sessionId: 'parent-session-id',
        hookRegistry: makeRegistry('parent'),
      },
      config: {
        model: 'sonnet',
      },
      agentType: 'test-agent',
    },
    counter: 1,
    managerHookRegistry: undefined,
    parentTraceWriter: undefined,
    parentModel: undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Default mock setup: no coercion, default timeout
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.mocked(coerceCrossProviderChildModel).mockReturnValue({ model: 'sonnet' });
  vi.mocked(resolveSubagentTimeoutMs).mockReturnValue(SUBAGENT_DEFAULT_TIMEOUT_MS);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// 1. Hook registry cascade
// ===========================================================================
describe('registry resolution', () => {
  it('uses per-fork config registry when all three are set (highest precedence)', () => {
    const perFork = makeRegistry('per-fork');
    const manager = makeRegistry('manager');
    const parent = makeRegistry('parent');

    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid', hookRegistry: parent },
        config: { model: 'sonnet', hookRegistry: perFork },
        agentType: 'a',
      },
      managerHookRegistry: manager,
    });

    expect(resolveForkInputs(args).registry).toBe(perFork);
  });

  it('falls back to manager-level registry when per-fork config is unset', () => {
    const manager = makeRegistry('manager');
    const parent = makeRegistry('parent');

    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid', hookRegistry: parent },
        config: { model: 'sonnet' }, // no hookRegistry
        agentType: 'a',
      },
      managerHookRegistry: manager,
    });

    expect(resolveForkInputs(args).registry).toBe(manager);
  });

  it('falls back to parent session registry when per-fork and manager are both unset', () => {
    const parent = makeRegistry('parent');

    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid', hookRegistry: parent },
        config: { model: 'sonnet' },
        agentType: 'a',
      },
      managerHookRegistry: undefined,
    });

    expect(resolveForkInputs(args).registry).toBe(parent);
  });

  it('returns undefined when all three tiers are undefined', () => {
    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid' }, // no hookRegistry
        config: { model: 'sonnet' },
        agentType: 'a',
      },
      managerHookRegistry: undefined,
    });

    expect(resolveForkInputs(args).registry).toBeUndefined();
  });
});

// ===========================================================================
// 2. Trace writer selection
// ===========================================================================
describe('effectiveTraceWriter resolution', () => {
  it('uses per-fork config writer when it is set (highest precedence)', () => {
    const perFork = makeTraceWriter('per-fork');
    const manager = makeTraceWriter('manager');

    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid' },
        config: { model: 'sonnet', traceWriter: perFork },
        agentType: 'a',
      },
      parentTraceWriter: manager,
    });

    expect(resolveForkInputs(args).effectiveTraceWriter).toBe(perFork);
  });

  it('falls back to manager-level writer when per-fork config has none', () => {
    const manager = makeTraceWriter('manager');

    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid' },
        config: { model: 'sonnet' }, // no traceWriter
        agentType: 'a',
      },
      parentTraceWriter: manager,
    });

    expect(resolveForkInputs(args).effectiveTraceWriter).toBe(manager);
  });

  it('returns undefined when both per-fork and manager writers are unset', () => {
    const args = makeArgs({
      parentTraceWriter: undefined,
    });

    expect(resolveForkInputs(args).effectiveTraceWriter).toBeUndefined();
  });
});

// ===========================================================================
// 3. Model coercion
// ===========================================================================
describe('model coercion', () => {
  it('uses the coercion result as effectiveChildModel when coercion fires', () => {
    vi.mocked(coerceCrossProviderChildModel).mockReturnValue({
      model: 'gpt-5.5',
      coercedFrom: 'sonnet',
    });

    const args = makeArgs({ parentModel: 'gpt-5.5' });
    const result = resolveForkInputs(args);

    expect(result.effectiveChildModel).toBe('gpt-5.5');
    expect(result.coercedFrom).toBe('sonnet');
  });

  it('passes coercedFrom as undefined when no coercion is needed', () => {
    vi.mocked(coerceCrossProviderChildModel).mockReturnValue({ model: 'sonnet' });

    const args = makeArgs();
    const result = resolveForkInputs(args);

    expect(result.effectiveChildModel).toBe('sonnet');
    expect(result.coercedFrom).toBeUndefined();
  });

  it('falls back to options.config.model when coercion returns undefined model', () => {
    // This can happen when coerceCrossProviderChildModel is given an undefined
    // child model (passthrough), but we guard with `?? options.config.model`.
    vi.mocked(coerceCrossProviderChildModel).mockReturnValue({ model: undefined });

    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid' },
        config: { model: 'fallback-model' },
        agentType: 'a',
      },
    });

    expect(resolveForkInputs(args).effectiveChildModel).toBe('fallback-model');
  });

  it('forwards config.model and parentModel to coerceCrossProviderChildModel', () => {
    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid' },
        config: { model: 'opus' },
        agentType: 'a',
      },
      parentModel: 'gpt-4o',
    });

    resolveForkInputs(args);

    expect(coerceCrossProviderChildModel).toHaveBeenCalledWith('opus', 'gpt-4o');
  });
});

// ===========================================================================
// 4. Timeout resolution
// ===========================================================================
describe('effectiveTimeoutMs resolution', () => {
  it('uses explicit config.timeoutMs when provided (highest precedence)', () => {
    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid' },
        config: { model: 'sonnet', timeoutMs: 99_000 },
        agentType: 'a',
      },
    });

    expect(resolveForkInputs(args).effectiveTimeoutMs).toBe(99_000);
    // resolveSubagentTimeoutMs should not have been the deciding factor
    expect(resolveSubagentTimeoutMs).not.toHaveBeenCalled();
  });

  it('falls back to resolveSubagentTimeoutMs() when config.timeoutMs is absent', () => {
    vi.mocked(resolveSubagentTimeoutMs).mockReturnValue(27_000);

    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid' },
        config: { model: 'sonnet' }, // no timeoutMs
        agentType: 'a',
      },
    });

    expect(resolveForkInputs(args).effectiveTimeoutMs).toBe(27_000);
    expect(resolveSubagentTimeoutMs).toHaveBeenCalledOnce();
  });

  it('treats config.timeoutMs = 0 as an explicit value (disable / unbounded)', () => {
    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid' },
        config: { model: 'sonnet', timeoutMs: 0 },
        agentType: 'a',
      },
    });

    // 0 is the explicit "disable timeout" sentinel — must NOT fall back to default.
    // NOTE: `0 ?? fallback` short-circuits because 0 is NOT nullish, so this is
    // testing the real production behaviour of the `??` operator at the fork site.
    expect(resolveForkInputs(args).effectiveTimeoutMs).toBe(0);
  });
});

// ===========================================================================
// 5. id and resume fields
// ===========================================================================
describe('id and resume', () => {
  it('embeds the supplied counter in the id', () => {
    const args = makeArgs({ counter: 42 });
    const { id } = resolveForkInputs(args);
    expect(id).toMatch(/-42$/);
  });

  it('uses the supplied idPrefix in the id', () => {
    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid' },
        config: { model: 'sonnet' },
        agentType: 'a',
        idPrefix: 'my-prefix',
      },
      counter: 1,
    });

    expect(resolveForkInputs(args).id).toMatch(/^my-prefix-/);
  });

  it('defaults to "subagent" when idPrefix is omitted', () => {
    const args = makeArgs({
      options: {
        parent: { sessionId: 'sid' },
        config: { model: 'sonnet' },
        agentType: 'a',
        // idPrefix omitted
      },
    });

    expect(resolveForkInputs(args).id).toMatch(/^subagent-/);
  });

  it('sets resume to options.parent.sessionId', () => {
    const args = makeArgs({
      options: {
        parent: { sessionId: 'my-session-123' },
        config: { model: 'sonnet' },
        agentType: 'a',
      },
    });

    expect(resolveForkInputs(args).resume).toBe('my-session-123');
  });

  it('sets resume to undefined when parent.sessionId is absent', () => {
    const args = makeArgs({
      options: {
        parent: {}, // no sessionId
        config: { model: 'sonnet' },
        agentType: 'a',
      },
    });

    expect(resolveForkInputs(args).resume).toBeUndefined();
  });
});
