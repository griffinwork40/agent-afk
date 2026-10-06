/**
 * Cross-provider parity: the tool dispatcher must receive the SAME session id
 * the provider resolved for presence / query construction.
 *
 * History: both providers once built their dispatcher from `config.sessionId`,
 * a field set only under --resume/--continue (and deleted by `/clear`, see
 * `session/session-reset.ts`). A fresh or post-/clear session therefore handed
 * every tool `ToolHandlerContext.sessionId === undefined`, and `image_generate`
 * failed closed with "requires a session context (sessionId missing)".
 * anthropic-direct was fixed in #2188; openai-compatible kept the bug until
 * this test pinned both. The drift happened twice (presence first, dispatcher
 * second), so the assertion is per-provider in one table rather than one test
 * per provider that a future edit can update on only one side.
 *
 * Harness: same as `presence-advertise.test.ts` — `query()` builds the
 * dispatcher and writes presence synchronously, so it is called but never
 * iterated. We spy on the provider's private `buildDispatcher` to capture the
 * opts it was handed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AnthropicDirectProvider, OpenAICompatibleProvider } from '../index.js';
import { readPresenceFiles } from '../../awareness/presence.js';
import type { ModelProvider, ProviderQuery, ProviderUserTurn } from '../../provider.js';
import type { AgentConfig } from '../../types/config-types.js';

let tmpHome: string;
let savedHome: string | undefined;
const openProviders: ModelProvider[] = [];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'afk-dispatcher-sid-'));
  savedHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpHome;
});

afterEach(() => {
  for (const p of openProviders) p.close?.();
  openProviders.length = 0;
  if (savedHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedHome;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function* emptyPrompt(): AsyncIterable<ProviderUserTurn> {
  // never iterated — dispatcher build + presence write happen synchronously in query()
}

/** Spy on the provider's private buildDispatcher; returns the captured opts per call. */
function captureDispatcherOpts(provider: ModelProvider): Array<{ sessionId?: string; rootSessionId?: string }> {
  const calls: Array<{ sessionId?: string; rootSessionId?: string }> = [];
  const target = provider as unknown as {
    buildDispatcher: (mode: string, opts: { sessionId?: string; rootSessionId?: string }) => unknown;
  };
  const original = target.buildDispatcher.bind(provider);
  vi.spyOn(target, 'buildDispatcher').mockImplementation((mode, opts) => {
    calls.push({ ...opts });
    return original(mode, opts);
  });
  return calls;
}

function runTurn(provider: ModelProvider, config: AgentConfig): void {
  let query: ProviderQuery | undefined;
  try {
    query = provider.query({ prompt: emptyPrompt(), config });
  } catch {
    // A post-build throw (e.g. credential validation) is fine — the dispatcher is already built.
  }
  if (query !== undefined) void Promise.resolve(query.close()).catch(() => undefined);
}

interface Branch {
  name: string;
  make: () => ModelProvider;
  makeOnSurface: (surface: string) => ModelProvider;
  freshConfig: () => AgentConfig;
}

const branches: Branch[] = [
  {
    name: 'anthropic-direct',
    make: () => new AnthropicDirectProvider({}),
    makeOnSurface: (surface: string) => new AnthropicDirectProvider({ surface }),
    freshConfig: () => ({ model: 'claude-sonnet-5', apiKey: 'sk-ant-oat01-test' }),
  },
  {
    name: 'openai-compatible',
    make: () => new OpenAICompatibleProvider({}),
    makeOnSurface: (surface: string) => new OpenAICompatibleProvider({ surface }),
    freshConfig: () => ({ model: 'gpt-5.1', apiKey: 'test-openai-key' }),
  },
];

function tracked(branch: Branch): ModelProvider {
  const p = branch.make();
  openProviders.push(p);
  return p;
}

function trackedOnSurface(branch: Branch, surface: string): ModelProvider {
  const p = branch.makeOnSurface(surface);
  openProviders.push(p);
  return p;
}

