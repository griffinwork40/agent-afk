import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSubagentDAG, type SubagentDAGNode } from './dag-subagent.js';
import type { SubagentManager } from './subagent.js';
import type { IAgentSession, Message } from './types.js';

vi.mock('../utils/debug.js', () => ({ debugLog: vi.fn() }));

interface FakeHandle {
  runToResult: ReturnType<typeof vi.fn>;
  teardown: ReturnType<typeof vi.fn>;
}

function makeFakeHandle(reply: string | Error, outputValue?: unknown): FakeHandle {
  return {
    runToResult: vi.fn(async (): Promise<{
      id: string;
      status: string;
      message?: Message;
      output?: unknown;
      error?: Error;
    }> => {
      if (reply instanceof Error) {
        return { id: 'fake', status: 'failed', error: reply };
      }
      return {
        id: 'fake',
        status: 'succeeded',
        message: { role: 'assistant' as const, content: reply, timestamp: new Date() },
        ...(outputValue !== undefined ? { output: outputValue } : {}),
      };
    }),
    teardown: vi.fn(async () => undefined),
  };
}

function makeFakeManager(handleFactory: () => FakeHandle): SubagentManager {
  return {
    forkSubagent: vi.fn(async () => handleFactory()),
  } as unknown as SubagentManager;
}

function makeParent(): Pick<IAgentSession, 'sessionId' | 'abortSignal'> {
  return {
    sessionId: 'test-parent',
    abortSignal: new AbortController().signal,
  };
}

