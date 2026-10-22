/**
 * D8 executor-level continuation tests (docs/subagent-continuation.md).
 * Real wireExecutors / SubagentManager / AgentSession / message journal; only
 * the model transport is faked. The fake journals only its own run through the
 * real anthropic-direct session state (createSessionState + JournalSync), so the
 * seeded history reaches each child's journal via the provider's own
 * resumeMessages seeding, and records what every provider query received.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProvider } from '../../provider.js';
import type { ChildProviderFactoryArgs } from '../nesting.js';
import type { AgentConfig } from '../../types.js';
import type { JournalMessage } from '../../journal/types.js';

const transport = vi.hoisted(() => ({ build: undefined as unknown as (args: ChildProviderFactoryArgs) => ModelProvider }));
vi.mock('../nesting.js', async (original) => ({
  ...await original<typeof import('../nesting.js')>(),
  createChildProviderFactory: () => (args: ChildProviderFactoryArgs) => transport.build(args),
}));
vi.mock('../../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn().mockResolvedValue(undefined) }));

import { wireExecutors } from '../../session/wire-executors.js';
import { AgentSession } from '../../session.js';
import { createMockProvider } from '../../__fixtures__/mock-provider.js';
import { BackgroundAgentRegistry } from '../../background-registry.js';
import { BgJobLogWriter } from '../../bg-job-log.js';
import type { ContinuationRegistry } from '../../subagent/continuation-registry.js';
import type { ToolResult } from '../types.js';
import { InMemoryTraceWriter } from '../../trace/writer.js';
import { getSessionsDir } from '../../../paths.js';
import type OpenAI from 'openai';
import { OpenAICompatibleProvider } from '../../providers/openai-compatible/index.js';
import { __setOpenAIClientFactory } from '../../providers/openai-compatible/query/client.js';
import { INTERRUPTED_TOOL_RESULT } from '../../providers/openai-compatible/journal-adapter.js';
import { createSessionState } from '../../providers/anthropic-direct/query/session-state.js';
import { anthropicJournalAdapter } from '../../providers/anthropic-direct/journal-adapter.js';

interface Seen { resumeMessages: JournalMessage[] | undefined; turn: string; config: AgentConfig }

const text = (t: string): { type: 'text'; text: string } => ({ type: 'text', text: t });

/** Fake transport: every child runs one capped round (tool_use + tool_result) and journals it. */
function installTransport(seen: Seen[], opts: { hold?: Promise<void>; cutFrom?: number; builds?: { n: number }; progressRounds?: number } = {}): void {
  let n = 0;
  transport.build = (args) => {
    const index = n++;
    if (opts.builds !== undefined) opts.builds.n++;
    if (opts.cutFrom !== undefined && index >= opts.cutFrom) {
      // Zero-output stream cut: the model stream ends with no assistant output.
      const dead = createMockProvider({ sessionId: `child-${index}` });
      return { ...dead, query(queryArgs) { const q = dead.query(queryArgs); return { ...q, async *[Symbol.asyncIterator]() { /* cut */ } }; } };
    }
    const base = createMockProvider({ sessionId: `child-${index}` });
    return {
      ...base,
      query(queryArgs) {
        const q = base.query(queryArgs);
        const cfg = queryArgs.config;
        return {
          ...q,
          async *[Symbol.asyncIterator]() {
            for await (const event of q) {
              if (event.type === 'assistant.message') {
                // Provider loops emit one progress event per completed tool round (capped or not).
                for (let r = 1; r <= (opts.progressRounds ?? 0); r++) {
                  yield { type: 'progress', progress: { taskId: 't', description: 'Working', roundsUsed: r, totalTokens: 0, toolUses: r, durationMs: 1 } };
                }
                if (opts.hold !== undefined) await opts.hold;
                const turn = seen.length; // unique per run
                const userText = String(event.text).replace(/^Echo: /, '');
                seen.push({ resumeMessages: cfg.resumeMessages, turn: userText, config: cfg });
                const id = `tu-${turn}`;
                // The REAL anthropic-direct seeding path: initialMessages from
                // resumeMessages (provider-query-build) -> createSessionState,
                // whose JournalSync.seed() writes the seeded history into the
                // child's journal. The fake only appends THIS run's messages.
                const state = createSessionState({
                  model: 'claude-sonnet-4-5', permissionMode: 'default', userSystem: null, toolDispatcher: {} as never,
                  ...(cfg.resumeMessages !== undefined && cfg.resumeMessages.length > 0
                    ? { initialMessages: anthropicJournalAdapter.fromJournalMessages(cfg.resumeMessages) } : {}),
                  ...(cfg.messageJournal !== undefined ? { messageJournal: cfg.messageJournal } : {}),
                });
                state.messages.push(
                  { role: 'user', content: [text(userText)] },
                  { role: 'assistant', content: [text(`run ${turn}`), { type: 'tool_use', id, name: 'bash', input: { command: `step ${turn}` } }] },
                  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [text(`out ${turn}`)] }] },
                  { role: 'assistant', content: [text(`wind-down ${turn}`)] },
                );
                state.journalSync.sync(state.messages);
              }
              if (event.type === 'turn.completed' && opts.progressRounds === undefined) event.usage = { ...event.usage, stopReason: 'tool_use_loop_capped' };
              yield event;
            }
          },
        };
      },
    };
  };
}

