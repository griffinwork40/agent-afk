/**
 * Tests for buildOAuthRefreshQuery — specifically the setCwd/setSystemPrompt
 * buffer-and-replay behavior (GitHub issue #1062).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildOAuthRefreshQuery, type XaiQueryBootstrapArgs } from './query-bootstrap.js';
import type { ProviderQuery, ProviderQueryArgs } from '../../provider.js';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeMinimalQuery(overrides: Partial<ProviderQuery> = {}): ProviderQuery {
  return {
    async *[Symbol.asyncIterator]() {},
    async interrupt() {},
    async setModel() {},
    async setPermissionMode() {},
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
    async close() {},
    listRewindTargets() {
      return [];
    },
    async rewindConversation() {
      return { rewound: false, reason: 'not-supported', messagesBefore: 0, messagesAfter: 0 };
    },
    ...overrides,
  } as unknown as ProviderQuery;
}

function makeArgs(): XaiQueryBootstrapArgs {
  const delegate = vi.fn();
  return {
    args: { config: { apiKey: undefined } } as unknown as ProviderQueryArgs,
    forceMode: 'apikey', // skip OAuth refresh for simplicity
    authDeps: {
      // Supply a fake key via readEnv so resolveXaiAuth succeeds in apikey mode.
      readEnv: (k: string) => (k === 'XAI_API_KEY' ? 'test-fake-key-1234' : undefined),
      store: undefined,
    } as unknown as XaiQueryBootstrapArgs['authDeps'],
    getLastMode: () => 'apikey',
    delegate,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain one iteration to trigger ensureInner(). */
async function drainOnce(query: ProviderQuery): Promise<void> {
  const iter = query[Symbol.asyncIterator]();
  await iter.next();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildOAuthRefreshQuery — setCwd/setSystemPrompt buffering (#1062)', () => {
  let innerCwdSpy: ReturnType<typeof vi.fn>;
  let innerSystemPromptSpy: ReturnType<typeof vi.fn>;
  let opts: XaiQueryBootstrapArgs;

  beforeEach(() => {
    innerCwdSpy = vi.fn();
    innerSystemPromptSpy = vi.fn().mockReturnValue(true);

    opts = makeArgs();
    (opts.delegate as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        makeMinimalQuery({
          setCwd: innerCwdSpy,
          setSystemPrompt: innerSystemPromptSpy,
        }),
    );
  });

  it('replays buffered setCwd onto innerQuery after init', async () => {
    const query = buildOAuthRefreshQuery(opts);

    // Call before innerQuery exists — must not throw, must buffer.
    query.setCwd?.('/buffered/path');
    expect(innerCwdSpy).not.toHaveBeenCalled();

    // Trigger init.
    await drainOnce(query);

    expect(innerCwdSpy).toHaveBeenCalledOnce();
    expect(innerCwdSpy).toHaveBeenCalledWith('/buffered/path');
  });

  it('replays buffered setSystemPrompt (string) onto innerQuery after init', async () => {
    const query = buildOAuthRefreshQuery(opts);

    query.setSystemPrompt?.('my system prompt');
    expect(innerSystemPromptSpy).not.toHaveBeenCalled();

    await drainOnce(query);

    expect(innerSystemPromptSpy).toHaveBeenCalledOnce();
    expect(innerSystemPromptSpy).toHaveBeenCalledWith('my system prompt');
  });

  it('replays buffered setSystemPrompt (undefined) onto innerQuery after init', async () => {
    const query = buildOAuthRefreshQuery(opts);

    query.setSystemPrompt?.(undefined);
    expect(innerSystemPromptSpy).not.toHaveBeenCalled();

    await drainOnce(query);

    expect(innerSystemPromptSpy).toHaveBeenCalledOnce();
    expect(innerSystemPromptSpy).toHaveBeenCalledWith(undefined);
  });

  it('replays both setCwd and setSystemPrompt when both are buffered', async () => {
    const query = buildOAuthRefreshQuery(opts);

    query.setCwd?.('/workspace');
    query.setSystemPrompt?.('combined prompt');

    await drainOnce(query);

    expect(innerCwdSpy).toHaveBeenCalledWith('/workspace');
    expect(innerSystemPromptSpy).toHaveBeenCalledWith('combined prompt');
  });

  it('uses the most-recent buffered setCwd when called multiple times before init', async () => {
    const query = buildOAuthRefreshQuery(opts);

    query.setCwd?.('/first');
    query.setCwd?.('/second');
    query.setCwd?.('/final');

    await drainOnce(query);

    expect(innerCwdSpy).toHaveBeenCalledOnce();
    expect(innerCwdSpy).toHaveBeenCalledWith('/final');
  });

  it('forwards setCwd directly to innerQuery when already initialized', async () => {
    const query = buildOAuthRefreshQuery(opts);
    await drainOnce(query); // init

    innerCwdSpy.mockClear();
    query.setCwd?.('/post-init');

    expect(innerCwdSpy).toHaveBeenCalledWith('/post-init');
  });

  it('does not replay setCwd when it was never called before init', async () => {
    const query = buildOAuthRefreshQuery(opts);
    await drainOnce(query);
    expect(innerCwdSpy).not.toHaveBeenCalled();
  });

  it('does not replay setSystemPrompt when it was never called before init', async () => {
    const query = buildOAuthRefreshQuery(opts);
    await drainOnce(query);
    expect(innerSystemPromptSpy).not.toHaveBeenCalled();
  });
});
