import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ModelProvider } from '../provider.js';
import type { AgentConfig } from '../types.js';
import type { SessionToolDispatcher } from './dispatcher.js';
import { resolveComposeNodeProvider } from './compose-node-provider.js';
import { bareProviderResolver } from '../session/provider-lifecycle.js';

let tmp: string;
let origAfkHome: string | undefined;
const openProviders: ModelProvider[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'afk-compose-node-provider-'));
  origAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmp;
});

afterEach(() => {
  // Close provider handles (lazily opened SQLite stores) before rmSync: on
  // Windows an open better-sqlite3 handle makes rmSync throw EBUSY.
  for (const provider of openProviders.splice(0)) {
    try { provider.close(); } catch { /* ignore: already closed */ }
  }
  if (origAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = origAfkHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveComposeNodeProvider', () => {
  it('keeps the legacy no-provider path for an unrestricted node without a store', () => {
    const result = resolveComposeNodeProvider('claude-haiku-5-5', undefined, undefined, {});
    expect(result).not.toHaveProperty('provider');
  });

  it('returns a provider when workspace store is present', () => {
    const store = {} as unknown as import('../workspace/workspace-store.js').WorkspaceStore;
    const result = resolveComposeNodeProvider('claude-haiku-5-5', store, undefined, {});
    expect(result).toHaveProperty('provider');
    if ('provider' in result) openProviders.push(result.provider);
  });

  it('returns a provider when restricted (readOnlyBash)', () => {
    const result = resolveComposeNodeProvider('claude-haiku-5-5', undefined, undefined, { readOnlyBash: true });
    expect(result).toHaveProperty('provider');
    if ('provider' in result) openProviders.push(result.provider);
  });
});

/** Per-query dispatcher of a provider, rooted in the temp dir (not a git repo). */
function dispatcherFor(provider: ModelProvider): SessionToolDispatcher {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (provider as any).buildDispatcher('default', {
    cwd: tmp,
    readRoots: [tmp],
    writeRoots: [tmp],
    sessionId: 'parent-session',
    parentSessionId: 'parent-session',
    subagentId: 'compose-a-1',
  }) as SessionToolDispatcher;
}

async function runBash(provider: ModelProvider, command: string): Promise<string> {
  const r = await dispatcherFor(provider).execute({
    id: 'bash-1', name: 'bash', input: { command }, signal: new AbortController().signal,
  });
  return String(r.content);
}

// The legacy no-provider path above hands the node to the forked session's
// bare `resolveProvider` fallback. That fallback must carry the gate for a
// fork and must not for a top-level session. The temp dir is not a git repo,
// so an unblocked command fails harmlessly inside git.
describe.each([['anthropic-direct', 'sonnet'], ['openai-compatible', 'gpt-4o']] as const)(
  'bare provider fallback — %s',
  (providerName, model) => {
    it('blocks destructive git for a forked child (isSubagentFork)', async () => {
      const config = { model, isSubagentFork: true } as AgentConfig;
      const provider = bareProviderResolver(config)(model);
      openProviders.push(provider);
      expect(provider.name).toBe(providerName);
      expect(await runBash(provider, 'git checkout main')).toContain('working-tree-destructive');
    });

    it('does not apply the gate to a top-level session', async () => {
      const config = { model } as AgentConfig;
      const provider = bareProviderResolver(config)(model);
      openProviders.push(provider);
      expect(await runBash(provider, 'git checkout main')).not.toContain('working-tree-destructive');
    });
  },
);
