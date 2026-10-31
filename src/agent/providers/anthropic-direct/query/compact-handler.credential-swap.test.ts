/**
 * Tests for `credential_swap` emission from the compaction path.
 *
 * Addresses advisory finding #1 from #4370: the `credential_swap` phase
 * emitted inside the `sessionSummarize` closure (compact-handler.ts:144-153)
 * had zero test coverage. This file covers:
 *
 *   - A `syncClientWithStore()` result with `swapped: true` causes a
 *     `credential_swap` phase event with `source: 'compaction'` to be emitted.
 *   - A result with `swapped: false` does NOT emit `credential_swap`.
 *   - A `null` result (no swap needed) does NOT emit `credential_swap`.
 *   - A `syncClientWithStore()` that throws does NOT emit and does not
 *     propagate the error (best-effort, falls back to the existing client).
 *
 * The compaction summarization path is network-bound, so this file stubs the
 * entire `runCompactionCore` to invoke the `summarize` closure inline and
 * return a success result, letting the test focus solely on the credential-swap
 * branch inside `sessionSummarize`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before dynamic imports).
// ---------------------------------------------------------------------------

const emitSessionPhaseMock = vi.hoisted(() => vi.fn());
const syncClientWithStoreMock = vi.hoisted(() => vi.fn());
const runCompactionCoreMock = vi.hoisted(() => vi.fn());

vi.mock('../../../trace/emit.js', () => ({
  emitSessionPhase: emitSessionPhaseMock,
  emitCompaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../shared/compaction.js', () => ({
  runCompactionCore: runCompactionCoreMock,
  readKeepLastN: () => 2,
  readShrinkFraction: () => 0.5,
  resolveMicrocompactOptions: () => ({ thresholdBytes: 10_000, keepLast: 1, delegationThresholdBytes: 5_000 }),
  wrapTranscriptForSummary: (t: string) => t,
}));

vi.mock('../../shared/compact-summarizer.js', () => ({
  // Return the sessionSummarize closure unchanged (same-family mock).
  resolveCrossProviderSummarize: (_family: unknown, fn: unknown) => fn,
}));

vi.mock('../../shared/auto-compact.js', () => ({
  contextFullnessFraction: () => 0.5,
  contextWindowTokensUsed: () => 0,
}));

vi.mock('../../../model-limits.js', () => ({
  autoCompactLimitFor: () => 200_000,
}));

vi.mock('../auth.js', () => ({
  buildRequestHeaders: () => ({ 'x-test': '1' }),
}));

vi.mock('../compact.js', () => ({
  anthropicCompactionOps: {},
  microcompactToolResults: () => ({ blocksCleared: 0, bytesReclaimed: 0, firstClearedIndex: undefined }),
  COMPACT_SYSTEM_PROMPT: 'summarize',
}));

vi.mock('../../../session/model-resolution.js', () => ({
  resolveModelId: (m: string) => m,
}));

vi.mock('../../shared/transient-retry.trace.js', () => ({
  traceTransientRetry: () => () => undefined,
  traceExhaustedRetry: () => () => undefined,
}));

vi.mock('../../shared/transient-retry.js', () => ({
  DEFAULT_TRANSIENT_MAX_RETRIES: 3,
}));

vi.mock('../../../../config/env.js', () => ({
  env: { AFK_COMPACT_MODEL: undefined, AFK_MICROCOMPACT_TOOL_RESULT_BYTES: undefined, AFK_MICROCOMPACT_KEEP_LAST: undefined, AFK_MICROCOMPACT_DELEGATION_BYTES: undefined },
}));

// ---------------------------------------------------------------------------
// Dynamic imports after mocks are wired.
// ---------------------------------------------------------------------------

import { compactHistory } from './compact-handler.js';
import { createSessionState } from './session-state.js';
import { AbortCoordinator } from '../../shared/abort-coordinator.js';
import type { RetryLayer } from './retry-layer.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeMessages(): MessageParam[] {
  return [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: 'do something' },
    { role: 'assistant', content: 'done' },
  ];
}

function makeState() {
  return createSessionState({
    model: 'claude-sonnet-4-5',
    permissionMode: 'default',
    userSystem: null,
    toolDispatcher: {} as unknown as ToolDispatcher,
    initialMessages: makeMessages(),
  });
}

/** Fake RetryLayer stub. `syncClientWithStore` is replaced per-test. */
function makeRetry(
  syncResult: Awaited<ReturnType<RetryLayer['syncClientWithStore']>> | 'throw',
): RetryLayer {
  return {
    authMode: 'oauth',
    client: { messages: { create: vi.fn().mockResolvedValue({ [Symbol.asyncIterator]: async function* () {} }) } },
    syncClientWithStore: syncResult === 'throw'
      ? vi.fn().mockRejectedValue(new Error('keychain locked'))
      : vi.fn().mockResolvedValue(syncResult),
  } as unknown as RetryLayer;
}

