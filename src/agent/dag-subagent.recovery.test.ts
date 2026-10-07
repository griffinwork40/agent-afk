import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSubagentDAG, type SubagentDAGNode } from './dag-subagent.js';
import type { SubagentManager } from './subagent.js';
import { createEmptyTrace, STREAM_INCOMPLETE, type SubagentResult } from './subagent/result.js';
import { buildAllowlistCanUseTool } from './tools/compose-agent-resolve.js';
import { isComposeReplaySafe, recoverDagNode } from './dag-subagent.recovery.js';
import type { TraceSink } from './trace/index.js';
import { runDAG } from './dag.js';
import { computeDAGHash, clearCheckpoint } from './dag-checkpoint.js';
import { SubagentHandleImpl } from './subagent/handle.js';
import { AbortGraph } from './abort-graph.js';
import type { IAgentSession, OutputEvent } from './types.js';
import { DelegationBudget } from './tools/delegation-budget.js';

class APIConnectionTimeoutError extends Error {}
const cut = (): SubagentResult => ({ id: 'cut', status: 'failed', error: new APIConnectionTimeoutError('connect timeout'), trace: createEmptyTrace() });
const success = (text = 'answer'): SubagentResult => ({ id: 'ok', status: 'succeeded', message: { role: 'assistant', content: text, timestamp: new Date() }, trace: createEmptyTrace() });
const node = (id: string): SubagentDAGNode => ({ id, systemPrompt: 'read only', promptBuilder: () => id,
  replaySafe: true, canUseTool: buildAllowlistCanUseTool(['read_file']) });
function manager(run: (id: string, prompt: unknown, signal: AbortSignal) => Promise<SubagentResult>) {
  const handles: Array<{ cancel: ReturnType<typeof vi.fn>; teardown: ReturnType<typeof vi.fn> }> = [];
  const fork = vi.fn(async (opts: { idPrefix: string }) => {
    const controller = new AbortController();
    const handle = { runToResult: vi.fn((prompt: unknown) => run(opts.idPrefix.replace('dag-', ''), prompt, controller.signal)),
      cancel: vi.fn(async () => { controller.abort(); }), teardown: vi.fn(async () => {}) };
    handles.push(handle);
    return handle;
  });
  return { instance: { forkSubagent: fork } as unknown as SubagentManager, fork, handles };
}
async function advance<T>(promise: Promise<T>, ms = 1100): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return promise;
}
afterEach(() => vi.useRealTimers());

