/**
 * Direct unit tests for the background-mode dispatch branch.
 *
 * Follow-up to #443: `runBackgroundBranch` was extracted from
 * `subagent-executor.ts` and previously covered only transitively through the
 * executor's `background mode` describe block. These tests exercise the branch
 * at its own boundary with a mock registry + mock handle, covering the three
 * paths:
 *   1. no registry wired → error + orphan-handle teardown
 *   2. register throws BackgroundJobCapError → error + orphan-handle teardown
 *   3. happy path → register-and-return the synthetic "running" pointer
 *
 * The registry and handle are passed in as explicit parameters (the module is
 * `this`-free), so no executor is constructed here.
 */

import { describe, expect, it, vi } from 'vitest';
import { runBackgroundBranch, type RunBackgroundBranchArgs } from './background-branch.js';
import { BackgroundJobCapError, type BackgroundJob } from '../../background-registry.js';
import type { SubagentHandle } from '../../subagent.js';

/**
 * Minimal handle double: the background branch only touches `handle.id` and
 * `handle.teardown()`. Everything else is cast through `unknown` (mirrors the
 * `bgHandle` helper in subagent-executor.test.ts).
 */
function fakeHandle(id = 'sub-1'): {
  handle: RunBackgroundBranchArgs['handle'];
  teardownMock: ReturnType<typeof vi.fn>;
} {
  const teardownMock = vi.fn().mockResolvedValue(undefined);
  const handle = {
    id,
    status: 'idle',
    teardown: teardownMock,
    cancel: vi.fn().mockResolvedValue(undefined),
    run: vi.fn(),
    runToResult: vi.fn(),
    runInBackground: vi.fn(),
  } as unknown as SubagentHandle;
  return { handle: handle as RunBackgroundBranchArgs['handle'], teardownMock };
}

/** A registry double exposing only `register`, typed loosely then cast. */
function fakeRegistry(
  register: (args: unknown) => BackgroundJob,
): RunBackgroundBranchArgs['registry'] {
  return { register: vi.fn(register) } as unknown as RunBackgroundBranchArgs['registry'];
}

/**
 * A registry double with `register` + `on`/`off` support for testing the
 * onSettled wiring path.
 */
function fakeRegistryWithEvents(
  register: (args: unknown) => BackgroundJob,
): {
  registry: RunBackgroundBranchArgs['registry'];
  emitSettled: (job: BackgroundJob) => void;
} {
  const listeners = new Set<(job: BackgroundJob) => void>();
  const registry = {
    register: vi.fn(register),
    on: vi.fn((_event: string, handler: (job: BackgroundJob) => void) => {
      listeners.add(handler);
    }),
    off: vi.fn((_event: string, handler: (job: BackgroundJob) => void) => {
      listeners.delete(handler);
    }),
  } as unknown as RunBackgroundBranchArgs['registry'];
  return {
    registry,
    emitSettled: (job: BackgroundJob) => {
      for (const handler of listeners) handler(job);
    },
  };
}

function makeJob(overrides?: Partial<BackgroundJob>): BackgroundJob {
  return {
    jobId: 'bg-abc123',
    provenance: 'model',
    subagentId: 'sub-1',
    label: 'deep investigation',
    model: 'sonnet',
    startedAt: Date.now(),
    status: 'running',
    ...overrides,
  } as BackgroundJob;
}

