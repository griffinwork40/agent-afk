/**
 * Integration tests for the zero-output stream-cut re-dispatch wired into
 * {@link SubagentExecutor.execute}.
 *
 * The retry DECISION logic is unit-tested in
 * `subagent/stream-cut-retry.test.ts`. This suite tests the EXECUTOR'S USE of
 * it — specifically the property that unit tests cannot reach: that a
 * re-dispatch calls the full `executeOnce` body again and therefore forks a
 * genuinely FRESH child (`forkSubagent` called twice). A wrapper that merely
 * re-awaited one spent handle would pass the unit tests and still be useless in
 * production, so `forkSubagent` call-count is the load-bearing assertion here.
 *
 * Seams mocked (mirrors `subagent-executor.isolation.test.ts`):
 *   - `./foreground-promotion.js` — returns the ToolResult shape a real
 *     zero-output cut produces, without driving a child.
 *   - `../../auth/credential-resolver.js` / `../../routing-telemetry.js` —
 *     decouple construction from the keychain / telemetry sink.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- Hoisted mocks (must precede the SubagentExecutor import) --------------

const mockResolveCredentialForModel = vi.hoisted(() =>
  vi.fn((_model: string | undefined) => 'resolved-test-credential' as string | undefined),
);
vi.mock('../../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: mockResolveCredentialForModel,
  loadAnthropicCredential: vi.fn(() => 'resolved-test-credential'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

const appendRoutingDecision = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../routing-telemetry.js', () => ({ appendRoutingDecision }));

const runForegroundWithPromotion = vi.hoisted(() => vi.fn());
vi.mock('./foreground-promotion.js', () => ({ runForegroundWithPromotion }));

import type { SubagentHandle, SubagentResult } from '../../subagent.js';
import type { IAgentSession } from '../../types.js';
import type { ToolCall, ToolResult } from '../types.js';
import { SubagentExecutor, type SubagentExecutorContext } from '../subagent-executor.js';
import { STREAM_INCOMPLETE } from '../../subagent/result.js';
import { TOOL_USE_LOOP_CAPPED } from '../../providers/shared/tool-loop-cap.js';

// --- Harness ---------------------------------------------------------------

function mockHandle(id = 'test-handle'): Partial<SubagentHandle> {
  return {
    id,
    status: 'succeeded' as SubagentHandle['status'],
    runToResult: vi.fn().mockResolvedValue({
      id,
      status: 'succeeded',
      message: { role: 'assistant', content: 'test output', timestamp: new Date() },
    } as SubagentResult),
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
  };
}

function makeCall(overrides?: Partial<ToolCall>): ToolCall {
  return {
    id: 'test-call',
    name: 'agent',
    input: { prompt: 'do something' },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Exactly what foreground-promotion delivers for a ZERO-OUTPUT cut. */
const ZERO_OUTPUT_CUT: ToolResult = {
  content: JSON.stringify({ status: 'failed', error: 'produced no output' }),
  isError: true,
  incomplete: true,
  incompleteReason: STREAM_INCOMPLETE,
};

