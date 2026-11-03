/**
 * Unit tests for the `withProvenanceHeader` gate — the pure decision of whether
 * a returned subagent result is stamped with its producing model.
 *
 * Also covers the delegation-budget promotion contract (PR #1894 / issue #1898):
 *   - `promotionTookBudget.value` is flipped to `true` when promotion succeeds
 *   - the executor must NOT call `budgetRelease` itself after promotion
 *     (the registry's onSettled hook owns it)
 */
import { describe, it, expect, vi } from 'vitest';
import { withProvenanceHeader, runForegroundWithPromotion } from './foreground-promotion.js';
import type { RunForegroundArgs } from './foreground-promotion.js';
import type { SubagentHandle, SubagentResult } from '../../subagent.js';

describe('withProvenanceHeader', () => {
  it('prepends a provenance header when the child model differs from the parent', () => {
    expect(withProvenanceHeader('finding', 'sonnet', 'opus')).toBe(
      '[subagent result · model=sonnet (parent: opus)]\n\nfinding',
    );
  });

  it('returns content unchanged when the child model equals the parent', () => {
    expect(withProvenanceHeader('finding', 'sonnet', 'sonnet')).toBe('finding');
  });

  it('returns content unchanged when the child model is unknown', () => {
    expect(withProvenanceHeader('finding', undefined, 'opus')).toBe('finding');
  });

  it('returns content unchanged when the parent model is not wired', () => {
    expect(withProvenanceHeader('finding', 'sonnet', undefined)).toBe('finding');
  });

  it('preserves an incomplete-partial marker beneath the provenance header', () => {
    // Composes with annotateIfIncomplete output: the header wraps the already-
    // annotated body, so both signals survive.
    const annotated = '[⚠ PARTIAL RESULT — the subagent …]\n\nbody';
    expect(withProvenanceHeader(annotated, 'haiku', 'opus')).toBe(
      `[subagent result · model=haiku (parent: opus)]\n\n${annotated}`,
    );
  });
});

// ─── promotionTookBudget contract (PR #1894 / issue #1898) ──────────────────
//
// When a foreground subagent is promoted to background via Ctrl+B:
//   1. `promotionTookBudget.value` must be set to `true` so the executor knows
//      the registry now owns the budget slot.
//   2. The executor itself must NOT call `budgetRelease` after `runForegroundWithPromotion`
//      returns on the promotion path (calling `promotionTookBudget.value && budgetRelease?.()` must be a no-op).
//
// These tests drive `runForegroundWithPromotion` directly with a fake
// registry that captures `adoptRunning` args, and a hanging handle so the
// promotion race wins before the run completes.