/**
 * Wire `runCompactionCore` to invoke the `summarize` closure (simulating a
 * real summarization pass) and return a minimal success result.
 */
function wireRunCompactionCore() {
  runCompactionCoreMock.mockImplementation(async (opts: { summarize: (t: string) => Promise<string>; onSuccess: (info: unknown) => void; messages: MessageParam[] }) => {
    // Invoke summarize so the credential-swap branch inside it fires.
    await opts.summarize('fake transcript');
    opts.onSuccess({
      olderSlice: [],
      summary: 'summary',
      keptTailCount: 2,
      keepLastN: 2,
      messagesBefore: opts.messages.length,
      messagesAfter: 2,
      tokensSavedEstimate: 100,
    });
    return {
      compacted: true,
      messagesBefore: opts.messages.length,
      messagesAfter: 2,
    };
  });
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

beforeEach(() => {
  emitSessionPhaseMock.mockReset();
  emitSessionPhaseMock.mockResolvedValue(undefined);
  runCompactionCoreMock.mockReset();
  syncClientWithStoreMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('compactHistory — credential_swap emission from compaction path', () => {
  it('emits credential_swap with source:compaction when syncClientWithStore returns swapped:true', async () => {
    wireRunCompactionCore();
    const state = makeState();
    const retry = makeRetry({
      swapped: true,
      accountId: 'acct-new',
      oldAccountId: 'acct-old',
    });

    await compactHistory({ state, abort: new AbortCoordinator(), retry, initSessionId: 's1' });

    expect(retry.syncClientWithStore).toHaveBeenCalled();
    expect(emitSessionPhaseMock).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        phase: 'credential_swap',
        metadata: expect.objectContaining({
          source: 'compaction',
          accountId: 'acct-new',
          oldAccountId: 'acct-old',
        }),
      }),
    );
  });

  it('does NOT emit credential_swap when syncClientWithStore returns swapped:false', async () => {
    wireRunCompactionCore();
    const state = makeState();
    const retry = makeRetry({ swapped: false, accountId: 'acct-same', oldAccountId: 'acct-same' });

    await compactHistory({ state, abort: new AbortCoordinator(), retry, initSessionId: 's1' });

    expect(retry.syncClientWithStore).toHaveBeenCalled();
    expect(emitSessionPhaseMock).not.toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ phase: 'credential_swap' }),
    );
  });

  it('does NOT emit credential_swap when syncClientWithStore returns null (no swap needed)', async () => {
    wireRunCompactionCore();
    const state = makeState();
    const retry = makeRetry(null);

    await compactHistory({ state, abort: new AbortCoordinator(), retry, initSessionId: 's1' });

    expect(retry.syncClientWithStore).toHaveBeenCalled();
    expect(emitSessionPhaseMock).not.toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ phase: 'credential_swap' }),
    );
  });

  it('does NOT propagate a syncClientWithStore error (best-effort, falls back to existing client)', async () => {
    wireRunCompactionCore();
    const state = makeState();
    const retry = makeRetry('throw');

    // Must not throw — the try/catch inside sessionSummarize absorbs the error.
    await expect(
      compactHistory({ state, abort: new AbortCoordinator(), retry, initSessionId: 's1' }),
    ).resolves.not.toThrow();

    expect(emitSessionPhaseMock).not.toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ phase: 'credential_swap' }),
    );
  });
});