async function setup(extra: { backgroundRegistry?: BackgroundAgentRegistry; traceWriter?: InMemoryTraceWriter } = {}) {
  const session = new AgentSession({ model: 'sonnet', apiKey: 'test-key', provider: createMockProvider() });
  await session.waitForInitialization();
  await session.sendMessage?.('hello').catch(() => undefined);
  const wired = wireExecutors({
    surface: 'cli', parentSession: session, apiKey: 'test-key', model: 'sonnet', managerParentModel: 'sonnet',
    defaultSubagentModel: 'sonnet', resolveApiKeyForModel: () => 'test-key', pluginConfigs: [],
    ...(extra.backgroundRegistry !== undefined ? { backgroundRegistry: extra.backgroundRegistry } : {}),
    ...(extra.traceWriter !== undefined ? { traceWriter: extra.traceWriter, skillTraceWriter: extra.traceWriter } : {}),
  });
  const registry = (wired.subagentExecutor as unknown as { ctx: { continuationRegistry: ContinuationRegistry } }).ctx.continuationRegistry;
  let c = 0;
  const run = (input: Record<string, unknown>, signal = new AbortController().signal): Promise<ToolResult & { continuation?: { chainId: string } }> =>
    wired.subagentExecutor.execute({ id: `call-${c++}`, name: 'agent', signal, input });
  return { session, wired, registry, run };
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); __setOpenAIClientFactory(null); });