describe('compose node recovery', () => {
  it('re-forks once and passes the output to downstream exactly once', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const m = manager(async (id, prompt) => {
      if (id === 'a') return ++attempts === 1 ? cut() : success('rescued');
      expect(prompt).toBe('rescued');
      return success('downstream');
    });
    const b = { ...node('b'), promptBuilder: (inputs: Record<string, unknown>) => String(inputs['a']) };
    const trace: TraceSink = { write: vi.fn(async () => {}), getTracePath: () => 'in-memory://trace' };
    const budget = new DelegationBudget({ maxTotalAgents: 8, maxConcurrentAgents: 8, maxConcurrentChildrenPerAgent: 8 });
    const result = await advance(runSubagentDAG({ manager: m.instance, parentSession: { sessionId: 'parent', abortSignal: new AbortController().signal },
      nodes: [node('a'), b], edges: [{ from: 'a', to: 'b' }], traceWriter: trace, delegationBudget: budget }));
    expect(result.failed).toEqual([]);
    expect(result.outputs).toEqual({ a: 'rescued', b: 'downstream' });
    expect(m.fork).toHaveBeenCalledTimes(3);
    expect(m.handles.every((h) => h.teardown.mock.calls.length === 1)).toBe(true);
    expect(trace.write).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ metadata: expect.objectContaining({ reason: 'redispatch', eligible: true }) }) }));
  });

  it.each(['write_file', 'bash', 'workspace_publish', 'web_request', 'agent'])('never replays a node that called %s', async (name) => {
    const failure = cut();
    failure.trace!.toolCalls.push({ id: 'tool', name });
    const m = manager(async () => failure);
    const trace: TraceSink = { write: vi.fn(async () => {}), getTracePath: () => 'in-memory://trace' };
    const result = await runSubagentDAG({ manager: m.instance, parentSession: { abortSignal: new AbortController().signal }, nodes: [node('a')], edges: [], traceWriter: trace });
    expect(result.failed).toHaveLength(1);
    expect(m.fork).toHaveBeenCalledTimes(1);
    expect(trace.write).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ metadata: expect.objectContaining({ eligible: false, reason: 'unsafe_or_missing_trace' }) }) }));
  });

  it.each(['partial', 'unsafe', 'missing', 'ordinary', 'cancelled'])('declines %s failures', async (kind) => {
    const failure = cut();
    if (kind === 'partial') failure.partialOutput = 'useful work';
    if (kind === 'missing') delete failure.trace;
    if (kind === 'ordinary') failure.error = new Error('bad schema');
    if (kind === 'cancelled') failure.status = 'cancelled';
    const m = manager(async () => failure);
    const result = await runSubagentDAG({ manager: m.instance, parentSession: { abortSignal: new AbortController().signal }, nodes: [{ ...node('a'), replaySafe: kind !== 'unsafe' }], edges: [] });
    expect(result.failed).toHaveLength(1);
    expect(m.fork).toHaveBeenCalledTimes(1);
  });

  it('preserves a successful buffered partial without retry', async () => {
    const m = manager(async () => ({ ...success('findings'), stopReason: STREAM_INCOMPLETE }));
    const result = await runSubagentDAG({ manager: m.instance, parentSession: { abortSignal: new AbortController().signal }, nodes: [node('a')], edges: [] });
    expect(result.partial).toEqual([{ id: 'a', stopReason: STREAM_INCOMPLETE }]);
    expect(String(result.outputs['a'])).toContain('findings');
    expect(m.fork).toHaveBeenCalledTimes(1);
  });

  it('makes a second transport failure final', async () => {
    vi.useFakeTimers();
    const m = manager(async () => cut());
    const result = await advance(runSubagentDAG({ manager: m.instance, parentSession: { abortSignal: new AbortController().signal }, nodes: [node('a')], edges: [] }));
    expect(result.failed).toHaveLength(1);
    expect(m.fork).toHaveBeenCalledTimes(2);
  });

  it.each(['parent', 'timeout', 'fail_fast'])('%s abort during retry delay prevents re-dispatch', async (mode) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const m = manager(async (id) => id === 'a' ? cut() : { ...cut(), error: new Error('hard failure') });
    const promise = runSubagentDAG({ manager: m.instance, parentSession: { abortSignal: parent.signal },
      nodes: mode === 'fail_fast' ? [node('a'), node('b')] : [node('a')], edges: [],
      ...(mode === 'timeout' ? { nodeTimeoutMs: 200 } : {}) });
    if (mode === 'parent') setTimeout(() => parent.abort(), 200);
    const result = await advance(promise);
    expect(result.failed.length).toBeGreaterThan(0);
    expect(m.fork).toHaveBeenCalledTimes(mode === 'fail_fast' ? 2 : 1);
  });

  it('propagates abort during the fresh attempt to its handle', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let attempts = 0;
    const m = manager(async (_id, _prompt, signal) => {
      if (++attempts === 1) return cut();
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ id: 'cancel', status: 'cancelled', trace: createEmptyTrace() }), { once: true }));
    });
    const promise = runSubagentDAG({ manager: m.instance, parentSession: { abortSignal: parent.signal }, nodes: [node('a')], edges: [] });
    await vi.advanceTimersByTimeAsync(1001);
    parent.abort();
    const result = await promise;
    expect(result.failed).toHaveLength(1);
    expect(m.handles[1]!.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not replay a completed recovered node on checkpoint resume', async () => {
    vi.useFakeTimers();
    const a = vi.fn();
    a.mockResolvedValueOnce(cut()).mockResolvedValueOnce(success('saved'));
    const graph = { nodes: [{ id: 'a', run: async (_inputs: unknown, signal: AbortSignal) =>
      (await recoverDagNode('a', a, signal, true)).message?.content },
      { id: 'b', run: vi.fn(async () => { throw new Error('later failure'); }) }], edges: [{ from: 'a', to: 'b' }] };
    const dagId = `compose-recovery-${Date.now()}`;
    try {
      const first = await advance(runDAG(graph, new AbortController().signal, { dagId }));
      expect(first.outputs['a']).toBe('saved');
      const resumed = await runDAG(graph, new AbortController().signal, { dagId });
      expect(resumed.outputs['a']).toBe('saved');
      expect(a).toHaveBeenCalledTimes(2);
      expect(computeDAGHash(graph)).toBeTruthy();
    } finally { await clearCheckpoint(dagId); }
  });

  it.each(['zero', 'write', 'partial', 'thinking'])('uses real handle signals for %s stream failures', async (mode) => {
    vi.useFakeTimers();
    const failedSession = {
      async *sendMessageStream(): AsyncGenerator<OutputEvent> {
        if (mode === 'write') yield { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'w', toolName: 'write_file', toolInput: '{}' } };
        if (mode === 'partial') yield { type: 'chunk', chunk: { type: 'content', content: 'real partial findings' } };
        if (mode === 'thinking') yield { type: 'chunk', chunk: { type: 'thinking', content: 'reasoning' } };
        yield { type: 'error', error: new APIConnectionTimeoutError('connect timeout') };
      },
      async close() {}, async interrupt() {},
    } as unknown as IAgentSession;
    const handle = new SubagentHandleImpl('real', failedSession, new AbortController(), new AbortGraph(), undefined, 5000, undefined, () => {});
    const first = await handle.runToResult('prompt');
    expect(first.trace).toBeDefined();
    if (mode === 'partial') expect(first.partialOutput).toBe('real partial findings');
    if (mode === 'write') expect(first.trace!.toolCalls[0]!.name).toBe('write_file');
    const dispatch = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(success());
    await advance(recoverDagNode('actual', dispatch, new AbortController().signal, true));
    expect(dispatch).toHaveBeenCalledTimes(mode === 'zero' ? 2 : 1);
    await handle.teardown();
  });

  it('charges the retry against the lifetime delegation budget', async () => {
    vi.useFakeTimers();
    const m = manager(async () => cut());
    const budget = new DelegationBudget({ maxTotalAgents: 1 });
    const result = await advance(runSubagentDAG({ manager: m.instance, parentSession: { abortSignal: new AbortController().signal }, nodes: [node('a')], edges: [], delegationBudget: budget }));
    expect(result.failed[0]!.error.message).toContain('delegation budget');
    expect(m.fork).toHaveBeenCalledTimes(1);
  });

  it('fails closed for unrestricted and mutating tool surfaces', () => {
    expect(isComposeReplaySafe(undefined)).toBe(false);
    for (const tool of ['bash', 'write_file', 'agent', 'workspace_publish', 'web_request']) expect(isComposeReplaySafe([tool])).toBe(false);
    expect(isComposeReplaySafe(['read_file', 'grep', 'web_scrape'])).toBe(true);
  });

  it('measures an injected seven-node wave before and after recovery', async () => {
    vi.useFakeTimers();
    async function wave(recovery: boolean) {
      const attempts = new Map<string, number>();
      let effects = 0;
      const m = manager(async (id) => {
        const count = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, count);
        if (id === '6') { effects++; return success('wrote once'); }
        return count === 1 ? cut() : success('recovered');
      });
      const start = Date.now();
      const nodes = Array.from({ length: 7 }, (_, i) => ({ ...node(String(i)), replaySafe: recovery && i !== 6 }));
      const promise = runSubagentDAG({ manager: m.instance, parentSession: { abortSignal: new AbortController().signal }, nodes, edges: [], failFast: false });
      let elapsed = 0;
      void promise.then(() => { elapsed = Date.now() - start; });
      const result = await advance(promise);
      return { completed: Object.keys(result.outputs).length, makespanMs: elapsed, effects, forks: m.fork.mock.calls.length };
    }
    const before = await wave(false);
    const after = await wave(true);
    expect(before).toEqual({ completed: 1, makespanMs: 0, effects: 1, forks: 7 });
    expect(after).toEqual({ completed: 7, makespanMs: 1000, effects: 1, forks: 13 });
    console.log('controlled seven-node wave', JSON.stringify({ before, after }));
  });
});
