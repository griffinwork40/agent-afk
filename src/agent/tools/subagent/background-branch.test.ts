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

function makeJob(overrides?: Partial<BackgroundJob>): BackgroundJob {
  return {
    jobId: 'bg-abc123',
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
      // A non-cap throw is NOT the leak-cleanup path — teardown is only wired
      // for the cap branch, so it must not have been called here.
      expect(teardownMock).not.toHaveBeenCalled();
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
  });
});