describe('runSubagentDAG', () => {
  let handles: FakeHandle[];
  let handleIdx: number;

  beforeEach(() => {
    handles = [];
    handleIdx = 0;
  });

  function pushHandle(reply: string | Error, outputValue?: unknown): void {
    handles.push(makeFakeHandle(reply, outputValue));
  }

  function managerFromQueue(): SubagentManager {
    return makeFakeManager(() => {
      const h = handles[handleIdx++];
      if (!h) throw new Error('No more fake handles');
      return h;
    });
  }

  it('single-node subagent DAG: forks, runs, tears down', async () => {
    pushHandle('hello');
    const manager = managerFromQueue();

    const spec: SubagentDAGNode = {
      id: 'A',
      systemPrompt: 'You are a test agent',
      promptBuilder: () => 'do something',
    };

    const result = await runSubagentDAG({
      manager,
      parentSession: makeParent(),
      nodes: [spec],
      edges: [],
    });

    expect(result.outputs['A']).toBe('hello');
    expect(result.failed).toEqual([]);
    expect(handles[0]!.runToResult).toHaveBeenCalledWith('do something');
    expect(handles[0]!.teardown).toHaveBeenCalled();
  });

  it('forks nodes with parent session identity only, so compose/DAG cannot inject context', async () => {
    pushHandle('hello');
    const manager = managerFromQueue();

    await runSubagentDAG({
      manager,
      parentSession: makeParent(),
      nodes: [{ id: 'A', systemPrompt: 's', promptBuilder: () => 'p' }],
      edges: [],
    });

    const fork = manager.forkSubagent as unknown as ReturnType<typeof vi.fn>;
    const forkOptions = fork.mock.calls[0]![0];

    // Current contract: compose/DAG nodes intentionally receive no parent input
    // stream ref. Their final output returns through DAG outputs/tool results;
    // SubagentStop.injectContext cannot enqueue hidden parent turns here.
    expect(forkOptions.parent).toEqual({ sessionId: 'test-parent' });
    expect(forkOptions.parent.getInputStreamRef).toBeUndefined();
  });

  it('two-node chain: output of first feeds promptBuilder of second', async () => {
    pushHandle('first-output');
    pushHandle('second-output');
    const manager = managerFromQueue();

    const nodes: SubagentDAGNode[] = [
      {
        id: 'A',
        systemPrompt: 'agent-a',
        promptBuilder: () => 'start',
      },
      {
        id: 'B',
        systemPrompt: 'agent-b',
        promptBuilder: (inputs) => `continue with: ${inputs['A'] as string}`,
      },
    ];

    const result = await runSubagentDAG({
      manager,
      parentSession: makeParent(),
      nodes,
      edges: [{ from: 'A', to: 'B' }],
    });

    expect(result.outputs['A']).toBe('first-output');
    expect(result.outputs['B']).toBe('second-output');
    expect(handles[1]!.runToResult).toHaveBeenCalledWith('continue with: first-output');
  });

  it('parallel fan-out: all fork in same layer, teardown fires on each', async () => {
    pushHandle('b1');
    pushHandle('b2');
    pushHandle('b3');
    const manager = managerFromQueue();

    const nodes: SubagentDAGNode[] = [
      { id: 'B1', systemPrompt: 's', promptBuilder: () => 'p' },
      { id: 'B2', systemPrompt: 's', promptBuilder: () => 'p' },
      { id: 'B3', systemPrompt: 's', promptBuilder: () => 'p' },
    ];

    const result = await runSubagentDAG({
      manager,
      parentSession: makeParent(),
      nodes,
      edges: [],
    });

    expect(Object.keys(result.outputs)).toHaveLength(3);
    for (const h of handles) {
      expect(h.teardown).toHaveBeenCalled();
    }
  });

  it('failed subagent skips downstream, teardown still fires', async () => {
    pushHandle(new Error('agent-a exploded'));
    pushHandle('should not run');
    const manager = managerFromQueue();

    const nodes: SubagentDAGNode[] = [
      { id: 'A', systemPrompt: 's', promptBuilder: () => 'p' },
      { id: 'B', systemPrompt: 's', promptBuilder: () => 'p' },
    ];

    const result = await runSubagentDAG({
      manager,
      parentSession: makeParent(),
      nodes,
      edges: [{ from: 'A', to: 'B' }],
    });

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('A');
    expect(result.skipped).toContain('B');
    expect(handles[0]!.teardown).toHaveBeenCalled();
  });

  it('outputSchema extraction flows through outputs', async () => {
    pushHandle('', { parsed: true, score: 42 });
    const manager = managerFromQueue();

    const nodes: SubagentDAGNode[] = [
      {
        id: 'A',
        systemPrompt: 's',
        promptBuilder: () => 'p',
        outputSchema: undefined,
      },
    ];

    const result = await runSubagentDAG({
      manager,
      parentSession: makeParent(),
      nodes,
      edges: [],
    });

    expect(result.outputs['A']).toEqual({ parsed: true, score: 42 });
  });

  it('attaches partialOutput + subagentId to the thrown error when a node fails', async () => {
    // When a subagent fails with partial findings, dag-subagent.ts must
    // decorate the thrown error so the partial survives the DAG's lossy
    // { id, error } contract. Compose's formatDAGResult is the consumer.
    const handleWithPartial: FakeHandle = {
      runToResult: vi.fn(async () => ({
        id: 'fork-id-xyz',
        status: 'failed' as const,
        error: new Error('mid-stream abort'),
        partialOutput: 'I had finished step 1 when the stream cut',
      })),
      teardown: vi.fn(async () => undefined),
    };
    handles.push(handleWithPartial);
    const manager = managerFromQueue();

    const result = await runSubagentDAG({
      manager,
      parentSession: makeParent(),
      nodes: [{ id: 'A', systemPrompt: 's', promptBuilder: () => 'p' }],
      edges: [],
    });

    expect(result.failed).toHaveLength(1);
    const failedErr = result.failed[0]!.error as Error & {
      partialOutput?: unknown;
      subagentId?: string;
    };
    expect(failedErr.message).toBe('mid-stream abort');
    expect(failedErr.partialOutput).toBe('I had finished step 1 when the stream cut');
    expect(failedErr.subagentId).toBe('fork-id-xyz');
  });

  it('omits partialOutput attachment when none was captured', async () => {
    // No-op decoration: failures with no partial findings produce a plain
    // Error so downstream consumers don't see a stale partialOutput field.
    pushHandle(new Error('plain failure'));
    const manager = managerFromQueue();

    const result = await runSubagentDAG({
      manager,
      parentSession: makeParent(),
      nodes: [{ id: 'A', systemPrompt: 's', promptBuilder: () => 'p' }],
      edges: [],
    });

    expect(result.failed).toHaveLength(1);
    const failedErr = result.failed[0]!.error as Error & { partialOutput?: unknown };
    expect(failedErr.message).toBe('plain failure');
    expect(failedErr.partialOutput).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Per-node abort forwarding: DAG-level abort (nodeTimeoutMs, fail-fast,
  // parent cancel) must reach the subagent handle so the stream actually
  // tears down. Without this, DAG-level supervision policies are silent.
  // -------------------------------------------------------------------------
  describe('nodeSignal forwarding', () => {
    it('calls handle.cancel when nodeSignal aborts mid-run', async () => {
      // Build a handle whose runToResult resolves only after the test
      // explicitly releases it, so we can observe cancel() firing first.
      let releaseRun: (value: {
        id: string;
        status: string;
        message?: Message;
        partialOutput?: unknown;
        error?: Error;
      }) => void = () => {};

      const cancel = vi.fn(async () => undefined);
      const handle = {
        runToResult: vi.fn(
          () =>
            new Promise<{
              id: string;
              status: string;
              message?: Message;
              partialOutput?: unknown;
              error?: Error;
            }>((resolve) => {
              releaseRun = resolve;
            }),
        ),
        teardown: vi.fn(async () => undefined),
        cancel,
      };

      const manager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      const parentController = new AbortController();
      const parent: Pick<IAgentSession, 'sessionId' | 'abortSignal'> = {
        sessionId: 'parent',
        abortSignal: parentController.signal,
      };

      // Kick off the DAG run with a timeout that will fire while the handle
      // is still pending. The fork's run.run() is suspended waiting for
      // releaseRun, so the timeout forwarding path is exercised.
      const dagPromise = runSubagentDAG({
        manager,
        parentSession: parent,
        nodes: [{ id: 'N', systemPrompt: 's', promptBuilder: () => 'p' }],
        edges: [],
        nodeTimeoutMs: 1_000,
      });

      // Wait for the handle to be created and runToResult to be called.
      await new Promise((r) => setTimeout(r, 20));

      // Simulate the DAG abort by aborting the parent — this cascades
      // through to dagController and the per-node controller, exercising
      // the nodeSignal → handle.cancel forwarding.
      parentController.abort('test-cancel');

      // Give the abort event a tick to fire the listener.
      await new Promise((r) => setTimeout(r, 10));

      expect(cancel).toHaveBeenCalled();

      // Release the pending runToResult so the DAG can finish.
      releaseRun({
        id: 'fork-id',
        status: 'cancelled',
        error: new Error('cancelled'),
        partialOutput: 'mid-stream content',
      });

      const result = await dagPromise;
      expect(result.failed).toHaveLength(1);
    });

    it('does not call cancel when the node completes normally', async () => {
      const cancel = vi.fn(async () => undefined);
      const handle = {
        runToResult: vi.fn(async () => ({
          id: 'fork-id',
          status: 'succeeded' as const,
          message: {
            role: 'assistant' as const,
            content: 'ok',
            timestamp: new Date(),
          },
        })),
        teardown: vi.fn(async () => undefined),
        cancel,
      };

      const manager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [{ id: 'N', systemPrompt: 's', promptBuilder: () => 'p' }],
        edges: [],
        nodeTimeoutMs: 1_000,
      });

      expect(cancel).not.toHaveBeenCalled();
      expect(result.outputs['N']).toBe('ok');
    });
  });

  describe('TimeoutError surfacing via nodeTimeoutMs', () => {
    // Builds a handle whose `runToResult` blocks indefinitely on its own.
    // The handle resolves when `cancel()` is called, returning a stub
    // SubagentResult with the supplied error + partialOutput. This shape
    // matches the real flow: handle.cancel() interrupts the stream, which
    // populates partialOutput from accumulated chunks, then runToResult
    // resolves with status='cancelled'.
    function makeBlockingHandle(args: {
      id?: string;
      error?: Error;
      partialOutput?: unknown;
    }): {
      handle: {
        runToResult: ReturnType<typeof vi.fn>;
        teardown: ReturnType<typeof vi.fn>;
        cancel: ReturnType<typeof vi.fn>;
      };
      manager: SubagentManager;
    } {
      let resolveRun: (value: {
        id: string;
        status: 'cancelled';
        error: Error;
        partialOutput?: unknown;
      }) => void = () => {};

      const cancel = vi.fn(async () => {
        resolveRun({
          id: args.id ?? 'fork-x',
          status: 'cancelled',
          error: args.error ?? new Error('inner cancel'),
          ...(args.partialOutput !== undefined ? { partialOutput: args.partialOutput } : {}),
        });
      });

      const handle = {
        runToResult: vi.fn(
          () =>
            new Promise<{
              id: string;
              status: 'cancelled';
              error: Error;
              partialOutput?: unknown;
            }>((resolve) => {
              resolveRun = resolve;
            }),
        ),
        teardown: vi.fn(async () => undefined),
        cancel,
      };

      const manager = {
        forkSubagent: vi.fn(async () => handle),
      } as unknown as SubagentManager;

      return { handle, manager };
    }

    it('labels the thrown error with the timeout reason when timer fires', async () => {
      const { handle, manager } = makeBlockingHandle({
        id: 'fork-x',
        partialOutput: 'I was halfway through analysis',
      });

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [{ id: 'N', systemPrompt: 's', promptBuilder: () => 'p' }],
        edges: [],
        nodeTimeoutMs: 30,
      });

      expect(handle.cancel).toHaveBeenCalled();
      expect(result.failed).toHaveLength(1);
      const failedErr = result.failed[0]!.error as Error & {
        partialOutput?: unknown;
        subagentId?: string;
      };
      expect(failedErr.message).toContain('aborted');
      expect(failedErr.message).toContain('exceeded nodeTimeoutMs of 30ms');
      expect(failedErr.partialOutput).toBe('I was halfway through analysis');
      expect(failedErr.subagentId).toBe('fork-x');
    });

    it('preserves the inner error as .cause when wrapping a TimeoutError', async () => {
      const innerError = new Error('original inner failure');
      const { manager } = makeBlockingHandle({ error: innerError });

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [{ id: 'N', systemPrompt: 's', promptBuilder: () => 'p' }],
        edges: [],
        nodeTimeoutMs: 30,
      });

      const failedErr = result.failed[0]!.error as Error & { cause?: unknown };
      expect(failedErr.cause).toBe(innerError);
    });

    it('uses the original error message for non-timeout aborts', async () => {
      // Plain failure (no timeout reason on nodeSignal) keeps existing
      // behavior: the original error message flows through unchanged.
      pushHandle(new Error('regular failure'));
      const manager = managerFromQueue();

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [{ id: 'A', systemPrompt: 's', promptBuilder: () => 'p' }],
        edges: [],
      });

      expect(result.failed[0]!.error.message).toBe('regular failure');
      // No "aborted:" prefix from the timeout path.
      expect(result.failed[0]!.error.message).not.toContain('aborted');
    });

    it('omits the timeout label when nodeSignal aborts for a non-timeout reason', async () => {
      // Even if nodeTimeoutMs is configured, a failure that arrives via the
      // normal path (handle returns 'failed' on its own, before timer fires)
      // must NOT be wrongly labeled as a timeout.
      pushHandle(new Error('normal handle failure'));
      const manager = managerFromQueue();

      const result = await runSubagentDAG({
        manager,
        parentSession: makeParent(),
        nodes: [{ id: 'A', systemPrompt: 's', promptBuilder: () => 'p' }],
        edges: [],
        nodeTimeoutMs: 10_000,
      });

      expect(result.failed[0]!.error.message).toBe('normal handle failure');
      expect(result.failed[0]!.error.message).not.toContain('exceeded nodeTimeoutMs');
    });
  });
});