describe('SubagentExecutor — zero-output stream-cut re-dispatch', () => {
  let mockSubagentMgr: { forkSubagent: ReturnType<typeof vi.fn> };
  let mockParentSession: Partial<IAgentSession>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCredentialForModel.mockReturnValue('resolved-test-credential');
    let n = 0;
    mockSubagentMgr = {
      forkSubagent: vi.fn().mockImplementation(() => {
        n += 1;
        return Promise.resolve(mockHandle(`test-handle-${n}`));
      }),
    };
    mockParentSession = {
      sessionId: 'parent-session-id',
      getInputStreamRef: vi.fn(),
      abortSignal: new AbortController().signal,
    };
  });

  /**
   * `readOnly` installs a cage with no `write_file`/`edit_file`/`bash`, which is
   * what drives `childWriteCapable === false` in `buildChildConfig` and hence
   * `probe.sideEffectFree === true`. Retry is ONLY eligible for such a child.
   */
  function makeExecutor(opts?: { readOnly?: boolean; allowedTools?: string[] }): SubagentExecutor {
    const ctx: SubagentExecutorContext = {
      subagentManager: mockSubagentMgr as never,
      parentSession: mockParentSession as never,
      defaultConfig: { apiKey: 'test-key', systemPrompt: 'test system prompt' },
      depth: 0,
      ...(opts?.allowedTools !== undefined
        ? { allowedTools: opts.allowedTools as never }
        : opts?.readOnly === true
          ? { allowedTools: ['read_file', 'grep', 'glob'] as never }
          : {}),
    };
    return new SubagentExecutor(ctx);
  }

  it('re-forks a FRESH child once and returns the rescued result', async () => {
    runForegroundWithPromotion
      .mockResolvedValueOnce(ZERO_OUTPUT_CUT)
      .mockResolvedValueOnce({ content: 'rescued findings' });

    const result = await makeExecutor({ readOnly: true }).execute(makeCall());

    // Load-bearing: TWO forks, i.e. a genuinely fresh child/session/trace —
    // not one spent handle re-awaited.
    expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(2);
    expect(runForegroundWithPromotion).toHaveBeenCalledTimes(2);
    expect(result.content).toBe('rescued findings');
    expect(result.isError).toBeUndefined();
  });

  it('does not fork twice on a clean first run', async () => {
    runForegroundWithPromotion.mockResolvedValue({ content: 'clean' });

    const result = await makeExecutor().execute(makeCall());

    expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('clean');
  });

  it('gives up after the budget and returns the structured failure unchanged', async () => {
    runForegroundWithPromotion.mockResolvedValue(ZERO_OUTPUT_CUT);

    const result = await makeExecutor({ readOnly: true }).execute(makeCall());

    expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(2);
    // Purely additive: the caller sees the same payload it saw pre-retry.
    expect(result).toEqual(ZERO_OUTPUT_CUT);
  });

  it('refuses to retry a WRITE-CAPABLE child even on a zero-output cut', async () => {
    // The load-bearing safety property. "Zero output" is zero assistant TEXT,
    // not zero side effects: a write-capable child may have written files, run
    // `git commit`, or POSTed before the cut, and re-running its prompt would
    // double-fire all of it. Default executor (no cage) => childWriteCapable.
    runForegroundWithPromotion.mockResolvedValue(ZERO_OUTPUT_CUT);

    const result = await makeExecutor().execute(makeCall());

    expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
    expect(result).toEqual(ZERO_OUTPUT_CUT);
  });

  it.each(['send_telegram', 'config_set', 'create_schedule', 'browser_act', 'bash'])(
    'refuses to retry a child with non-file side-effecting tool %s',
    async (tool) => {
      runForegroundWithPromotion.mockResolvedValue(ZERO_OUTPUT_CUT);
      const result = await makeExecutor({ allowedTools: ['read_file', tool] }).execute(makeCall());
      expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
      expect(result).toEqual(ZERO_OUTPUT_CUT);
    },
  );

  it('refuses to re-fork when a cancel lands while between attempts', async () => {
    // Regression guard: across the retry gap BOTH in-flight handle maps are
    // empty, so cancelActiveForeground() finds nothing to cancel and never
    // aborts call.signal. Only the cancel-generation snapshot catches this.
    runForegroundWithPromotion.mockResolvedValue(ZERO_OUTPUT_CUT);
    const executor = makeExecutor({ readOnly: true });

    runForegroundWithPromotion.mockImplementation(async () => {
      await executor.cancelActiveForeground();
      return ZERO_OUTPUT_CUT;
    });

    const result = await executor.execute(makeCall());

    expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
    expect(result).toEqual(ZERO_OUTPUT_CUT);
  });

  it('cancels a fresh retry fork when cancellation lands while forkSubagent awaits', async () => {
    const executor = makeExecutor({ readOnly: true });
    const secondHandle = mockHandle('retry-handle');
    runForegroundWithPromotion.mockResolvedValueOnce(ZERO_OUTPUT_CUT);
    mockSubagentMgr.forkSubagent
      .mockResolvedValueOnce(mockHandle('first-handle'))
      .mockImplementationOnce(async () => {
        await executor.cancelActiveForeground();
        return secondHandle;
      });

    const result = await executor.execute(makeCall());

    expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(2);
    expect(runForegroundWithPromotion).toHaveBeenCalledTimes(1);
    // cancel(), not teardown(): only cancel() emits the terminal
    // subagent_lifecycle row that closes the 'started' forkSubagent wrote, so a
    // teardown here would leave an unmatched 'started' in the witness trace.
    expect(secondHandle.cancel).toHaveBeenCalledTimes(1);
    expect(secondHandle.teardown).not.toHaveBeenCalled();
    expect(result).toEqual({ content: 'Agent tool call aborted', isError: true });
  });

  it('does NOT retry a tool-budget cap (a requested ceiling, not a transport failure)', async () => {
    runForegroundWithPromotion.mockResolvedValue({
      content: '{}',
      isError: true,
      incomplete: true,
      incompleteReason: TOOL_USE_LOOP_CAPPED,
    });

    await makeExecutor().execute(makeCall());

    expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a buffered partial — salvaged findings must survive', async () => {
    // A cut that streamed real text resolves status:'succeeded' and so arrives
    // WITHOUT isError, even though incompleteReason is stream_incomplete.
    runForegroundWithPromotion.mockResolvedValue({
      content: 'partial findings the child really produced',
      incomplete: true,
      incompleteReason: STREAM_INCOMPLETE,
    });

    const result = await makeExecutor().execute(makeCall());

    expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('partial findings the child really produced');
  });

  it('does NOT retry an ordinary hard failure', async () => {
    runForegroundWithPromotion.mockResolvedValue({ content: 'boom', isError: true });

    await makeExecutor().execute(makeCall());

    expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
  });

  it('does not re-fork when the parent turn was aborted mid-flight', async () => {
    const controller = new AbortController();
    runForegroundWithPromotion.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(ZERO_OUTPUT_CUT);
    });

    const result = await makeExecutor({ readOnly: true }).execute(
      makeCall({ signal: controller.signal }),
    );

    expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
  });

  it('background mode is unaffected — never reaches the foreground path, never re-forks', async () => {
    // No backgroundRegistry in this ctx, so the background branch returns its
    // own error. That is precisely the case worth pinning: an `isError` result
    // that is NOT a stream cut must never be re-dispatched, so the wrapper has
    // to leave non-`stream_incomplete` failures alone.
    const result = await makeExecutor().execute(
      makeCall({ input: { prompt: 'bg work', mode: 'background' } }),
    );

    expect(runForegroundWithPromotion).not.toHaveBeenCalled();
    expect(mockSubagentMgr.forkSubagent).toHaveBeenCalledTimes(1);
    expect(result.incompleteReason).toBeUndefined();
  });
});
