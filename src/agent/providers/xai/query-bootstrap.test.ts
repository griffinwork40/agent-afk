/**
 * Tests for buildOAuthRefreshQuery — buffering and replay of setCwd/setSystemPrompt
 * that arrive before the inner query is lazily initialized.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildOAuthRefreshQuery } from './query-bootstrap.js';
import type { XaiQueryBootstrapArgs } from './query-bootstrap.js';
import type { ProviderQuery, ProviderQueryArgs } from '../../provider.js';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeInnerQuery(): ProviderQuery & {
  setCwdCalls: string[];
  setSystemPromptCalls: (string | undefined)[];
} {
  const setCwdCalls: string[] = [];
  const setSystemPromptCalls: (string | undefined)[] = [];

  const q: ProviderQuery & {
    setCwdCalls: string[];
    setSystemPromptCalls: (string | undefined)[];
  } = {
    setCwdCalls,
    setSystemPromptCalls,
    async *[Symbol.asyncIterator]() {},
    async interrupt() {},
    async setModel() {},
    async setPermissionMode() {},
    setCwd(cwd: string) {
      setCwdCalls.push(cwd);
    },
    setSystemPrompt(p: string | undefined) {
      setSystemPromptCalls.push(p);
      return true;
    },
    async supportedCommands() {
      return [];
    },
    async supportedModels() {
      return [];
    },
    async supportedAgents() {
      return [];
    },
    async getContextUsage() {
      return {};
    },
    async mcpServerStatus() {
      return [];
    },
    async accountInfo() {
      return {};
    },
    async rewindFiles() {
      return { canRewind: false };
    },
    async compact() {
      return {
        compacted: false,
        reason: 'not supported',
        messagesBefore: 0,
        messagesAfter: 0,
      };
    },
    listRewindTargets() {
      return [];
    },
    async rewindConversation() {
      return {
        rewound: false,
        reason: 'not-supported' as const,
        messagesBefore: 0,
        messagesAfter: 0,
      };
    },
    async close() {},
  };
  return q;
}

function makeOpts(inner: ProviderQuery): XaiQueryBootstrapArgs {
  return {
    args: {
      config: { apiKey: 'test-key' },
    } as unknown as ProviderQueryArgs,
    forceMode: 'apikey',
    authDeps: {
      store: undefined,
      readEnv: () => 'test-key',
    },
    getLastMode: () => 'apikey',
    delegate: vi.fn().mockReturnValue(inner),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildOAuthRefreshQuery — setCwd/setSystemPrompt buffering', () => {
  let inner: ReturnType<typeof makeInnerQuery>;
  let opts: XaiQueryBootstrapArgs;

  beforeEach(() => {
    inner = makeInnerQuery();
    opts = makeOpts(inner);
  });

  it('replays setCwd buffered before init when query initializes', async () => {
    const q = buildOAuthRefreshQuery(opts);

    // Call before the inner query exists.
    q.setCwd?.('/some/path');

    // Trigger init by consuming the iterator.
    const iter = q[Symbol.asyncIterator]();
    await iter.next();

    expect(inner.setCwdCalls).toEqual(['/some/path']);
  });

  it('replays setSystemPrompt (string) buffered before init', async () => {
    const q = buildOAuthRefreshQuery(opts);

    q.setSystemPrompt?.('custom prompt');

    const iter = q[Symbol.asyncIterator]();
    await iter.next();

    expect(inner.setSystemPromptCalls).toEqual(['custom prompt']);
  });

  it('replays setSystemPrompt (undefined) buffered before init', async () => {
    const q = buildOAuthRefreshQuery(opts);

    q.setSystemPrompt?.(undefined);

    const iter = q[Symbol.asyncIterator]();
    await iter.next();

    expect(inner.setSystemPromptCalls).toEqual([undefined]);
  });

  it('forwards setCwd directly when inner query already exists', async () => {
    const q = buildOAuthRefreshQuery(opts);

    // Init first.
    const iter = q[Symbol.asyncIterator]();
    await iter.next();

    // Now call after init.
    q.setCwd?.('/after/init');

    expect(inner.setCwdCalls).toEqual(['/after/init']);
  });

  it('forwards setSystemPrompt directly when inner query already exists', async () => {
    const q = buildOAuthRefreshQuery(opts);

    const iter = q[Symbol.asyncIterator]();
    await iter.next();

    q.setSystemPrompt?.('post-init prompt');

    expect(inner.setSystemPromptCalls).toEqual(['post-init prompt']);
  });

  it('does not replay buffered setCwd more than once if iterator is pulled twice', async () => {
    const q = buildOAuthRefreshQuery(opts);

    q.setCwd?.('/only/once');

    // Pull twice — init only runs once due to single-flight guard.
    const iter1 = q[Symbol.asyncIterator]();
    await iter1.next();
    const iter2 = q[Symbol.asyncIterator]();
    await iter2.next();

    expect(inner.setCwdCalls).toEqual(['/only/once']);
  });

  it('returns false from setSystemPrompt before init (no inner query)', () => {
    const q = buildOAuthRefreshQuery(opts);
    const result = q.setSystemPrompt?.('early');
    expect(result).toBe(false);
  });
});