describe('runForegroundWithPromotion — promotionTookBudget (delegation-budget contract)', () => {
  /** A handle whose runToResult blocks until we call resolveRun. */
  function hangingHandle(): {
    handle: RunForegroundArgs['handle'];
    resolveRun: (v: SubagentResult) => void;
  } {
    let resolveRun!: (v: SubagentResult) => void;
    const runPromise = new Promise<SubagentResult>((r) => { resolveRun = r; });
    const handle = {
      id: 'test-handle',
      status: 'running',
      runToResult: vi.fn().mockReturnValue(runPromise),
      cancel: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
    } as unknown as RunForegroundArgs['handle'];
    return { handle, resolveRun };
  }

  /** A registry fake with adoptRunning that immediately returns a BackgroundJob. */
  function fakeRegistry(jobOverrides?: { jobId?: string; label?: string }): RunForegroundArgs['registry'] {
    const job = {
      jobId: jobOverrides?.jobId ?? 'bg-promoted-1',
      subagentId: 'test-handle',
      label: jobOverrides?.label ?? 'promoted job',
      model: 'sonnet',
      status: 'running',
      provenance: 'user-backgrounded',
      startedAt: Date.now(),
    };
    return {
      adoptRunning: vi.fn().mockReturnValue(job),
    } as unknown as RunForegroundArgs['registry'];
  }

  /**
   * Build a minimal RunForegroundArgs with a hanging handle so the promotion
   * signal wins the race.
   */
  function makeArgs(
    overrides: Partial<RunForegroundArgs> & {
      registry: RunForegroundArgs['registry'];
      handle: RunForegroundArgs['handle'];
    },
  ): RunForegroundArgs {
    const promotionTriggers = new Map<string, RunForegroundArgs['promotionTriggers'] extends Map<string, infer V> ? V : never>();
    const activeForegroundHandles = new Map<string, { cancel: () => Promise<void> }>();
    return {
      handle: overrides.handle,
      signal: new AbortController().signal,
      prompt: 'investigate something',
      backgroundPrompt: 'investigate something',
      idPrefix: undefined,
      model: 'sonnet',
      parentModel: undefined,
      childManager: undefined,
      identity: {},
      traceWriter: undefined,
      depth: 1,
      parentSessionId: 'parent-session',
      registry: overrides.registry,
      promotionTriggers,
      activeForegroundHandles,
      ...overrides,
    };
  }

  it('sets promotionTookBudget.value to true after a successful promotion', async () => {
    const { handle } = hangingHandle();
    const registry = fakeRegistry();
    const budgetRelease = vi.fn();
    const promotionTookBudget = { value: false };

    const args = makeArgs({ handle, registry, budgetRelease, promotionTookBudget });

    // Fire the promotion before awaiting so the race picks 'promote'.
    const execPromise = runForegroundWithPromotion(args);
    await Promise.resolve(); // let the function reach the race await

    // Trigger promotion via the registered trigger.
    const trigger = args.promotionTriggers.get(handle.id);
    expect(trigger).toBeDefined();
    trigger!.fire(undefined);

    await execPromise;

    // The flag must be true — the registry now owns budgetRelease via onSettled.
    expect(promotionTookBudget.value).toBe(true);
  });

  it('does NOT call budgetRelease directly when promotion succeeds', async () => {
    const { handle } = hangingHandle();
    const registry = fakeRegistry();
    const budgetRelease = vi.fn();
    const promotionTookBudget = { value: false };

    const args = makeArgs({ handle, registry, budgetRelease, promotionTookBudget });

    const execPromise = runForegroundWithPromotion(args);
    await Promise.resolve();

    const trigger = args.promotionTriggers.get(handle.id);
    trigger!.fire(undefined);

    await execPromise;

    // budgetRelease must NOT have been called by runForegroundWithPromotion —
    // it was forwarded into adoptRunning({ onSettled: budgetRelease }) and
    // the caller (executor) skips its own call because promotionTookBudget.value
    // is now true.
    expect(budgetRelease).not.toHaveBeenCalled();
  });

  it('forwards budgetRelease as onSettled in the adoptRunning args', async () => {
    const { handle } = hangingHandle();
    const registry = fakeRegistry();
    const budgetRelease = vi.fn();
    const promotionTookBudget = { value: false };

    const args = makeArgs({ handle, registry, budgetRelease, promotionTookBudget });

    const execPromise = runForegroundWithPromotion(args);
    await Promise.resolve();

    const trigger = args.promotionTriggers.get(handle.id);
    trigger!.fire(undefined);

    await execPromise;

    const adoptRunningMock = (registry as unknown as { adoptRunning: ReturnType<typeof vi.fn> }).adoptRunning;
    expect(adoptRunningMock).toHaveBeenCalledTimes(1);
    expect(adoptRunningMock).toHaveBeenCalledWith(
      expect.objectContaining({ onSettled: budgetRelease }),
    );
  });

  it('leaves promotionTookBudget.value false when no promotion occurs (run completes normally)', async () => {
    const handle = {
      id: 'test-handle',
      status: 'succeeded',
      runToResult: vi.fn().mockResolvedValue({
        id: 'test-handle',
        status: 'succeeded',
        message: { role: 'assistant', content: 'done', timestamp: new Date() },
      } as SubagentResult),
      cancel: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
    } as unknown as RunForegroundArgs['handle'];

    const registry = fakeRegistry();
    const budgetRelease = vi.fn();
    const promotionTookBudget = { value: false };

    const args = makeArgs({ handle, registry, budgetRelease, promotionTookBudget });
    await runForegroundWithPromotion(args);

    // No promotion happened — value stays false so the caller releases the slot.
    expect(promotionTookBudget.value).toBe(false);
  });
});
