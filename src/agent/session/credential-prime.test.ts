/**
 * Library sessions on the stored Claude Code login tier: the session primes
 * (refreshes) the stored login before the first provider request, skips all
 * store and network I/O when another credential is in play, and reports an
 * unusable login in actionable terms.
 *
 * Hermetic by construction: `process.platform` is forced to darwin and
 * `execFileSync` (the `security` subprocess) and `h1ModelFetch` (the token
 * endpoint) are mocked over an in-memory fake store, so no test can reach a
 * real keychain, `~/.claude/`, or the network.
 *
 * Forcing the platform affects everything the session loads lazily, not only
 * the credential code, so native modules that select a binary by platform are
 * loaded once under the real platform first (see the warm-up below).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import Database from 'better-sqlite3';

const execFileSyncMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFileSync: execFileSyncMock };
});
vi.mock('../providers/shared/h1-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/shared/h1-fetch.js')>();
  return { ...actual, h1ModelFetch: fetchMock };
});
vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

const { AgentSession } = await import('./agent-session.js');
const { __setAnthropicClientFactory } = await import('../providers/anthropic-direct/index.js');
const { resetSlotBindings, setSlotBindings } = await import('./model-slots.js');
const { _resetKeychainReadCache, refreshClaudeCodeOauthTokenWithStatus } = await import('../auth/keychain.js');
const { _resetRefreshedClaudeCodeOauthToken, _resetLastResolvedAnthropicCredential } = await import('../auth/credential-resolver.js');
const { _resetClaudeLoginStatus } = await import('../auth/claude-login-status.js');
const { sessionNeedsStoredLogin } = await import('./credential-prime.js');
const { checkAnthropicCredential } = await import('../auth/anthropic-credential-check.js');

// better-sqlite3 picks its native binary from process.platform on first use and
// caches it for the process. Load it here, under the real platform, before any
// test forces darwin. Otherwise a session started on Linux or Windows tries to
// load the macOS binary when it opens its memory store and fails to start.
new Database(':memory:').close();

const STALE_ACCESS = 'sk-ant-oat01-stale-access-SECRET';
const STORED_REFRESH = 'sk-ant-ort01-stored-refresh-SECRET';
const FRESH_ACCESS = 'sk-ant-oat01-fresh-access-SECRET';
const ROTATED_REFRESH = 'sk-ant-ort01-rotated-refresh-SECRET';
const SECRETS = [STALE_ACCESS, STORED_REFRESH, FRESH_ACCESS, ROTATED_REFRESH];

// ---- fake credential store (the `security` subprocess) ----------------------

let store: string | undefined;

function storeLogin(oauth: Record<string, unknown>): void {
  store = JSON.stringify({ claudeAiOauth: { scopes: ['user:inference'], subscriptionType: 'max', ...oauth } });
}

function installFakeSecurity(): void {
  execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
    if (cmd !== 'security') throw Object.assign(new Error(`not available in test: ${cmd}`), { status: 1 });
    if (args[0] === 'find-generic-password') {
      if (store === undefined) throw Object.assign(new Error('not found'), { status: 44 });
      return store;
    }
    if (args[0] === 'add-generic-password') {
      store = args[args.indexOf('-w') + 1];
      return '';
    }
    throw new Error(`unexpected security ${args[0]}`);
  });
}

// Pre-existing baseline: every anthropic-direct query reads the store once in
// the RetryLayer constructor (query/retry-layer.ts, `_clientToken`) whatever
// the credential source. Priming must add nothing on top of it: no extra read,
// no write, no token exchange.
const BASELINE_STORE_READS = 1;

function securityWrites(): number {
  return securityCalls().filter((a) => a[0] === 'add-generic-password').length;
}

function securityCalls(): string[][] {
  return execFileSyncMock.mock.calls.filter((c) => c[0] === 'security').map((c) => c[1] as string[]);
}

function storeReads(): number {
  return execFileSyncMock.mock.calls.filter((c) => (c[1] as string[])[0] === 'find-generic-password').length;
}

function refreshOk(): void {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ access_token: FRESH_ACCESS, expires_in: 3600, refresh_token: ROTATED_REFRESH }),
  });
}

// ---- mock Anthropic client ----------------------------------------------------

const createMock = vi.fn();
const clientTokens: string[] = [];
class MockAnthropic {
  public messages = { create: createMock };
  constructor(opts: { authToken?: string; apiKey?: string }) {
    clientTokens.push(opts.authToken ?? opts.apiKey ?? '');
  }
}
async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}
function textStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test', type: 'message', role: 'assistant', content: [],
        model: 'claude-haiku-4-5', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] as unknown as RawMessageStreamEvent[];
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

async function runOneTurn(config: Record<string, unknown> = {}): Promise<string> {
  const session = new AgentSession({ model: 'claude-haiku-4-5', ...config });
  try {
    const reply = await session.sendMessage('hello');
    return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content);
  } finally {
    await session.close();
  }
}

/** The init failure an embedder sees from waitForInitialization(). */
async function failingTurnMessage(): Promise<string> {
  const session = new AgentSession({ model: 'claude-haiku-4-5' });
  try {
    await session.waitForInitialization();
  } catch (err) {
    return (err as Error).message;
  } finally {
    await session.close();
  }
  throw new Error('expected the session to fail');
}

