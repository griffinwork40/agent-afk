/**
 * Tests for the ChatGPT-OAuth mid-session token-refresh wrapper (#3396).
 *
 * Invariants under test:
 *  (a) chatgpt-oauth session, 401, fresh (different) token on disk →
 *      exactly ONE retry carrying the new token; success on retry.
 *  (b) chatgpt-oauth session, 401, same token still on disk →
 *      no retry loop; human-readable diagnostic emitted ("EXPIRED — re-run codex").
 *  (c) chatgpt-oauth session, 401, expired/missing token on disk →
 *      no retry, expired-token diagnostic emitted.
 *  (d) API-key session (source: 'env'), 401 → pass-through, no re-resolve.
 *  (e) chatgpt-oauth session, non-401 error → pass-through unchanged.
 *  (f) chatgpt-oauth session, clean turn (no error) → all events emitted normally.
 *  (g) priorTurns rollback: after a 401 that triggers a retry, the user turn
 *      pushed during the failed attempt is removed before makeNewAttempt runs.
 */

import { describe, it, expect } from 'vitest';
import type { ProviderEvent } from '../../../provider.js';
import type { OpenAIMessage } from '../messages.js';
import { wrapTurnWithOAuthRefresh, is401, type OAuthRefreshContext } from './token-refresh.js';
import type { OpenAIAuthResolution, AuthResolverDeps } from '../auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal error object with an HTTP status, matching the OpenAI SDK shape. */
function apiError(status: number): Error & { status: number } {
  const e = new Error(`http ${status}`) as Error & { status: number };
  e.status = status;
  return e;
}

/** Async generator that yields the given events in order. */
async function* eventsGen(events: ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  for (const e of events) yield e;
}

/** Collect all events from an async generator into an array. */
async function collect(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** Build a minimal OAuthRefreshContext. */
function makeCtx(opts: {
  source: OpenAIAuthResolution['source'];
  apiKey?: string | null;
  forceChatgptOAuth?: boolean;
  priorTurns?: OpenAIMessage[];
  onRebuild?: (auth: OpenAIAuthResolution) => void;
}): OAuthRefreshContext {
  const priorTurns = opts.priorTurns ?? [];
  let auth: OpenAIAuthResolution = {
    source: opts.source,
    apiKey: opts.apiKey ?? (opts.source === 'chatgpt-oauth' ? 'tok-A' : 'sk-env'),
  };
  return {
    get opts() {
      return {
        get auth() { return auth; },
        config: { forceChatgptOAuth: opts.forceChatgptOAuth ?? false },
      };
    },
    get priorTurns() { return priorTurns; },
    rebuildClient(newAuth: OpenAIAuthResolution) {
      auth = newAuth;
      opts.onRebuild?.(newAuth);
    },
  };
}

/**
 * Build hermetic AuthResolverDeps that return a fixed auth resolution.
 * This prevents the test from reading real host credentials from disk.
 *
 * NOTE: resolveOpenAIAuth uses `forceChatgptOAuth` (Tier 0) OR
 * `AFK_OPENAI_CHATGPT_OAUTH` (Tier 4) to gate chatgpt-oauth resolution.
 * Tests that exercise the refresh path use `forceChatgptOAuth: true` on their
 * context so Tier 0 fires; the `readFile` stub supplies the mock auth.json.
 * Tests using `forceChatgptOAuth: false` would need `AFK_OPENAI_CHATGPT_OAUTH=1`
 * in the env — we opt for the former to avoid environment pollution.
 */
function makeDeps(resolution: OpenAIAuthResolution): AuthResolverDeps {
  // resolveOpenAIAuth reads the filesystem via `readFile` and env via `readEnv`.
  if (resolution.source === 'chatgpt-oauth' && resolution.apiKey !== null) {
    const token = resolution.apiKey;
    // Encode a minimal fake JWT-like token so parseCodexAuthJson can extract it.
    // The access_token just needs to be a non-empty string; the expiry decoding
    // is defensive and returns undefined on a non-JWT string — that's fine since
    // we don't test expiry extraction here.
    const fakeJson = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: token },
    });
    return {
      readEnv: () => undefined,
      readFile: () => fakeJson,
    };
  }
  if (resolution.source === 'chatgpt-oauth-expired') {
    // Expired: encode a past exp in the JWT claim.
    // Encode: {exp: 1} → base64url of '{"exp":1}'.
    const expiredClaims = Buffer.from('{"exp":1}').toString('base64url');
    const fakeJwt = `header.${expiredClaims}.sig`;
    const fakeJson = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: fakeJwt },
    });
    return {
      readEnv: () => undefined,
      readFile: () => fakeJson,
    };
  }
  // no-usable-auth, env, codex-cli, etc.: return no file, no env.
  return {
    readEnv: () => undefined,
    readFile: () => null,
  };
}

