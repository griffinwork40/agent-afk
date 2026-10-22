import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';

vi.mock('../../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn().mockResolvedValue(undefined) }));

import type { SubagentHandle, SubagentResult } from '../../subagent.js';
import { SubagentExecutor, type SubagentExecutorContext } from '../subagent-executor.js';
import { ContinuationRegistry } from '../../subagent/continuation-registry.js';
import { BackgroundAgentRegistry } from '../../background-registry.js';
import { agentTool, composeTool } from '../schemas.agent-tools.js';
import { parseAgentInput } from './input-parse.js';
import { instrumentHandleForChain, annotateChainResult, actorIdentity, JOURNAL_FLUSH_TIMEOUT_MS, markChainPromoted, recordChainTerminal } from './continuation-dispatch.js';
import { admitContinuationCall } from './continuation-run.js';

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
    defaultSubagentModel: 'sonnet',
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

  it('D3: a model-invented chain id is refused and forks nothing', async () => {
    const handle = handleFor(cappedResult());
    const exec = executorWith(handle, new ContinuationRegistry());
    const r = await exec.execute(call({ prompt: 'go on', continuation_chain_id: 'chain_x' }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('unknown continuation chain "chain_x"');
    expect(r.content).toContain('Nothing was forked');
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
    expect(chain.owner).toBe(registry.rootActor);
    await chain.settling; // journal flush + checkpoint settle after the result is returned
    expect(chain.inFlight).toBe(false);
    expect(chain.lastEndReason).toBe(CAPPED);
    expect(chain.checkpoint?.cwd).toBe(tmpdir()); // write-capable unnamed child: runtime cwd, non-git => git:false
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
    (failing as { _runtimeRoundsUsed?: number })._runtimeRoundsUsed = 3; // provider progress counted 3 rounds before the failure
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 0, inputs: { writeCapable: false } });
    instrumentHandleForChain(failing as never, { registry, chain, cwd: undefined, journalUsable: () => true });
    await expect((failing.runToResult as (p: string) => Promise<unknown>)('x')).rejects.toThrow('boom');
    expect(chain.roundsCharged).toBe(3); // uncapped initial: charged its runtime-counted rounds, even on rejection
    expect(chain.initialUncharged).toBe(false);
    await chain.settling;
    expect(chain.inFlight).toBe(false);
    expect(chain.lastEndReason).toBe('failed');
    expect(chain.latestChildId).toBe('child-1');
  });

  it('D9 background: terminal callback updates the registry and appends the line to the delivered message', async () => {
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
    expect(onResult).toHaveBeenCalledWith(r); // delivered at once, before bookkeeping settles
    await chain.settling;
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

  it('owner: the root continues its own chain when its session id was unassigned at mint', async () => {
    const registry = new ContinuationRegistry();
    const parentSession = { sessionId: undefined as string | undefined, getInputStreamRef: vi.fn(), abortSignal: new AbortController().signal };
    const ctx: SubagentExecutorContext = {
      subagentManager: { forkSubagent: vi.fn().mockResolvedValue({ ...handleFor(cappedResult()), session: { messageJournal: { length: 4 } } }) } as never,
      parentSession: parentSession as never,
      defaultConfig: { apiKey: 'k', systemPrompt: 's' }, defaultSubagentModel: 'sonnet', depth: 0, cwd: tmpdir(),
      continuationRegistry: registry,
    };
    const r = await new SubagentExecutor(ctx).execute(call({ prompt: 'work', max_tool_use_iterations: 7 }));
    const chainId = (r as { continuation?: { chainId: string } }).continuation!.chainId;
    const chain = registry.get(chainId)!;
    expect(chain.owner).toBe(registry.rootActor);
    expect(chain.owner).not.toBe('');
    parentSession.sessionId = 'root-1'; // provider assigned the id after the first turn
    const admitted = await admitContinuationCall(parseAgentInput({ prompt: 'more', continuation_chain_id: chainId }), { ...ctx, parentSession });
    // Ownership passes; the (mock) child wrote no journal, so seeding is what refuses.
    expect('error' in admitted && admitted.error.content).not.toMatch(/owned by another actor/);
    expect('error' in admitted && admitted.error.content).toMatch(/could not seed/);
    expect(chain.inFlight).toBe(false); // seed refusal rolled back
  });

  it('owner: a child cannot continue its parent\'s or a sibling\'s chain; identities are never empty', async () => {
    const registry = new ContinuationRegistry();
    const rootCtx = { depth: 0, continuationRegistry: registry, parentSession: { sessionId: undefined } };
    const childA = { depth: 1, continuationRegistry: registry, parentSession: { sessionId: 'sub-a' } };
    const childB = { depth: 1, continuationRegistry: registry, parentSession: { sessionId: 'sub-b' } };
    const anon = { depth: 1, continuationRegistry: registry, parentSession: { sessionId: undefined } };
    expect(actorIdentity(rootCtx)).toBe(registry.rootActor);
    expect(actorIdentity(childA)).toBe('subagent:sub-a');
    expect(actorIdentity(anon)).toBeUndefined();
    const mk = (owner: string) => {
      const c = registry.createChain({ owner, rootSessionId: 'r', roundCap: 5, inputs: { writeCapable: false } });
      registry.recordTerminal(c.chainId, { childId: 'c', journalUsable: true, roundsUsed: 5, checkpoint: undefined, endReason: CAPPED });
      return c.chainId;
    };
    const rootChain = mk(actorIdentity(rootCtx)!);
    const aChain = mk(actorIdentity(childA)!);
    const refuse = async (id: string, ctx: typeof rootCtx | typeof childA) => {
      const r = await admitContinuationCall(parseAgentInput({ prompt: 'x', continuation_chain_id: id }), ctx);
      return 'error' in r ? r.error.content : '';
    };
    expect(await refuse(rootChain, childA)).toMatch(/owned by another actor/); // child -> parent's chain
    expect(await refuse(aChain, childB)).toMatch(/owned by another actor/); // sibling
    expect(await refuse(aChain, anon)).toMatch(/has no identity/);
    expect(await refuse(aChain, rootCtx)).toMatch(/owned by another actor/); // parent -> child's chain
    expect(() => registry.createChain({ owner: '', rootSessionId: 'r', roundCap: 1, inputs: { writeCapable: false } })).toThrow();
  });

  it('D9 journal flush: terminal waits for the child journal to drain before advancing the link', async () => {
    const registry = new ContinuationRegistry();
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 5, inputs: { writeCapable: false } });
    let drain!: () => void;
    const flushJournal = vi.fn(() => new Promise<void>((res) => { drain = res; }));
    const h = handleFor(cappedResult());
    instrumentHandleForChain(h as never, { registry, chain, cwd: undefined, journalUsable: () => true, flushJournal });
    await (h.runToResult as (x: string) => Promise<unknown>)('x'); // the result does not wait for the flush
    await vi.waitFor(() => expect(flushJournal).toHaveBeenCalled());
    expect(chain.inFlight).toBe(true); // not cleared before the journal is on disk
    expect(chain.settling).toBeDefined();
    drain();
    await chain.settling;
    expect(chain.inFlight).toBe(false);
    expect(chain.latestChildId).toBe('child-1');
  });

  it('settling: an ordinary result is returned without waiting for a slow journal flush or checkpoint', async () => {
    const registry = new ContinuationRegistry();
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 5, inputs: { writeCapable: true } });
    let drain!: () => void;
    let checkpointDone!: (c: { cwd: string; git: boolean }) => void;
    const flushJournal = vi.fn(() => new Promise<void>((res) => { drain = res; }));
    const capture = vi.fn(() => new Promise<{ cwd: string; git: boolean }>((res) => { checkpointDone = res; }));
    const h = handleFor(cappedResult());
    instrumentHandleForChain(h as never, { registry, chain, cwd: tmpdir(), journalUsable: () => true, flushJournal, capture });
    const r = await (h.runToResult as (x: string) => Promise<SubagentResult>)('x');
    expect(r.incomplete).toBe(true); // resolved while flush + checkpoint are still pending
    expect(chain.inFlight).toBe(true);
    expect(chain.settling).toBeDefined();
    drain();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledWith(tmpdir()));
    expect(chain.inFlight).toBe(true); // checkpoint still running
    checkpointDone({ cwd: tmpdir(), git: false });
    await chain.settling;
    expect(chain.inFlight).toBe(false);
    expect(chain.latestChildId).toBe('child-1');
    expect(chain.settling).toBeUndefined();
  });

  it('D9 journal flush timeout: the previous link is kept and in-flight still clears', async () => {
    vi.useFakeTimers();
    try {
      const registry = new ContinuationRegistry();
      const chain = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 5, inputs: { writeCapable: false } });
      const h = handleFor(cappedResult());
      instrumentHandleForChain(h as never, { registry, chain, cwd: undefined, journalUsable: () => true, flushJournal: () => new Promise<void>(() => {}) });
      await (h.runToResult as (x: string) => Promise<unknown>)('x');
      await vi.advanceTimersByTimeAsync(JOURNAL_FLUSH_TIMEOUT_MS + 1);
      await chain.settling;
      expect(chain.inFlight).toBe(false);
      expect(chain.latestChildId).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('D6 promotion: the delivered capped result carries the line + metadata; the promotion payload stays valid JSON', async () => {
    const registry = new ContinuationRegistry();
    const bg = new BackgroundAgentRegistry({});
    let resolveRun!: (r: SubagentResult) => void;
    const handle = { ...handleFor(cappedResult()), id: 'child-1' };
    (handle.runToResult as ReturnType<typeof vi.fn>).mockReturnValue(new Promise<SubagentResult>((r) => { resolveRun = r; }));
    const exec = new SubagentExecutor({
      subagentManager: { forkSubagent: vi.fn().mockResolvedValue(handle) } as never,
      parentSession: { sessionId: 'root-1', getInputStreamRef: vi.fn(), abortSignal: new AbortController().signal } as never,
      defaultConfig: { apiKey: 'k', systemPrompt: 's' }, defaultSubagentModel: 'sonnet', depth: 0, cwd: tmpdir(),
      continuationRegistry: registry, backgroundRegistry: bg,
    });
    const pending = exec.execute(call({ prompt: 'long work', max_tool_use_iterations: 7 }));
    await new Promise((r) => setImmediate(r));
    const promoted = await exec.promoteActiveForeground();
    expect(promoted).toHaveLength(1);
    const payloadResult = await pending as ToolResultWithChain;
    const payload = JSON.parse(payloadResult.content as string) as { status: string };
    expect(payload.status).toBe('running');
    expect(payloadResult.continuation?.chainId).toMatch(/^chain_/);
    const delivered = cappedResult();
    resolveRun(delivered);
    await vi.waitFor(() => expect(bg.get(promoted[0]!.jobId)?.status).toBe('completed'));
    const chainId = payloadResult.continuation!.chainId;
    expect(delivered.message!.content).toContain(`[continuation: chain_id=${chainId}`);
    expect((delivered as ToolResultWithChain & SubagentResult).continuation?.chainId).toBe(chainId);
  });

  it('D6 promotion: a promoted continuation payload is never annotated in its text', () => {
    const registry = new ContinuationRegistry();
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 5, inputs: { writeCapable: false } });
    const handle = handleFor(cappedResult());
    instrumentHandleForChain(handle as never, { registry, chain, cwd: undefined, journalUsable: () => true, alwaysLine: true });
    markChainPromoted(handle);
    const text = JSON.stringify({ status: 'running', jobId: 'bg-1' });
    const r = annotateChainResult({ content: text }, chain, true, handle);
    expect(r.content).toBe(text);
    expect(() => JSON.parse(r.content as string)).not.toThrow();
    expect(r.continuation?.chainId).toBe(chain.chainId);
  });

  it('D4/D6: MAX_CONTINUATIONS=0 => no continuation line, not continuable, and a continuation is refused', async () => {
    vi.stubEnv('AFK_SUBAGENT_CONTINUATION_MAX_CONTINUATIONS', '0');
    try {
      const registry = new ContinuationRegistry();
      const r = await executorWith(handleFor(cappedResult()), registry).execute(call({ prompt: 'work', max_tool_use_iterations: 7 }));
      const meta = (r as ToolResultWithChain & { continuation?: { continuable: boolean } }).continuation!;
      expect(meta.continuable).toBe(false);
      expect(r.content).not.toContain('[continuation:');
      await registry.get(meta.chainId)!.settling;
      const admitted = registry.admitContinuation(meta.chainId, registry.rootActor, 5, 50);
      expect(admitted.ok).toBe(false);
      if (!admitted.ok) expect(admitted.reason).toMatch(/continuation limit reached \(0\/0\)/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('D6: an exhausted round budget suppresses the line', () => {
    const registry = new ContinuationRegistry({ maxRounds: 7, maxContinuations: 3 });
    const chain = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 7, inputs: { writeCapable: false } });
    const r = annotateChainResult({ content: 'x', incomplete: true, incompleteReason: CAPPED }, chain);
    expect(r.continuation?.continuable).toBe(false);
    expect(r.content).toBe('x');
  });


  it('D6 background: a COMPLETED background result carries the chain id structurally (no line)', async () => {
    const registry = new ContinuationRegistry();
    const bg = new BackgroundAgentRegistry({});
    const ok = { id: 'child-1', status: 'succeeded', message: { role: 'assistant', content: 'done', timestamp: new Date() } } as SubagentResult;
    const handle = { ...handleFor(ok), runInBackground: vi.fn((_p: string, cb?: (r: SubagentResult) => void) => { void Promise.resolve().then(() => cb?.(ok)); }) };
    const exec = new SubagentExecutor({
      subagentManager: { forkSubagent: vi.fn().mockResolvedValue(handle) } as never,
      parentSession: { sessionId: 'root-1', getInputStreamRef: vi.fn(), abortSignal: new AbortController().signal } as never,
      defaultConfig: { apiKey: 'k', systemPrompt: 's' }, defaultSubagentModel: 'sonnet', depth: 0, cwd: tmpdir(),
      continuationRegistry: registry, backgroundRegistry: bg,
    });
    const r = await exec.execute(call({ prompt: 'bg', mode: 'background' }));
    expect(r.isError, String(r.content)).not.toBe(true);
    const job = bg.list()[0]!;
    await vi.waitFor(() => expect(bg.get(job.jobId)?.status).toBe('completed'));
    const delivered = bg.get(job.jobId)!.result!;
    expect(delivered.continuation?.chainId).toMatch(/^chain_[0-9a-f]+$/);
    expect(delivered.continuation?.continuable).toBe(true);
    expect(delivered.message!.content).toBe('done'); // completed: metadata only, no line
  });


  it('D5: terminal checkpoint capture runs only for write-capable chains', async () => {
    const registry = new ContinuationRegistry();
    const capture = vi.fn(async (cwd: string) => ({ cwd, git: false }));
    const ro = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 5, inputs: { writeCapable: false } });
    await recordChainTerminal({ registry, chain: ro, childId: 'c', cwd: tmpdir(), roundsUsed: 1, journalUsable: true, endReason: 'x', capture });
    expect(capture).not.toHaveBeenCalled();
    expect(ro.checkpoint).toBeUndefined();
    const rw = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 5, inputs: { writeCapable: true } });
    await recordChainTerminal({ registry, chain: rw, childId: 'c', cwd: tmpdir(), roundsUsed: 1, journalUsable: true, endReason: 'x', capture });
    expect(capture).toHaveBeenCalledWith(tmpdir());
    expect(rw.checkpoint).toEqual({ cwd: tmpdir(), git: false });
    // A failing capture is fail-safe: the terminal still records, without a checkpoint.
    const rw2 = registry.createChain({ owner: 'o', rootSessionId: 'o', roundCap: 5, inputs: { writeCapable: true } });
    await recordChainTerminal({ registry, chain: rw2, childId: 'c', cwd: tmpdir(), roundsUsed: 1, journalUsable: true, endReason: 'x', capture: async () => { throw new Error('git'); } });
    expect(rw2.inFlight).toBe(false);
    expect(rw2.checkpoint).toEqual({ cwd: tmpdir(), git: true, unavailable: true }); // drift check fails closed
  });

});

type ToolResultWithChain = { content: unknown; continuation?: { chainId: string } };