describe('runBackgroundBranch', () => {
  describe('no registry wired', () => {
    it('returns an isError result explaining background mode is unavailable', async () => {
      const { handle } = fakeHandle();
      const result = await runBackgroundBranch({
        handle,
        registry: undefined,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: 'parent-1',
      });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/Background mode is not available/);
      expect(result.content).toMatch(/mode="foreground"/);
    });

    it('tears down the orphaned handle so the fork is not leaked', async () => {
      const { handle, teardownMock } = fakeHandle();
      await runBackgroundBranch({
        handle,
        registry: undefined,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
      });
      expect(teardownMock).toHaveBeenCalledTimes(1);
    });

    it('swallows a teardown rejection on the no-registry path (best-effort cleanup)', async () => {
      const { handle, teardownMock } = fakeHandle();
      teardownMock.mockRejectedValueOnce(new Error('teardown failed'));
      // The branch .catch()es teardown failures via debugLog, so the returned
      // promise still resolves with the error ToolResult.
      const result = await runBackgroundBranch({
        handle,
        registry: undefined,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/Background mode is not available/);
    });
  });

  describe('register throws BackgroundJobCapError', () => {
    it('returns the cap-error message and does not re-throw', async () => {
      const { handle } = fakeHandle();
      const registry = fakeRegistry(() => {
        throw new BackgroundJobCapError(1, 1);
      });
      const result = await runBackgroundBranch({
        handle,
        registry,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/Background job cap reached/);
    });

    it('tears down the orphaned handle after a cap error', async () => {
      const { handle, teardownMock } = fakeHandle();
      const registry = fakeRegistry(() => {
        throw new BackgroundJobCapError(3, 3);
      });
      await runBackgroundBranch({
        handle,
        registry,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
      });
      expect(teardownMock).toHaveBeenCalledTimes(1);
    });

    it('re-throws non-cap errors from register (defense in depth)', async () => {
      const { handle, teardownMock } = fakeHandle();
      const registry = fakeRegistry(() => {
        throw new Error('unexpected registry failure');
      });
      await expect(
        runBackgroundBranch({
          handle,
          registry,
          prompt: 'p',
          model: 'sonnet',
          parentSessionId: undefined,
        }),
      ).rejects.toThrow('unexpected registry failure');
      // Non-cap errors now also tear down the orphaned handle to prevent
      // worktree leaks (added in 2cd2c2f9).
      expect(teardownMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('happy path (register and return)', () => {
    it('registers the handle and returns the synthetic running pointer', async () => {
      const { handle, teardownMock } = fakeHandle('sub-1');
      const job = makeJob({ jobId: 'bg-xyz', subagentId: 'sub-1', label: 'deep investigation' });
      const registry = fakeRegistry(() => job);

      const result = await runBackgroundBranch({
        handle,
        registry,
        prompt: 'deep investigation',
        model: 'sonnet',
        parentSessionId: 'parent-1',
      });

      // No error, and the handle is NOT torn down — the registry now owns it.
      expect(result.isError).toBeUndefined();
      expect(teardownMock).not.toHaveBeenCalled();

      const payload = JSON.parse(result.content) as {
        status: string;
        jobId: string;
        subagentId: string;
        label: string;
        message: string;
      };
      expect(payload.status).toBe('running');
      expect(payload.jobId).toBe('bg-xyz');
      expect(payload.subagentId).toBe('sub-1');
      expect(payload.label).toBe('deep investigation');
      expect(payload.message).toMatch(/Background subagent started/);
      expect(payload.message).toMatch(/delivered into this context/);
      expect(payload.message).toMatch(/\/bgsub:join bg-xyz/);
    });

    it('forwards prompt, model, and parentSessionId into register', async () => {
      const { handle } = fakeHandle();
      const registerSpy = vi.fn(() => makeJob());
      const registry = fakeRegistry(registerSpy);

      await runBackgroundBranch({
        handle,
        registry,
        prompt: 'the prompt',
        model: 'opus',
        parentSessionId: 'parent-42',
      });

      expect(registerSpy).toHaveBeenCalledTimes(1);
      expect(registerSpy).toHaveBeenCalledWith({
        handle,
        prompt: 'the prompt',
        model: 'opus',
        provenance: 'model',
        parentSessionId: 'parent-42',
      });
    });

    it("defaults the registry record model to 'sonnet' when model is undefined", async () => {
      const { handle } = fakeHandle();
      const registerSpy = vi.fn(() => makeJob());
      const registry = fakeRegistry(registerSpy);

      await runBackgroundBranch({
        handle,
        registry,
        prompt: 'p',
        model: undefined,
        parentSessionId: undefined,
      });

      expect(registerSpy).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'sonnet' }),
      );
    });

    it('forwards an undefined parentSessionId as-is (preserves the pre-extraction contract)', async () => {
      const { handle } = fakeHandle();
      const registerSpy = vi.fn(() => makeJob());
      const registry = fakeRegistry(registerSpy);

      await runBackgroundBranch({
        handle,
        registry,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
      });

      expect(registerSpy).toHaveBeenCalledWith(
        expect.objectContaining({ parentSessionId: undefined }),
      );
    });

    it('returns valid JSON content (round-trips)', async () => {
      const { handle } = fakeHandle();
      const registry = fakeRegistry(() => makeJob());
      const result = await runBackgroundBranch({
        handle,
        registry,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
      });
      expect(() => JSON.parse(result.content)).not.toThrow();
    });

    it('does NOT call onSettled directly — settlement comes via the registry settled event', async () => {
      const { handle } = fakeHandle();
      const { registry } = fakeRegistryWithEvents(() => makeJob());
      const onSettled = vi.fn();

      await runBackgroundBranch({
        handle,
        registry,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
        onSettled,
      });

      // The function itself must not call onSettled — settlement is wired
      // through the registry 'settled' event listener, not inline.
      expect(onSettled).not.toHaveBeenCalled();
    });

    it('calls onSettled(false) when registry emits settled with status done', async () => {
      const { handle } = fakeHandle();
      const job = makeJob({ jobId: 'bg-evt', status: 'done' });
      const { registry, emitSettled } = fakeRegistryWithEvents(() => job);
      const onSettled = vi.fn();

      await runBackgroundBranch({
        handle,
        registry,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
        onSettled,
      });

      // Simulate the registry emitting 'settled' for this job.
      emitSettled({ ...job, status: 'done' });
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(false);
    });

    it('calls onSettled(true) when registry emits settled with status failed', async () => {
      const { handle } = fakeHandle();
      const job = makeJob({ jobId: 'bg-fail', status: 'failed' });
      const { registry, emitSettled } = fakeRegistryWithEvents(() => job);
      const onSettled = vi.fn();

      await runBackgroundBranch({
        handle,
        registry,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
        onSettled,
      });

      emitSettled({ ...job, status: 'failed' });
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(true);
    });

    it('ignores settled events for other job IDs', async () => {
      const { handle } = fakeHandle();
      const job = makeJob({ jobId: 'bg-mine' });
      const { registry, emitSettled } = fakeRegistryWithEvents(() => job);
      const onSettled = vi.fn();

      await runBackgroundBranch({
        handle,
        registry,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
        onSettled,
      });

      // Emit for a different job — should be ignored.
      emitSettled({ ...job, jobId: 'bg-other', status: 'done' });
      expect(onSettled).not.toHaveBeenCalled();

      // Emit for our job — should fire.
      emitSettled({ ...job, jobId: 'bg-mine', status: 'done' });
      expect(onSettled).toHaveBeenCalledTimes(1);
    });
  });

  describe('onSettled wiring on error paths', () => {
    it('calls onSettled(true) when no registry is wired', async () => {
      const { handle } = fakeHandle();
      const onSettled = vi.fn();

      await runBackgroundBranch({
        handle,
        registry: undefined,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
        onSettled,
      });

      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(true);
    });

    it('calls onSettled(true) when BackgroundJobCapError is thrown', async () => {
      const { handle } = fakeHandle();
      const registry = fakeRegistry(() => {
        throw new BackgroundJobCapError(1, 1);
      });
      const onSettled = vi.fn();

      await runBackgroundBranch({
        handle,
        registry,
        prompt: 'p',
        model: 'sonnet',
        parentSessionId: undefined,
        onSettled,
      });

      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(true);
    });

    it('does not call onSettled when onSettled is undefined (no-registry path)', async () => {
      const { handle } = fakeHandle();
      // Should not throw when onSettled is omitted.
      await expect(
        runBackgroundBranch({
          handle,
          registry: undefined,
          prompt: 'p',
          model: 'sonnet',
          parentSessionId: undefined,
          // onSettled omitted
        }),
      ).resolves.toBeDefined();
    });

    it('does not call onSettled when onSettled is undefined (cap error path)', async () => {
      const { handle } = fakeHandle();
      const registry = fakeRegistry(() => {
        throw new BackgroundJobCapError(2, 2);
      });
      // Should not throw when onSettled is omitted.
      await expect(
        runBackgroundBranch({
          handle,
          registry,
          prompt: 'p',
          model: 'sonnet',
          parentSessionId: undefined,
          // onSettled omitted
        }),
      ).resolves.toBeDefined();
    });
  });
});