// ---------------------------------------------------------------------------
// is401 utility
// ---------------------------------------------------------------------------

describe('is401', () => {
  it('returns true for a status-401 error', () => {
    expect(is401(apiError(401))).toBe(true);
  });
  it('returns false for other statuses', () => {
    expect(is401(apiError(429))).toBe(false);
    expect(is401(apiError(500))).toBe(false);
    expect(is401(new Error('no status'))).toBe(false);
    expect(is401(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d) Non-chatgpt-oauth sessions: 401 passes through unchanged
// ---------------------------------------------------------------------------

describe('non-chatgpt-oauth session (source: env)', () => {
  it('(d) passes a 401 error through unchanged without re-resolving auth', async () => {
    const ctx = makeCtx({ source: 'env', apiKey: 'sk-env' });
    let rebuildCalled = false;
    (ctx as unknown as { rebuildClient: (a: OpenAIAuthResolution) => void }).rebuildClient = () => {
      rebuildCalled = true;
    };

    const events: ProviderEvent[] = [
      { type: 'error', error: apiError(401) },
    ];
    const result = await collect(
      wrapTurnWithOAuthRefresh(ctx, eventsGen(events), () => eventsGen([]), {})
    );

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('error');
    expect((result[0] as { type: 'error'; error: Error & { status: number } }).error.status).toBe(401);
    expect(rebuildCalled).toBe(false);
  });

  it('(e-env) passes non-401 errors through unchanged', async () => {
    const ctx = makeCtx({ source: 'env', apiKey: 'sk-env' });
    const events: ProviderEvent[] = [
      { type: 'error', error: apiError(500) },
    ];
    const result = await collect(
      wrapTurnWithOAuthRefresh(ctx, eventsGen(events), () => eventsGen([]), {})
    );
    expect(result).toHaveLength(1);
    expect((result[0] as { type: 'error'; error: Error & { status: number } }).error.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// (a) chatgpt-oauth + 401 + fresh (different) token → retry with new token
// ---------------------------------------------------------------------------

describe('chatgpt-oauth + 401 + different token on disk', () => {
  it('(a) retries exactly once with the new token and yields the retry events', async () => {
    const retryEvents: ProviderEvent[] = [
      { type: 'assistant.message', text: 'hello after refresh', stopReason: 'stop', usage: null },
    ];

    let rebuildCalledWith: OpenAIAuthResolution | null = null;
    let makeNewAttemptCallCount = 0;

    const priorTurns: OpenAIMessage[] = [
      { role: 'user', content: 'original prompt' },
    ]; // simulates pushUserTurn having run

    const ctx = makeCtx({
      source: 'chatgpt-oauth',
      apiKey: 'tok-A',
      forceChatgptOAuth: true, // Tier 0 path — slot forces chatgpt-oauth
      priorTurns,
      onRebuild: (a) => { rebuildCalledWith = a; },
    });

    // First attempt: 401
    const firstAttempt = eventsGen([{ type: 'error', error: apiError(401) }]);

    // makeNewAttempt: called once, returns the retry events
    const makeNewAttempt = () => {
      makeNewAttemptCallCount++;
      return eventsGen(retryEvents);
    };

    // Fresh auth: different token (tok-B) returned by codex
    const authDeps = makeDeps({ source: 'chatgpt-oauth', apiKey: 'tok-B' });

    const result = await collect(
      wrapTurnWithOAuthRefresh(ctx, firstAttempt, makeNewAttempt, authDeps)
    );

    // Retry happened exactly once
    expect(makeNewAttemptCallCount).toBe(1);

    // Client was rebuilt with the new token
    expect(rebuildCalledWith).not.toBeNull();
    expect(rebuildCalledWith!.source).toBe('chatgpt-oauth');
    expect(rebuildCalledWith!.apiKey).toBe('tok-B');

    // Result carries only the retry events (no error)
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('assistant.message');
    expect((result[0] as { type: 'assistant.message'; text: string }).text).toBe('hello after refresh');
  });

  it('(g) rolls back the user turn pushed during the failed attempt before retry', async () => {
    // The real scenario: priorTurns is empty when wrapTurnWithOAuthRefresh
    // starts (wrapper snapshots length=0), pushUserTurn runs inside the
    // firstAttempt generator (length becomes 1), 401 is yielded, wrapper
    // splices back to 0 before calling makeNewAttempt.
    const priorTurns2: OpenAIMessage[] = [];
    const ctx2 = makeCtx({ source: 'chatgpt-oauth', apiKey: 'tok-A', forceChatgptOAuth: true, priorTurns: priorTurns2 });

    let afterRollback: number | null = null;

    // firstAttempt: simulate runTurnInner — push user turn, then yield 401.
    async function* firstAttemptWithPush(): AsyncGenerator<ProviderEvent> {
      priorTurns2.push({ role: 'user', content: 'my prompt' });
      yield { type: 'error', error: apiError(401) };
    }

    const makeNewAttempt = () => {
      afterRollback = priorTurns2.length;
      return eventsGen([]);
    };

    const authDeps = makeDeps({ source: 'chatgpt-oauth', apiKey: 'tok-B' });

    await collect(wrapTurnWithOAuthRefresh(ctx2, firstAttemptWithPush(), makeNewAttempt, authDeps));

    // The wrapper should have rolled back the user turn (spliced to 0).
    expect(afterRollback).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) chatgpt-oauth + 401 + same token on disk → diagnostic, no retry
// ---------------------------------------------------------------------------

describe('chatgpt-oauth + 401 + same token on disk', () => {
  it('(b) emits an expired-token diagnostic, does not retry', async () => {
    const ctx = makeCtx({ source: 'chatgpt-oauth', apiKey: 'tok-A', forceChatgptOAuth: true });
    let makeNewAttemptCalled = false;

    const firstAttempt = eventsGen([{ type: 'error', error: apiError(401) }]);
    const makeNewAttempt = () => { makeNewAttemptCalled = true; return eventsGen([]); };

    // Same token returned (tok-A === tok-A)
    const authDeps = makeDeps({ source: 'chatgpt-oauth', apiKey: 'tok-A' });

    const result = await collect(
      wrapTurnWithOAuthRefresh(ctx, firstAttempt, makeNewAttempt, authDeps)
    );

    expect(makeNewAttemptCalled).toBe(false);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('error');
    // The message should mention the diagnostic (not the raw 401 text)
    const msg = (result[0] as { type: 'error'; error: Error }).error.message;
    expect(msg).toMatch(/re-run.*codex|EXPIRED/i);
  });
});

// ---------------------------------------------------------------------------
// (c) chatgpt-oauth + 401 + expired/no token → diagnostic, no retry
// ---------------------------------------------------------------------------

describe('chatgpt-oauth + 401 + expired/missing token on disk', () => {
  it('(c) emits a diagnostic when the disk token is expired', async () => {
    const ctx = makeCtx({ source: 'chatgpt-oauth', apiKey: 'tok-A', forceChatgptOAuth: true });
    let makeNewAttemptCalled = false;

    const firstAttempt = eventsGen([{ type: 'error', error: apiError(401) }]);
    const makeNewAttempt = () => { makeNewAttemptCalled = true; return eventsGen([]); };

    // Expired token on disk
    const authDeps = makeDeps({ source: 'chatgpt-oauth-expired' });

    const result = await collect(
      wrapTurnWithOAuthRefresh(ctx, firstAttempt, makeNewAttempt, authDeps)
    );

    expect(makeNewAttemptCalled).toBe(false);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('error');
    const msg = (result[0] as { type: 'error'; error: Error }).error.message;
    expect(msg).toMatch(/re-run.*codex|EXPIRED/i);
  });

  it('(c) emits a diagnostic when no auth.json exists on disk', async () => {
    const ctx = makeCtx({ source: 'chatgpt-oauth', apiKey: 'tok-A', forceChatgptOAuth: true });
    let makeNewAttemptCalled = false;

    const firstAttempt = eventsGen([{ type: 'error', error: apiError(401) }]);
    const makeNewAttempt = () => { makeNewAttemptCalled = true; return eventsGen([]); };

    // No file on disk → no-usable-auth
    const authDeps: AuthResolverDeps = {
      readEnv: () => undefined,
      readFile: () => null,
    };

    const result = await collect(
      wrapTurnWithOAuthRefresh(ctx, firstAttempt, makeNewAttempt, authDeps)
    );

    expect(makeNewAttemptCalled).toBe(false);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('error');
    const msg = (result[0] as { type: 'error'; error: Error }).error.message;
    expect(msg).toMatch(/re-run.*codex|EXPIRED/i);
  });
});

// ---------------------------------------------------------------------------
// (e) chatgpt-oauth + non-401 error → pass through
// ---------------------------------------------------------------------------

describe('chatgpt-oauth + non-401 error', () => {
  it('(e) passes non-401 errors through unchanged', async () => {
    const ctx = makeCtx({ source: 'chatgpt-oauth', apiKey: 'tok-A' });
    let makeNewAttemptCalled = false;

    const firstAttempt = eventsGen([{ type: 'error', error: apiError(429) }]);
    const makeNewAttempt = () => { makeNewAttemptCalled = true; return eventsGen([]); };

    const result = await collect(
      wrapTurnWithOAuthRefresh(ctx, firstAttempt, makeNewAttempt, makeDeps({ source: 'chatgpt-oauth', apiKey: 'tok-B' }))
    );

    expect(makeNewAttemptCalled).toBe(false);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('error');
    expect((result[0] as { type: 'error'; error: Error & { status: number } }).error.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// (f) chatgpt-oauth + clean turn (no error) → events emitted normally
// ---------------------------------------------------------------------------

describe('chatgpt-oauth + clean turn', () => {
  it('(f) emits all events when no error occurs', async () => {
    const ctx = makeCtx({ source: 'chatgpt-oauth', apiKey: 'tok-A' });

    const events: ProviderEvent[] = [
      { type: 'assistant.message', text: 'hello', stopReason: 'stop', usage: null },
      { type: 'turn.completed', usage: { stopReason: 'stop', resultSubtype: 'success', isError: false, durationMs: 100 }, sessionId: 'sid' },
    ];
    const result = await collect(
      wrapTurnWithOAuthRefresh(ctx, eventsGen(events), () => eventsGen([]), {})
    );

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('assistant.message');
    expect(result[1].type).toBe('turn.completed');
  });

  it('emits buffered events before a non-401 error (partial turn)', async () => {
    const ctx = makeCtx({ source: 'chatgpt-oauth', apiKey: 'tok-A' });

    // Some text arrived, then a 500 error
    const events: ProviderEvent[] = [
      { type: 'text.delta', text: 'partial' },
      { type: 'error', error: apiError(500) },
    ];
    const result = await collect(
      wrapTurnWithOAuthRefresh(ctx, eventsGen(events), () => eventsGen([]), {})
    );

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('text.delta');
    expect(result[1].type).toBe('error');
    expect((result[1] as { type: 'error'; error: Error & { status: number } }).error.status).toBe(500);
  });
});
