import { describe, expect, it, vi } from 'vitest';
import { runForegroundWithPromotion, type RunForegroundArgs } from './foreground-promotion.js';
import type { SubagentResult } from '../../subagent.js';

const worktrees = vi.hoisted(() => ({ lock: vi.fn(), unlock: vi.fn(), teardown: vi.fn() }));
vi.mock('../handlers/worktree-managed.background.js', () => ({
  lockWorktreeForBackground: worktrees.lock,
  unlockWorktreeForPromotion: worktrees.unlock,
  teardownBackgroundWorktree: vi.fn(),
}));
vi.mock('../handlers/worktree-managed.js', () => ({
  teardownIsolatedWorktree: worktrees.teardown,
  describePreserveReason: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(events: string[]) {
  const run = deferred<SubagentResult>();
  const controller = new AbortController();
  const handle = {
    id: 'ordering-child',
    runToResult: vi.fn(() => { events.push('run'); return run.promise; }),
    cancel: vi.fn(async () => { events.push('cancel'); }),
    teardown: vi.fn(async () => { events.push('stop'); }),
    getLastStopInjectContext: vi.fn(() => { events.push('context'); return 'stop note'; }),
  } as unknown as RunForegroundArgs['handle'];
  const args: RunForegroundArgs = {
    handle, signal: controller.signal, prompt: 'prompt', backgroundPrompt: 'original prompt',
    idPrefix: undefined, model: 'sonnet', childManager: undefined, identity: {}, depth: 1,
    parentSessionId: undefined, registry: undefined,
    promotionTriggers: new Map(), activeForegroundHandles: new Map(),
  };
  return { args, handle, controller, run };
}

const success: SubagentResult = {
  id: 'ordering-child', status: 'succeeded',
  message: { role: 'assistant', content: 'done', timestamp: new Date() },
};

describe('foreground ordering invariants', () => {
  it('keeps cancellation live during locking, adopts the original promise and captured inputs, then detaches abort', async () => {
    const events: string[] = [];
    const { args, handle, controller, run } = setup(events);
    const lock = deferred<void>();
    const enteredLock = deferred<void>();
    worktrees.lock.mockImplementation(() => { events.push('lock'); enteredLock.resolve(); return lock.promise; });
    const budget = vi.fn();
    const adopt = vi.fn(() => {
      events.push('adopt');
      expect(args.promotionTookBudget!.value).toBe(false);
      return { jobId: 'bg-ordering', subagentId: handle.id, label: 'ordering' };
    });
    args.registry = { adoptRunning: adopt } as unknown as RunForegroundArgs['registry'];
    args.isolationTeardown = { repoRoot: '/repo', worktreePath: '/repo/worktree' };
    args.budgetRelease = budget;
    args.promotionTookBudget = { value: false };
    const resultPromise = runForegroundWithPromotion(args);
    const trigger = args.promotionTriggers.get(handle.id)!;
    trigger.fire();
    await enteredLock.promise;
    controller.abort();
    args.backgroundPrompt = 'changed after await';
    args.budgetRelease = vi.fn();
    lock.resolve();
    const ready = await trigger.ready;
    expect(args.promotionTookBudget.value).toBe(true);
    const result = await resultPromise;
    expect(ready?.jobId).toBe('bg-ordering');
    expect(JSON.parse(result.content).status).toBe('running');
    expect(adopt).toHaveBeenCalledWith(expect.objectContaining({
      runPromise: run.promise, prompt: 'original prompt', onSettled: budget,
    }));
    expect(events).toEqual(['run', 'lock', 'cancel', 'adopt']);
    expect(handle.teardown).not.toHaveBeenCalled();
    expect(args.promotionTriggers.size).toBe(0);
    expect(args.activeForegroundHandles.size).toBe(0);
    run.resolve(success);
  });

  it('removes controls and detaches abort before child teardown, then stops, appends context and tears down isolation', async () => {
    const events: string[] = [];
    const { args, controller, run } = setup(events);
    args.childManager = {
      teardownAll: vi.fn(async () => {
        expect(args.promotionTriggers.size).toBe(0);
        expect(args.activeForegroundHandles.size).toBe(0);
        controller.abort();
        events.push('children');
      }),
    } as unknown as RunForegroundArgs['childManager'];
    args.isolationTeardown = { repoRoot: '/repo', worktreePath: '/repo/worktree' };
    worktrees.teardown.mockImplementation(async () => { events.push('worktree'); return { preserved: false }; });
    const resultPromise = runForegroundWithPromotion(args);
    const trigger = args.promotionTriggers.get(args.handle.id)!;
    run.resolve(success);
    const result = await resultPromise;
    expect(await trigger.ready).toBeNull();
    expect(events).toEqual(['run', 'children', 'stop', 'context', 'worktree']);
    expect(result.content).toContain('stop note');
  });
});
