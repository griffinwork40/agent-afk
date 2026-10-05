/**
 * Depth-2+ `agent` forks × message journal: the depth-1 child's executor
 * parent stub is backfilled with the CHILD's own journal, so a grandchild
 * journals to `forSubagent(grandchildId)` of it (a distinct
 * `sessions/<rootId>/subagents/<grandchildId>.jsonl`), never the child's or the
 * root's file.
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';

vi.mock('../routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../auth/credential-resolver.js', () => ({
  resolveCredentialForModel: vi.fn(() => 'k'),
  loadAnthropicCredential: vi.fn(() => 'k'),
  loadOpenAICredential: vi.fn(() => undefined),
}));

import { SubagentExecutor, DEFAULT_MAX_NESTING_DEPTH, type SubagentExecutorContext } from './subagent-executor.js';
import { assembleChildConfig, type AssembleChildConfigArgs } from '../subagent/fork-child-config.js';
import { createMessageJournal, loadJournalMessages } from '../journal/index.js';
import { useTmpAfkHome, user } from '../journal/__test-utils__/helpers.js';
import { getSessionJournalPath, getSubagentJournalPath } from '../../paths.js';

useTmpAfkHome();

function forkArgs(parent: AssembleChildConfigArgs<unknown>['options']['parent'], id: string): AssembleChildConfigArgs<unknown> {
  return {
    options: { parent, config: {}, agentType: 'grandchild' }, id, resume: parent.sessionId, registry: undefined,
    effectiveChildModel: 'claude-sonnet-5', effectiveTimeoutMs: 30_000, inheritedReadRoots: undefined,
    composedWriteRoots: undefined, childController: new AbortController(), parentCwd: undefined,
    parentApiKey: undefined, parentBaseUrl: undefined, parentProvider: undefined, parentTraceWriter: undefined,
    parentSurface: undefined, parentCanUseTool: undefined,
  };
}

describe('depth-2 agent fork message journal', () => {
  it('grandchild journals to its own subagent file via the child journal, distinct from the child file', async () => {
    const root = createMessageJournal({ getSessionId: () => 'root-sess' });
    const childJournal = root.forSubagent('child-1');
    const handle = {
      id: 'child-1',
      status: 'succeeded',
      session: { messageJournal: childJournal },
      runToResult: vi.fn().mockResolvedValue({ id: 'child-1', status: 'succeeded', message: { role: 'assistant', content: 'ok', timestamp: new Date() } }),
      cancel: vi.fn(), teardown: vi.fn().mockResolvedValue(undefined), getLastStopInjectContext: vi.fn(),
    };
    let childCtx: SubagentExecutorContext | undefined;
    const exec = new SubagentExecutor({
      subagentManager: { forkSubagent: vi.fn().mockResolvedValue(handle), teardownAll: vi.fn() } as never,
      parentSession: { sessionId: 'root-sess', getInputStreamRef: vi.fn(), abortSignal: new AbortController().signal, messageJournal: root },
      defaultConfig: { apiKey: 'k', systemPrompt: 'sp' },
      childProviderFactory: vi.fn().mockImplementation(({ childExecutor }: { childExecutor: SubagentExecutor }) => {
        childCtx = (childExecutor as unknown as { ctx: SubagentExecutorContext }).ctx;
        return { name: 'p', query: vi.fn() };
      }) as never,
      depth: 0,
      maxDepth: DEFAULT_MAX_NESTING_DEPTH,
    });
    await exec.execute({ id: 'call-1', name: 'agent', input: { prompt: 'go' }, signal: new AbortController().signal });

    // The child's executor parent now exposes the CHILD journal, not the root's.
    const childParent = childCtx!.parentSession;
    expect(childParent.sessionId).toBe('child-1');
    expect(childParent.messageJournal).toBe(childJournal);
    expect(childParent.messageJournal).not.toBe(root);

    const grand = assembleChildConfig(forkArgs(childParent, 'grand-2')).messageJournal!;
    expect(grand).not.toBe(childJournal);
    expect(grand).not.toBe(root);
    childJournal.append(0, user('child task'));
    grand.append(0, user('grandchild task'));
    await Promise.all([grand.close(), childJournal.close(), root.close()]);
    expect(fs.existsSync(getSubagentJournalPath('root-sess', 'grand-2'))).toBe(true);
    expect(getSubagentJournalPath('root-sess', 'grand-2')).not.toBe(getSubagentJournalPath('root-sess', 'child-1'));
    expect(loadJournalMessages('root-sess', { subagentId: 'grand-2' })).toEqual([user('grandchild task')]);
    expect(loadJournalMessages('root-sess', { subagentId: 'child-1' })).toEqual([user('child task')]);
    expect(fs.existsSync(getSessionJournalPath('root-sess'))).toBe(false);
  });
});