function expectNoSecrets(text: string): void {
  for (const s of SECRETS) expect(text).not.toContain(s);
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  store = undefined;
  execFileSyncMock.mockReset();
  fetchMock.mockReset();
  createMock.mockReset();
  createMock.mockImplementation(() => fromArray(textStream('hi there')));
  clientTokens.length = 0;
  installFakeSecurity();
  _resetKeychainReadCache();
  _resetRefreshedClaudeCodeOauthToken();
  _resetLastResolvedAnthropicCredential();
  _resetClaudeLoginStatus();
  resetSlotBindings();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  __setAnthropicClientFactory((opts) => new MockAnthropic(opts as never) as unknown as Anthropic);
});

afterEach(() => {
  __setAnthropicClientFactory(null);
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetSlotBindings();
});

describe('library session primes the stored Claude Code login', () => {
  it('refreshes an expired stored token, writes it back, and starts the session on the fresh token', async () => {
    storeLogin({ accessToken: STALE_ACCESS, refreshToken: STORED_REFRESH, expiresAt: Date.now() - 60_000 });
    refreshOk();

    const text = await runOneTurn();

    expect(text).toContain('hi there');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1].body)).refresh_token).toBe(STORED_REFRESH);
    expect(clientTokens[0]).toBe(FRESH_ACCESS);
    const written = JSON.parse(store!) as { claudeAiOauth: Record<string, unknown> };
    expect(written.claudeAiOauth['accessToken']).toBe(FRESH_ACCESS);
    expect(written.claudeAiOauth['refreshToken']).toBe(ROTATED_REFRESH);
    expect(written.claudeAiOauth['subscriptionType']).toBe('max');
  });

  it('makes no refresh request when the stored token is still valid', async () => {
    storeLogin({ accessToken: STALE_ACCESS, refreshToken: STORED_REFRESH, expiresAt: Date.now() + 3_600_000 });

    await runOneTurn();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(securityWrites()).toBe(0);
    expect(clientTokens[0]).toBe(STALE_ACCESS);
  });

  it('adds no credential store or network I/O when an env credential is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-env-key');
    storeLogin({ accessToken: STALE_ACCESS, refreshToken: STORED_REFRESH, expiresAt: Date.now() - 60_000 });

    await runOneTurn();

    expect(storeReads()).toBe(BASELINE_STORE_READS);
    expect(securityWrites()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clientTokens[0]).toBe('sk-ant-api03-env-key');
  });

  it('adds no credential store or network I/O when config.apiKey is explicit', async () => {
    storeLogin({ accessToken: STALE_ACCESS, refreshToken: STORED_REFRESH, expiresAt: Date.now() - 60_000 });
    await runOneTurn({ apiKey: 'sk-ant-api03-explicit' });

    expect(storeReads()).toBe(BASELINE_STORE_READS);
    expect(securityWrites()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('actionable error when the stored login is unusable', () => {
  it('hollow stored login (empty tokens, expiresAt 0) names the empty record and signing in again', async () => {
    storeLogin({ accessToken: '', refreshToken: '', expiresAt: 0 });

    const msg = await failingTurnMessage();

    expect(msg).toContain('stored Claude Code login has no usable token');
    expect(msg).toContain('claude login');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refresh failure says the expired token could not be refreshed, without token material', async () => {
    storeLogin({ accessToken: STALE_ACCESS, refreshToken: STORED_REFRESH, expiresAt: Date.now() - 60_000 });
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({}) });

    const msg = await failingTurnMessage();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(msg).toContain('expired and could not be refreshed');
    expect(msg).toContain('claude login');
    expectNoSecrets(msg);
  });

  it('repair: an empty access token with a refresh token is exchanged regardless of expiry', async () => {
    storeLogin({ accessToken: '', refreshToken: STORED_REFRESH, expiresAt: Date.now() + 3_600_000 });
    refreshOk();
    const result = await refreshClaudeCodeOauthTokenWithStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ token: FRESH_ACCESS, status: 'refreshed' });
    const written = JSON.parse(store!) as { claudeAiOauth: Record<string, unknown> };
    expect(written.claudeAiOauth['accessToken']).toBe(FRESH_ACCESS);
    expect(written.claudeAiOauth['refreshToken']).toBe(ROTATED_REFRESH);
  });

  it('no stored login says none was found', async () => {
    const msg = await failingTurnMessage();
    expect(msg).toContain('No Claude Code login was found');
  });

  it('expired token with no refresh token says there is nothing to renew it with', async () => {
    storeLogin({ accessToken: STALE_ACCESS, expiresAt: Date.now() - 60_000 });
    const msg = await failingTurnMessage();
    expect(msg).toContain('no refresh token');
    expectNoSecrets(msg);
  });

  it('a session closed without iterating output does not leak an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const session = new AgentSession({ model: 'claude-haiku-4-5' });
      await session.mcpServerStatus();
      await new Promise((r) => setTimeout(r, 50));
      await session.close();
      await new Promise((r) => setTimeout(r, 20));
      await expect(session.waitForInitialization()).rejects.toThrow('No Claude Code login was found');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('init failure is observable in every host style (no stored login)', () => {
  const EXPECTED = 'No Claude Code login was found';

  async function withUnhandledWatch(fn: () => Promise<void>): Promise<unknown[]> {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await fn();
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    return unhandled;
  }

  it('a host that awaits waitForInitialization() gets the credential error', async () => {
    const unhandled = await withUnhandledWatch(async () => {
      expect(await failingTurnMessage()).toContain(EXPECTED);
    });
    expect(unhandled).toEqual([]);
  });

  it('a host that only calls sendMessage() gets the credential error, not a generic one', async () => {
    const unhandled = await withUnhandledWatch(async () => {
      const session = new AgentSession({ model: 'claude-haiku-4-5' });
      try {
        await expect(session.sendMessage('hello')).rejects.toThrow(EXPECTED);
      } finally {
        await session.close();
      }
    });
    expect(unhandled).toEqual([]);
  });

  it('a host that only streams gets an error event carrying the credential error', async () => {
    const unhandled = await withUnhandledWatch(async () => {
      const session = new AgentSession({ model: 'claude-haiku-4-5' });
      const output = session.getOutputStream()[Symbol.asyncIterator]();
      try {
        const events: OutputEventLike[] = [];
        for await (const ev of session.sendMessageStream('hello')) events.push(ev as OutputEventLike);
        const err = events.find((e) => e.type === 'error');
        expect(err?.error?.message).toContain(EXPECTED);
        const first = await output.next();
        expect((first.value as OutputEventLike | undefined)?.type).toBe('error');
        expect((first.value as OutputEventLike).error?.message).toContain(EXPECTED);
      } finally {
        await session.close();
      }
    });
    expect(unhandled).toEqual([]);
  });

  it('a host that reads status then closes without reads keeps the error retrievable', async () => {
    const unhandled = await withUnhandledWatch(async () => {
      const session = new AgentSession({ model: 'claude-haiku-4-5' });
      await session.mcpServerStatus();
      await new Promise((r) => setTimeout(r, 50));
      await session.close();
      await expect(session.waitForInitialization()).rejects.toThrow(EXPECTED);
    });
    expect(unhandled).toEqual([]);
  });
});

type OutputEventLike = { type: string; error?: Error };

describe('refresh single-flight', () => {
  it('concurrent refreshes share one token exchange', async () => {
    storeLogin({ accessToken: STALE_ACCESS, refreshToken: STORED_REFRESH, expiresAt: Date.now() - 60_000 });
    refreshOk();

    const [a, b, c] = await Promise.all([
      refreshClaudeCodeOauthTokenWithStatus(),
      refreshClaudeCodeOauthTokenWithStatus(),
      refreshClaudeCodeOauthTokenWithStatus(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([a.status, b.status, c.status]).toEqual(['refreshed', 'refreshed', 'refreshed']);
    expect(a.token).toBe(FRESH_ACCESS);
  });
});

describe('sessionNeedsStoredLogin skip rules (no I/O)', () => {
  it.each([
    ['forked subagent', { model: 'claude-haiku-4-5', isSubagentFork: true as const }],
    ['explicit apiKey', { model: 'claude-haiku-4-5', apiKey: 'k' }],
    ['local baseUrl', { model: 'claude-haiku-4-5', baseUrl: 'http://127.0.0.1:8080' }],
    ['non-Anthropic model', { model: 'gpt-5' }],
  ])('%s does not need the stored login', (_label, config) => {
    expect(sessionNeedsStoredLogin(config as never, undefined)).toBe(false);
    expect(securityCalls()).toEqual([]);
  });

  it('slot with its own key does not need the stored login', () => {
    // Bind the `medium` slot with its own apiKey so applySlotCredentials sets
    // probe.apiKey — the skip rule at credential-prime.ts:47 must fire.
    setSlotBindings({
      local: { id: '' },
      small: { id: 'claude-haiku-5-5' },
      medium: { id: 'claude-sonnet-4-6', apiKey: 'sk-ant-api03-slot-own-key' },
      large: { id: 'claude-opus-5-5' },
      subagent: { id: '' },
    });
    // Resolve via the tier name so resolveBinding returns the configured slot.
    expect(sessionNeedsStoredLogin({ model: 'medium' } as never, undefined)).toBe(false);
    // The skip must be pure logic — no keychain subprocess should have been invoked.
    expect(securityCalls()).toEqual([]);
  });

  it('a plain Anthropic session does', () => {
    expect(sessionNeedsStoredLogin({ model: 'claude-haiku-4-5' } as never, undefined)).toBe(true);
  });
});

describe('checkAnthropicCredential (public health check)', () => {
  it('primes an expired stored login and reports the source', async () => {
    storeLogin({ accessToken: STALE_ACCESS, refreshToken: STORED_REFRESH, expiresAt: Date.now() - 60_000 });
    refreshOk();
    const status = await checkAnthropicCredential();
    expect(status).toEqual({ ok: true, source: 'claude-code-keychain' });
    expectNoSecrets(JSON.stringify(status));
  });

  it('reports an actionable detail for a hollow login', async () => {
    storeLogin({ accessToken: '', refreshToken: '', expiresAt: 0 });
    const status = await checkAnthropicCredential();
    expect(status.ok).toBe(false);
    expect(status.detail).toContain('no usable token');
  });

  it('does no store I/O when an env credential is set', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-env');
    const status = await checkAnthropicCredential();
    expect(status).toEqual({ ok: true, source: 'CLAUDE_CODE_OAUTH_TOKEN' });
    expect(storeReads()).toBe(0);
  });
});
