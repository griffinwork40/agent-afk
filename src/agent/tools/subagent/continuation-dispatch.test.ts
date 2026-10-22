import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';

vi.mock('../../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn().mockResolvedValue(undefined) }));

import type { SubagentHandle, SubagentResult } from '../../subagent.js';
import { SubagentExecutor, type SubagentExecutorContext } from '../subagent-executor.js';
import { ContinuationRegistry } from '../../subagent/continuation-registry.js';
import { agentTool, composeTool } from '../schemas.agent-tools.js';
import { parseAgentInput } from './input-parse.js';
import { instrumentHandleForChain, annotateChainResult } from './continuation-dispatch.js';

const CAPPED = 'tool_use_loop_capped';

function cappedResult(): SubagentResult {
  return {
    id: 'child-1', status: 'succeeded',
    message: { role: 'assistant', content: 'partial work', timestamp: new Date() },
    stopReason: CAPPED, incomplete: true, incompleteReason: CAPPED as never, roundsUsed: 7, budget: 7,
  } as unknown as SubagentResult;
}

function handleFor(result: SubagentResult): Partial<SubagentHandle> {
  return {
    id: 'child-1', status: 'succeeded' as never,
    runToResult: vi.fn().mockResolvedValue(result),
    cancel: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    getLastStopInjectContext: vi.fn().mockReturnValue(undefined),
  };
}

function executorWith(handle: Partial<SubagentHandle>, registry: ContinuationRegistry | undefined): SubagentExecutor {
  const ctx: SubagentExecutorContext = {
    subagentManager: { forkSubagent: vi.fn().mockResolvedValue(handle) } as never,
    parentSession: { sessionId: 'root-1', getInputStreamRef: vi.fn(), abortSignal: new AbortController().signal } as never,
    defaultConfig: { apiKey: 'k', systemPrompt: 's' },
    depth: 0,
    cwd: tmpdir(),
    ...(registry !== undefined ? { continuationRegistry: registry } : {}),
  };
  return new SubagentExecutor(ctx);
}

const call = (input: Record<string, unknown>) => ({ id: 'c1', name: 'agent', input, signal: new AbortController().signal });

describe('continuation dispatch wiring', () => {
  it('D7: agent schema has continuation_chain_id; compose nodes do not', () => {
    const props = (agentTool.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props['continuation_chain_id']).toBeDefined();
    expect(JSON.stringify(composeTool.input_schema)).not.toContain('continuation_chain_id');
    expect(parseAgentInput({ prompt: 'x', continuation_chain_id: 'chain_ab' }).continuation_chain_id).toBe('chain_ab');
    expect(() => parseAgentInput({ prompt: 'x', continuation_chain_id: 3 })).toThrow();
  });

  it('D7 placeholder: a continuation call is refused and forks nothing', async () => {
    const handle = handleFor(cappedResult());
    const exec = executorWith(handle, new ContinuationRegistry());
    const r = await exec.execute(call({ prompt: 'go on', continuation_chain_id: 'chain_x' }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('continuation not yet wired');
    expect(handle.runToResult).not.toHaveBeenCalled();
  });

  it('D2/D6/D9 foreground: capped child gets a chain, line, metadata, terminal record', async () => {
    const registry = new ContinuationRegistry();
    const r = await executorWith(handleFor(cappedResult()), registry).execute(call({ prompt: 'work', max_tool_use_iterations: 7 }));
    const meta = (r as { continuation?: { chainId: string; roundsCharged: number; continuable: boolean } }).continuation;
    expect(meta?.chainId).toMatch(/^chain_[0-9a-f]+$/);
    expect(meta?.roundsCharged).toBe(7);
    expect(meta?.continuable).toBe(true);
    expect(r.content).toContain(`[continuation: chain_id=${meta!.chainId}, rounds 7/150 used`);
    const chain = registry.get(meta!.chainId)!;
    expect(chain.owner).toBe('root-1');
    expect(chain.inFlight).toBe(false);
    expect(chain.lastEndReason).toBe(CAPPED);
    expect(chain.checkpoint?.cwd).toBe(tmpdir()); // runtime cwd, non-git => git:false
  });

  it('D6: a completed child gets chain metadata but no continuation line', async () => {
    const ok = { id: 'child-1', status: 'succeeded', message: { role: 'assistant', content: 'done', timestamp: new Date() } } as SubagentResult;
    const r = await executorWith(handleFor(ok), new ContinuationRegistry()).execute(call({ prompt: 'work' }));
    expect((r as { continuation?: unknown }).continuation).toBeDefined();
    expect(r.content).not.toContain('[continuation:');
  });

  it('no registry wired: dispatch unchanged', async () => {
    const r = await executorWith(handleFor(cappedResult()), undefined).execute(call({ prompt: 'work' }));
    expect((r as { continuation?: unknown }).continuation).toBeUndefined();
    expect(r.content).not.toContain('[continuation:');
  });

  it('D9: uncapped initial charged at runtime rounds; rejection still clears in-flight', async () => {
    const registry = new ContinuationRegistry();
    const failing = handleFor(cappedResult());
    (failing.runToResult as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 0, inputs: { writeCapable: false } });
    instrumentHandleForChain(failing as never, { registry, chain, cwd: undefined, journalUsable: () => true });
    await expect((failing.runToResult as (p: string) => Promise<unknown>)('x')).rejects.toThrow('boom');
    expect(chain.inFlight).toBe(false);
    expect(chain.lastEndReason).toBe('failed');
    expect(chain.latestChildId).toBe('child-1');
  });

  it('D9 background: terminal callback updates the registry and appends the line to the delivered message', () => {
    const registry = new ContinuationRegistry();
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 0, inputs: { writeCapable: true } });
    let deliver!: (r: SubagentResult) => void;
    const handle = { id: 'bg-1', runToResult: vi.fn(), runInBackground: vi.fn((_p: unknown, cb: (r: SubagentResult) => void) => { deliver = cb; }) };
    instrumentHandleForChain(handle as never, { registry, chain, cwd: undefined, journalUsable: () => false });
    const onResult = vi.fn();
    (handle.runInBackground as unknown as (p: string, cb: (r: SubagentResult) => void) => void)('x', onResult);
    expect(chain.inFlight).toBe(true);
    const r = cappedResult();
    deliver(r);
    expect(chain.inFlight).toBe(false);
    expect(chain.roundsCharged).toBe(7);
    expect(chain.latestChildId).toBeUndefined(); // journal unusable keeps the previous link
    expect(onResult).toHaveBeenCalledWith(r);
    expect(r.message!.content).toContain(`chain_id=${chain.chainId}`);
  });

  it('D3/D6: worktree-isolated chains carry metadata marked not continuable and no line', () => {
    const registry = new ContinuationRegistry();
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 5, inputs: { writeCapable: true, isolation: 'worktree' } });
    const r = annotateChainResult({ content: 'x', incomplete: true, incompleteReason: CAPPED }, chain);
    expect(r.continuation?.continuable).toBe(false);
    expect(r.content).toBe('x');
  });
});
