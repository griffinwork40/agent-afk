import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from './index.js';
import { WorkspaceStore } from '../../workspace/workspace-store.js';
import type { ToolHandler } from '../../tools/types.js';
import type { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { createChildProviderFactory } from '../../tools/nesting.js';
import type { SubagentExecutor } from '../../tools/subagent-executor.js';

// Exercise the real dispatcher without transport/auth or persistent stores.
function dispatcher(provider: AnthropicDirectProvider): SessionToolDispatcher {
  return (provider as unknown as {
    buildDispatcher(mode: string, opts: object): SessionToolDispatcher;
  }).buildDispatcher('bypassPermissions', { sessionId: 'child', parentSessionId: 'parent' });
}
const subscribeHandler: ToolHandler = async () => ({ content: 'subscribed' });
let store: WorkspaceStore;
beforeEach(() => {
  vi.stubEnv('AFK_HOME', mkdtempSync(join(tmpdir(), 'afk-ant-subscribe-')));
  store = new WorkspaceStore();
  __setAnthropicClientFactory(null);
});
afterEach(() => { store.close(); vi.unstubAllEnvs(); __setAnthropicClientFactory(null); });

function make(opts: ConstructorParameters<typeof AnthropicDirectProvider>[0] = {}): AnthropicDirectProvider {
  return new AnthropicDirectProvider({ workspaceStore: store, ...opts });
}
function names(d: SessionToolDispatcher): string[] { return d.toolDefs.map((t) => t.name); }

describe('Anthropic workspace_subscribe parity (#4619)', () => {
  it('advertises and dispatches a construction-time handler', async () => {
    const p = make({ subscribeHandler });
    try {
      const d = dispatcher(p);
      expect(names(d)).toContain('workspace_subscribe');
      expect(await d.execute({ id: 'sub', name: 'workspace_subscribe', input: {}, signal: new AbortController().signal })).toMatchObject({ content: 'subscribed' });
    } finally { p.close(); }
  });

  it('supports fork-time injection once, including handler replacement', async () => {
    const p = make();
    try {
      expect(names(dispatcher(p))).not.toContain('workspace_subscribe');
      p.setSubscribeHandler(subscribeHandler);
      p.setSubscribeHandler(async () => ({ content: 'replacement' }));
      const d = dispatcher(p);
      expect(names(d).filter((n) => n === 'workspace_subscribe')).toHaveLength(1);
      expect(await d.execute({ id: 'sub', name: 'workspace_subscribe', input: {}, signal: new AbortController().signal })).toMatchObject({ content: 'replacement' });
    } finally { p.close(); }
  });

  it('does not expose subscriptions on a root or without a workspace store', () => {
    for (const p of [make(), new AnthropicDirectProvider({ subscribeHandler })]) {
      try { expect(names(dispatcher(p))).not.toContain('workspace_subscribe'); }
      finally { p.close(); }
    }
  });

  it('keeps permission denials authoritative', async () => {
    const h = vi.fn(subscribeHandler);
    const p = make({ subscribeHandler: h, permissions: { allowedTools: ['workspace_query'] } });
    try {
      expect(names(dispatcher(p))).not.toContain('workspace_subscribe');
      expect((await dispatcher(p).execute({ id: 'sub', name: 'workspace_subscribe', input: {}, signal: new AbortController().signal })).isError).toBe(true);
      expect(h).not.toHaveBeenCalled();
    } finally { p.close(); }
  });

  it('forwards a factory-supplied handler to the Anthropic child', async () => {
    const p = createChildProviderFactory({ workspaceStore: store })({
      model: 'claude-3-5-haiku-20241022', childExecutor: {} as SubagentExecutor, subscribeHandler,
    }) as AnthropicDirectProvider;
    try {
      expect(names(dispatcher(p))).toContain('workspace_subscribe');
      expect(await dispatcher(p).execute({ id: 'sub', name: 'workspace_subscribe', input: {}, signal: new AbortController().signal })).toMatchObject({ content: 'subscribed' });
    } finally { p.close(); }
  });
});