describe('D8 continuation through the agent executor', () => {
  it('two-link chain resumes full history, then refuses at the continuation limit', async () => {
    vi.stubEnv('AFK_SUBAGENT_CONTINUATION_MAX_CONTINUATIONS', '2');
    const seen: Seen[] = [];
    installTransport(seen);
    const { registry, run, session } = await setup();
    const first = await run({ prompt: 'initial task', max_tool_use_iterations: 5 });
    const chainId = first.continuation!.chainId;
    expect(first.content).toContain(`[continuation: chain_id=${chainId}`);
    expect(registry.get(chainId)!.latestChildId).toBeDefined();

    const second = await run({ prompt: 'keep going', continuation_chain_id: chainId, max_tool_use_iterations: 7 });
    expect(second.isError, second.content).not.toBe(true);
    const s1 = seen[1]!;
    expect(s1.resumeMessages?.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(s1.resumeMessages)).toContain('"toolUseId":"tu-0"');
    expect(s1.turn).toMatch(/^\[Continuation 1 of chain chain_[0-9a-f]+: your previous run ended \(tool_use_loop_capped\)\. You have 7 tool-use rounds for this run\.\]\n\nkeep going$/);
    expect(s1.config.autoCompact).toBe(true);
    expect(s1.config.maxToolUseIterations).toBe(7);
    expect(seen[0]!.config.autoCompact).toBeUndefined();
    expect(second.content).toContain(`[continuation: chain_id=${chainId}, rounds 12/150 used, continuations 1/2 used`);
    expect(second.continuation!.chainId).toBe(chainId); // same chain, not a new mint

    await run({ prompt: 'and more', continuation_chain_id: chainId, max_tool_use_iterations: 3 });
    const s2 = seen[2]!;
    const twoLink = JSON.stringify(s2.resumeMessages);
    expect(twoLink).toContain('"toolUseId":"tu-0"'); // history from run 1
    expect(twoLink).toContain('"toolUseId":"tu-1"'); // and run 2
    expect(s2.resumeMessages).toHaveLength(8);
    // No seed session is written: nothing chain-named appears where sessions are listed.
    const sessions = existsSync(getSessionsDir()) ? readdirSync(getSessionsDir()) : [];
    expect(sessions.filter((d) => d.startsWith('chain_'))).toEqual([]);

    const refused = await run({ prompt: 'again', continuation_chain_id: chainId });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('continuation limit reached (2/2)');
    expect(seen).toHaveLength(3);
    expect(registry.get(chainId)!.inFlight).toBe(false);
    await session.close();
  }, 20000);

  it('round limit: allowance clipped to the remainder, then refused', async () => {
    vi.stubEnv('AFK_SUBAGENT_CONTINUATION_MAX_ROUNDS', '8');
    const seen: Seen[] = [];
    installTransport(seen);
    const { run, session } = await setup();
    const first = await run({ prompt: 'initial', max_tool_use_iterations: 5 });
    const chainId = first.continuation!.chainId;
    await run({ prompt: 'more', continuation_chain_id: chainId, max_tool_use_iterations: 50 });
    expect(seen[1]!.config.maxToolUseIterations).toBe(3);
    const refused = await run({ prompt: 'more', continuation_chain_id: chainId });
    expect(refused.content).toContain('aggregate round limit reached (8/8)');
    await session.close();
  }, 20000);

  it('override conflict and model-invented ids are refused before any fork', async () => {
    const seen: Seen[] = [];
    installTransport(seen);
    const { run, session } = await setup();
    const first = await run({ prompt: 'initial', max_tool_use_iterations: 5 });
    const chainId = first.continuation!.chainId;
    const conflict = await run({ prompt: 'x', continuation_chain_id: chainId, model: 'haiku' });
    expect(conflict.content).toContain('continuation inherits model from the chain');
    const invented = await run({ prompt: 'x', continuation_chain_id: 'chain_deadbeef' });
    expect(invented.content).toContain('unknown continuation chain');
    expect(seen).toHaveLength(1);
    await session.close();
  }, 20000);

  it('drift: refused for a write-capable chain, allowed once the chain is read-only', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'afk-cont-drift-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
    git('init', '-q'); git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init');
    const seen: Seen[] = [];
    installTransport(seen);
    const { run, registry, session } = await setup();
    const first = await run({ prompt: 'initial', max_tool_use_iterations: 5, cwd: repo });
    const chainId = first.continuation!.chainId;
    await registry.get(chainId)!.settling;
    expect(registry.get(chainId)!.checkpoint?.git).toBe(true);
    writeFileSync(join(repo, 'new.txt'), 'drift');
    const refused = await run({ prompt: 'go', continuation_chain_id: chainId });
    expect(refused.content).toContain('workspace drifted');
    expect(refused.content).toContain('uncommitted changes');
    registry.get(chainId)!.inputs.writeCapable = false; // read-only chains skip the check
    const ok = await run({ prompt: 'go', continuation_chain_id: chainId });
    expect(ok.isError, ok.content).not.toBe(true);
    await session.close();
  }, 20000);

  it('concurrent continuation: exactly one is admitted', async () => {
    const seen: Seen[] = [];
    installTransport(seen);
    const { run, session } = await setup();
    const first = await run({ prompt: 'initial', max_tool_use_iterations: 5 });
    const chainId = first.continuation!.chainId;
    const [a, b] = await Promise.all([
      run({ prompt: 'a', continuation_chain_id: chainId }),
      run({ prompt: 'b', continuation_chain_id: chainId }),
    ]);
    const errors = [a, b].filter((r) => r.isError === true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.content).toContain('still in flight');
    await session.close();
  }, 20000);

  it('settling: a continuation issued right after the result waits for the slow journal flush, then succeeds with the full history', async () => {
    const seen: Seen[] = [];
    installTransport(seen);
    const { JournalFileWriter } = await import('../../journal/journal-file.js');
    const origFlush = JournalFileWriter.prototype.flush;
    let delayed = 0;
    vi.spyOn(JournalFileWriter.prototype, 'flush').mockImplementation(async function (this: InstanceType<typeof JournalFileWriter>) {
      delayed++;
      await new Promise((r) => setTimeout(r, 300));
      return origFlush.call(this);
    });
    const { run, registry, session } = await setup();
    const first = await run({ prompt: 'initial', max_tool_use_iterations: 5 });
    const chainId = first.continuation!.chainId;
    const chain = registry.get(chainId)!;
    expect(chain.settling).toBeDefined(); // result delivered while the flush is still pending
    expect(chain.inFlight).toBe(true);
    const second = await run({ prompt: 'immediately', continuation_chain_id: chainId });
    expect(second.isError, second.content).not.toBe(true);
    expect(delayed).toBeGreaterThan(0);
    expect(seen[1]!.resumeMessages?.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    await session.close();
  }, 20000);

  it('construction failure rolls back the charge and in-flight', async () => {
    const seen: Seen[] = [];
    installTransport(seen);
    const { run, registry, session, wired } = await setup();
    const first = await run({ prompt: 'initial', max_tool_use_iterations: 5 });
    const chainId = first.continuation!.chainId;
    vi.spyOn(wired.rootManager, 'forkSubagent').mockRejectedValueOnce(new Error('construction boom'));
    const r = await run({ prompt: 'go', continuation_chain_id: chainId, max_tool_use_iterations: 4 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('construction boom');
    const chain = registry.get(chainId)!;
    expect(chain.inFlight).toBe(false);
    expect(chain.continuations).toBe(0);
    expect(chain.roundsCharged).toBe(5);
    await session.close();
  }, 20000);

  it('abort mid-continuation clears in-flight and keeps the charge', async () => {
    const seen: Seen[] = [];
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    installTransport(seen);
    const { run, registry, session } = await setup();
    const first = await run({ prompt: 'initial', max_tool_use_iterations: 5 });
    const chainId = first.continuation!.chainId;
    installTransport(seen, { hold });
    const ac = new AbortController();
    const pending = run({ prompt: 'go', continuation_chain_id: chainId, max_tool_use_iterations: 4 }, ac.signal);
    await vi.waitFor(() => expect(registry.get(chainId)!.continuations).toBe(1));
    ac.abort();
    release();
    await pending;
    const chain = registry.get(chainId)!;
    await chain.settling;
    expect(chain.inFlight).toBe(false);
    expect(chain.roundsCharged).toBe(9);
    expect(chain.continuations).toBe(1);
    await session.close();
  }, 20000);

  it('D4: an uncapped initial run (no max_tool_use_iterations) is charged its runtime-counted rounds', async () => {
    const seen: Seen[] = [];
    installTransport(seen, { progressRounds: 4 });
    const { registry, run, session } = await setup();
    const first = await run({ prompt: 'uncapped work' });
    expect(first.isError, first.content).not.toBe(true);
    expect(seen[0]!.config.maxToolUseIterations ?? 0).toBe(0); // genuinely uncapped
    const chain = registry.get(first.continuation!.chainId)!;
    expect(chain.initialUncharged).toBe(false);
    expect(chain.roundsCharged).toBe(4);
    await session.close();
  }, 20000);

  it('background dispatch with a continuation registry still pipes progress into the BackgroundAgentRegistry', async () => {
    const seen: Seen[] = [];
    installTransport(seen);
    const bg = new BackgroundAgentRegistry();
    const { run, session } = await setup({ backgroundRegistry: bg });
    const write = vi.spyOn(BgJobLogWriter.prototype, 'write');
    const r = await run({ prompt: 'bg ordinary', mode: 'background' });
    expect(r.isError, r.content).not.toBe(true);
    const job = bg.list()[0]!;
    await vi.waitFor(() => expect(bg.get(job.jobId)!.status).not.toBe('running'), { timeout: 5000 });
    // The instrumented runToResult must forward runInBackground's sink override:
    // every progress event reaches the registry's onProgress -> job log writer.
    expect(write).toHaveBeenCalled();
    await session.close();
  }, 20000);

  it('background continuation updates the same chain on terminal', async () => {
    const seen: Seen[] = [];
    installTransport(seen);
    const bg = new BackgroundAgentRegistry();
    const { run, registry, session } = await setup({ backgroundRegistry: bg });
    const first = await run({ prompt: 'initial', max_tool_use_iterations: 5 });
    const chainId = first.continuation!.chainId;
    const before = registry.get(chainId)!.latestChildId;
    const r = await run({ prompt: 'bg go', continuation_chain_id: chainId, mode: 'background' });
    expect(r.isError, r.content).not.toBe(true);
    await vi.waitFor(() => expect(registry.get(chainId)!.inFlight).toBe(false), { timeout: 5000 });
    const chain = registry.get(chainId)!;
    expect(chain.latestChildId).not.toBe(before);
    expect(chain.continuations).toBe(1);
    await session.close();
  }, 20000);

  it('stuck-chain: an attachment error after the fork clears in-flight', async () => {
    const seen: Seen[] = [];
    installTransport(seen);
    const { run, registry, session } = await setup();
    const r = await run({ prompt: 'initial', attachments: [join(tmpdir(), 'afk-missing-attachment.png')] });
    expect(r.isError).toBe(true);
    const chains = [...(registry as unknown as { chains: Map<string, { inFlight: boolean }> }).chains.values()];
    expect(chains.length).toBe(1);
    expect(chains[0]!.inFlight).toBe(false);
    await session.close();
  }, 20000);

  it('stuck-chain: background dispatch with no registry clears in-flight', async () => {
    const seen: Seen[] = [];
    installTransport(seen);
    const { run, registry, session } = await setup();
    const r = await run({ prompt: 'initial', mode: 'background' });
    expect(r.isError).toBe(true);
    const chains = [...(registry as unknown as { chains: Map<string, { inFlight: boolean }> }).chains.values()];
    expect(chains.every((c) => !c.inFlight)).toBe(true);
    await session.close();
  }, 20000);

  it('non-owner and worktree-isolated chains are refused before any fork', async () => {
    const seen: Seen[] = [];
    installTransport(seen);
    const { run, registry, session } = await setup();
    const foreign = registry.createChain({ owner: 'someone-else', rootSessionId: 'x', roundCap: 5, inputs: { writeCapable: false } });
    registry.recordTerminal(foreign.chainId, { childId: 'c', journalUsable: true, roundsUsed: 5, checkpoint: undefined, endReason: 'capped' });
    expect((await run({ prompt: 'x', continuation_chain_id: foreign.chainId })).content).toContain('owned by another actor');
    const owner = registry.rootActor;
    const iso = registry.createChain({ owner, rootSessionId: 'x', roundCap: 5, inputs: { writeCapable: true, isolation: 'worktree' } });
    registry.recordTerminal(iso.chainId, { childId: 'c', journalUsable: true, roundsUsed: 5, checkpoint: undefined, endReason: 'capped' });
    expect((await run({ prompt: 'x', continuation_chain_id: iso.chainId })).content).toContain('`isolation: "worktree"` chain is not supported');
    expect(seen).toHaveLength(0);
    await session.close();
  }, 20000);

  it('stream-cut retry: a continuation is never re-dispatched (no second charge, count, or fork)', async () => {
    const seen: Seen[] = [];
    // Control: a read-only INITIAL dispatch whose stream is cut IS re-forked once.
    const control = { n: 0 };
    installTransport(seen, { cutFrom: 0, builds: control });
    const { run, registry, session } = await setup();
    const cut = await run({ prompt: 'initial', agent_type: 'Explore', max_tool_use_iterations: 5 });
    expect(cut.isError).toBe(true);
    expect(control.n).toBe(2);

    const builds = { n: 0 };
    installTransport(seen, { cutFrom: 1, builds });
    const first = await run({ prompt: 'initial', agent_type: 'Explore', max_tool_use_iterations: 5 });
    const chainId = first.continuation!.chainId;
    const r = await run({ prompt: 'go', continuation_chain_id: chainId, max_tool_use_iterations: 4 });
    expect(r.isError).toBe(true);
    expect(r.incompleteReason).toBe('stream_incomplete');
    expect(builds.n).toBe(2); // initial + ONE continuation fork, no re-dispatch
    const chain = registry.get(chainId)!;
    expect(chain.continuations).toBe(1);
    expect(chain.roundsCharged).toBe(9);
    expect(chain.inFlight).toBe(false);
    await session.close();
  }, 20000);

  it('openai-compatible continuation: resumeMessages honored, dangling tool call answered', async () => {
    // Link 1 (fake transport) ends mid tool round: its journal holds an
    // assistant tool_use with NO tool_result (the shape an abort leaves).
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    const requests: Array<Array<{ role: string; tool_call_id?: string; tool_calls?: Array<{ id: string }>; content?: unknown }>> = [];
    __setOpenAIClientFactory(() => ({
      chat: { completions: { create: async (args: { messages: (typeof requests)[number] }) => {
        requests.push(args.messages);
        return (async function* () {
          yield { choices: [{ delta: { content: 'resumed ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        })();
      } } },
    }) as unknown as OpenAI);
    let n = 0;
    transport.build = (args) => {
      if (n++ > 0) {
        return new OpenAICompatibleProvider({ permissions: { allowedTools: args.allowedTools ?? [] }, subagentExecutor: args.childExecutor, readOnlyState: true });
      }
      const base = createMockProvider({ sessionId: 'child-0' });
      return { ...base, query(queryArgs) {
        const q = base.query(queryArgs);
        const cfg = queryArgs.config;
        return { ...q, async *[Symbol.asyncIterator]() {
          for await (const event of q) {
            if (event.type === 'assistant.message') {
              const msgs: JournalMessage[] = [
                { role: 'user', content: [text('initial')] },
                { role: 'assistant', content: [text('looking'), { type: 'tool_use', id: 'call_dangling', name: 'read_file', input: { file_path: '/x' } }] },
              ];
              msgs.forEach((m, i) => cfg.messageJournal?.append(i, m));
              await cfg.messageJournal?.flush();
            }
            if (event.type === 'turn.completed') event.usage = { ...event.usage, stopReason: 'tool_use_loop_capped' };
            yield event;
          }
        } };
      } };
    };
    const { run, session } = await setup();
    const first = await run({ prompt: 'initial', model: 'gpt-4o-mini', max_tool_use_iterations: 5 });
    const chainId = first.continuation!.chainId;
    const r = await run({ prompt: 'keep going', continuation_chain_id: chainId });
    expect(r.isError, r.content).not.toBe(true);
    expect(r.content).toContain('resumed ok');
    expect(requests).toHaveLength(1);
    const msgs = requests[0]!;
    // resumeMessages honored: the prior link's turn precedes the new prompt.
    const flat = JSON.stringify(msgs);
    expect(flat).toContain('initial');
    expect(flat).toContain('keep going');
    const calls = msgs.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : []));
    expect(calls).toContain('call_dangling');
    for (const id of calls) {
      const answer = msgs.find((m) => m.role === 'tool' && m.tool_call_id === id);
      expect(answer, `tool_call ${id} has no role:'tool' answer`).toBeDefined();
    }
    const dangling = msgs.find((m) => m.role === 'tool' && m.tool_call_id === 'call_dangling')!;
    expect(dangling.content).toBe(INTERRUPTED_TOOL_RESULT);
    // Ordering: the synthetic answer sits right after its assistant message.
    const ai = msgs.findIndex((m) => m.role === 'assistant' && (m.tool_calls ?? []).some((c) => c.id === 'call_dangling'));
    expect(msgs[ai + 1]).toBe(dangling);
    await session.close();
  }, 20000);

  it('D10: the continuation started event carries chainId / continuationOf / continuationIndex', async () => {
    const seen: Seen[] = [];
    installTransport(seen);
    const writer = new InMemoryTraceWriter();
    const { run, registry, session } = await setup({ traceWriter: writer });
    const first = await run({ prompt: 'initial', max_tool_use_iterations: 5 });
    const chainId = first.continuation!.chainId;
    const prev = registry.get(chainId)!.latestChildId;
    await run({ prompt: 'go', continuation_chain_id: chainId });
    const started = writer.events.filter((e) => e.kind === 'subagent_lifecycle' && (e.payload as { transition: string }).transition === 'started')
      .map((e) => e.payload as { chainId?: string; continuationOf?: string; continuationIndex?: number });
    expect(started).toHaveLength(2);
    expect(started[0]!.chainId).toBeUndefined();
    expect(started[1]).toMatchObject({ chainId, continuationOf: prev, continuationIndex: 1 });
    await session.close();
  }, 20000);
});
