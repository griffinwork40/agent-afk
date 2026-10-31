import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type OpenAI from 'openai';
import { __setOpenAIClientFactory } from './query.js';
import type { OpenAIChunk } from './translate.js';
import { createChildProviderFactory } from '../../tools/nesting.js';
import type { SubagentExecutor } from '../../tools/subagent-executor.js';
import { SubagentManager } from '../../subagent.js';
import type { SubagentHandleImpl } from '../../subagent/handle.js';
import { WorkspaceStore } from '../../workspace/workspace-store.js';
import { WORKSPACE_DELIVERY_RING_CAPACITY } from '../../workspace/workspace-subscription-constants.js';

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
const subscribe: OpenAIChunk[] = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'sub1', type: 'function', function: { name: 'workspace_subscribe', arguments: '{"subject":"auth","type":"finding"}' } }] }, finish_reason: null }] } as OpenAIChunk,
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage } as OpenAIChunk,
];
const done = [{ choices: [{ delta: { content: 'finished' }, finish_reason: 'stop' }], usage }] as OpenAIChunk[];
async function* chunks(values: OpenAIChunk[]) { for (const c of values) yield c; }
function publish(store: WorkspaceStore, content: string, subject = 'auth', type: 'finding' | 'status' = 'finding') {
  store.publish({ session_id: 'parent', agent_id: 'sibling', subject, type, content });
}
let store: WorkspaceStore;
let manager: SubagentManager;
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'afk-oai-subscribe-life-'));
  vi.stubEnv('AFK_HOME', join(cwd, 'home'));
  store = new WorkspaceStore();
  manager = new SubagentManager({ cwd, workspaceStore: store });
});
afterEach(async () => {
  await manager.teardownAll();
  __setOpenAIClientFactory(null);
  store.close();
  vi.unstubAllEnvs();
});
async function fork() {
  const provider = createChildProviderFactory({ workspaceStore: store })({ model: 'gpt-4o-mini', childExecutor: {} as SubagentExecutor });
  return await manager.forkSubagent({
    parent: { sessionId: 'parent' }, agentType: 'subscription-parity',
    config: { provider, model: 'gpt-4o-mini', apiKey: 'test-key', depth: 1, maxDepth: 3, cwd },
  }) as SubagentHandleImpl<unknown>;
}

describe('OpenAI fork workspace subscription lifecycle (#1418)', () => {
  it('pushes filtered bounded FIFO deliveries at the next boundary and cleans up on completed-child teardown', async () => {
    let request = 0;
    const messages: string[] = [];
    __setOpenAIClientFactory(() => ({ chat: { completions: { create: async (args: { messages: unknown; tools: unknown }) => {
      request++;
      messages.push(JSON.stringify(args.messages));
      expect(JSON.stringify(args.tools)).toContain('workspace_subscribe');
      if (request === 1) return chunks(subscribe);
      if (request === 2) {
        // Registration happened in the real dispatcher. A sibling publishes while
        // the child is still in its tool loop; no workspace_query or timer polling.
        publish(store, 'FILTERED_SUBJECT', 'billing');
        publish(store, 'FILTERED_TYPE', 'auth', 'status');
        for (let i = 0; i < WORKSPACE_DELIVERY_RING_CAPACITY + 2; i++) publish(store, `ENTRY_${i}_END`);
        return chunks([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'query1', type: 'function', function: { name: 'get_runtime_state', arguments: '{"view":"self"}' } }] }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }] as OpenAIChunk[]);
      }
      return chunks(done);
    } } } }) as unknown as OpenAI);
    const handle = await fork();
    const unsubscribe = vi.spyOn(store, 'unsubscribeAll');
    await handle.run('Subscribe to auth findings and continue working.');
    expect(request).toBe(3);
    expect(messages[1]).toContain('subscriptionId');
    expect(messages[2]).toContain('<workspace-delivery');
    expect(messages[2]).toContain('dropped=\\"2\\"');
    expect(messages[2]).not.toContain('FILTERED_');
    expect(messages[2]).not.toContain('ENTRY_0_END');
    expect(messages[2]).not.toContain('ENTRY_1_END');
    expect(messages[2]!.indexOf('ENTRY_2_END')).toBeLessThan(messages[2]!.indexOf('ENTRY_3_END'));
    expect(handle._pendingWorkspaceEntries).toHaveLength(0);
    await handle.teardown();
    expect(unsubscribe).toHaveBeenCalledWith(handle.id);
    publish(store, 'AFTER_TEARDOWN');
    expect(handle._pendingWorkspaceEntries).toHaveLength(0);
    // Child close must not close the caller-owned store.
    expect(store.queryRelevant(null, 'AFTER_TEARDOWN')).toHaveLength(1);
  });

  it('unsubscribes a cancelled in-flight OpenAI child', async () => {
    let ready!: () => void;
    const atSecondRequest = new Promise<void>((resolve) => { ready = resolve; });
    let request = 0;
    __setOpenAIClientFactory(() => ({ chat: { completions: { create: async (_args: unknown, opts: { signal: AbortSignal }) => {
      if (++request === 1) return chunks(subscribe);
      ready();
      return await new Promise<never>((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    } } } }) as unknown as OpenAI);
    const handle = await fork();
    const unsubscribe = vi.spyOn(store, 'unsubscribeAll');
    const run = handle.run('Subscribe and continue.').catch(() => undefined);
    await atSecondRequest;
    publish(store, 'BEFORE_CANCEL');
    expect(handle._pendingWorkspaceEntries).toHaveLength(1);
    await handle.cancel();
    await run;
    expect(handle.status).toBe('cancelled');
    expect(unsubscribe).toHaveBeenCalledWith(handle.id);
    const pending = handle._pendingWorkspaceEntries.length;
    publish(store, 'AFTER_CANCEL');
    expect(handle._pendingWorkspaceEntries).toHaveLength(pending);
  });
});