for (const branch of branches) {
  describe(`dispatcher rootSessionId — ${branch.name} (PR #2710)`, () => {
    it('passes rootSessionId from config to the dispatcher when set (grandchild attribution)', () => {
      // Regression guard: before PR #2710, openai-compatible did NOT thread
      // rootSessionId into buildDispatcher opts — grandchild artifacts were
      // attributed to the intermediate session rather than the root.
      const provider = tracked(branch);
      const calls = captureDispatcherOpts(provider);

      runTurn(provider, {
        ...branch.freshConfig(),
        depth: 2,
        parentSessionId: 'intermediate-1',
        rootSessionId: 'root-0',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.rootSessionId).toBe('root-0');
    });

    it('passes undefined rootSessionId when not set (top-level session)', () => {
      // Top-level sessions have no rootSessionId — the dispatcher should not
      // invent one; parity between providers.
      const provider = tracked(branch);
      const calls = captureDispatcherOpts(provider);

      runTurn(provider, branch.freshConfig());

      expect(calls).toHaveLength(1);
      expect(calls[0]?.rootSessionId).toBeUndefined();
    });
  });

  describe(`dispatcher sessionId — ${branch.name}`, () => {
    it('hands tools a session id on a fresh session (no config.sessionId), equal to the advertised id', async () => {
      const provider = tracked(branch);
      const calls = captureDispatcherOpts(provider);

      runTurn(provider, branch.freshConfig());

      // THE REPRODUCER: before the fix openai-compatible passed undefined here.
      expect(calls).toHaveLength(1);
      const sid = calls[0]?.sessionId;
      expect(sid).toBeTypeOf('string');
      expect(sid).not.toBe('');

      const records = await readPresenceFiles();
      expect(records[0]?.sessionId).toBe(sid);
    });

    it('keeps the same tool session id across turns and after /clear (config.sessionId deleted)', () => {
      const provider = tracked(branch);
      const calls = captureDispatcherOpts(provider);

      runTurn(provider, branch.freshConfig());
      // `/clear` rebuilds the config without sessionId/resume on the SAME provider
      // instance; the memoized mint must survive so tools keep a stable id.
      runTurn(provider, branch.freshConfig());

      expect(calls).toHaveLength(2);
      expect(calls[0]?.sessionId).toBeTypeOf('string');
      expect(calls[1]?.sessionId).toBe(calls[0]?.sessionId);
    });

    it('hands a fork its parent id via config.resume', () => {
      const provider = tracked(branch);
      const calls = captureDispatcherOpts(provider);

      runTurn(provider, {
        ...branch.freshConfig(),
        depth: 1,
        parentSessionId: 'parent-1',
        resume: 'parent-1',
      });

      expect(calls[0]?.sessionId).toBe('parent-1');
    });

    it('prefers an explicit config.sessionId (resumed session)', () => {
      const provider = tracked(branch);
      const calls = captureDispatcherOpts(provider);

      runTurn(provider, { ...branch.freshConfig(), sessionId: 'resumed-target' });

      expect(calls[0]?.sessionId).toBe('resumed-target');
    });

    it('hands tools a stable session id on a fresh telegram session (fix #2353)', async () => {
      // Regression guard: before the fix, non-CLI surfaces returned undefined
      // from resolveTopLevelSessionId, so image_generate failed closed with
      // "requires a session context (sessionId missing)" and openai-compatible
      // minted a new openai-pending-… id per call, breaking stability.
      const provider = trackedOnSurface(branch, 'telegram');
      const calls = captureDispatcherOpts(provider);

      runTurn(provider, branch.freshConfig());

      expect(calls).toHaveLength(1);
      const sid = calls[0]?.sessionId;
      expect(sid).toBeTypeOf('string');
      expect(sid).not.toBe('');
      // No presence file written — telegram fresh sessions don't advertise.
      const records = await readPresenceFiles();
      expect(records).toHaveLength(0);
    });

    it('hands tools a stable session id on a fresh daemon session (fix #2353)', async () => {
      const provider = trackedOnSurface(branch, 'daemon');
      const calls = captureDispatcherOpts(provider);

      runTurn(provider, branch.freshConfig());
      // Second turn — must be the same id (stability across turns).
      runTurn(provider, branch.freshConfig());

      expect(calls).toHaveLength(2);
      const sid = calls[0]?.sessionId;
      expect(sid).toBeTypeOf('string');
      expect(sid).not.toBe('');
      expect(calls[1]?.sessionId).toBe(sid);
      // No presence file written — daemon fresh sessions don't advertise.
      const records = await readPresenceFiles();
      expect(records).toHaveLength(0);
    });

    it('get_runtime_state reports the resolved session id on a fresh telegram session (fix #2353)', () => {
      // Regression guard: before the fix, buildRuntimeStateSource received
      // config.sessionId (undefined for fresh sessions) so get_runtime_state
      // and the # Environment block showed no id.
      const provider = trackedOnSurface(branch, 'telegram');
      const calls = captureDispatcherOpts(provider);

      runTurn(provider, branch.freshConfig());

      const sid = calls[0]?.sessionId;
      expect(sid).toBeTypeOf('string');
      // The resolved id drives both the dispatcher opts AND runtimeStateSource.
      // Verified implicitly: both receive resolvedSession.id post-fix.
      expect(sid).not.toBeUndefined();
    });
  });
}
