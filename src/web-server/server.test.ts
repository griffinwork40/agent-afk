/**
 * Contract: these tests exercise a REAL node:http server on an ephemeral port
 * with native fetch — the pattern established by src/agent/daemon.test.ts. No
 * mocks, no supertest, no new dependencies.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { startWebServer, type WebServerHandle } from './server.js';
import { elicitationRouter } from '../agent/elicitation-router.js';
import {
  resetCommandUniverseCache,
  setCommandUniverseLoaderForTests,
} from './routes.js';

let handle: WebServerHandle | undefined;

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  resetCommandUniverseCache();
  vi.restoreAllMocks();
});

async function start(
  opts: Parameters<typeof startWebServer>[0] = {},
): Promise<WebServerHandle> {
  handle = await startWebServer({ port: 0, ...opts });
  return handle;
}

function api(h: WebServerHandle, path: string): string {
  return `http://127.0.0.1:${h.port}${path}`;
}

/** Bootstrap with `?token=` and return the opaque document-cookie value. */
async function docCookie(h: WebServerHandle): Promise<string> {
  const res = await fetch(api(h, `/?token=${h.token}`));
  const raw = res.headers.get('set-cookie') ?? '';
  return /afk_web_doc=([^;]+)/.exec(raw)?.[1] ?? '';
}

describe('startWebServer — binding', () => {
  it('binds loopback and mints a token', async () => {
    const h = await start();
    expect(h.port).toBeGreaterThan(0);
    expect(h.token).toMatch(/^[0-9a-f]{64}$/);
    expect(h.url).toContain(`?token=${h.token}`);
  });

  it('uses an explicitly supplied token', async () => {
    const h = await start({ token: 'explicit-token-value' });
    expect(h.token).toBe('explicit-token-value');
  });

  // The footgun this guards: `--host 0.0.0.0` publishes a surface that can run
  // shell commands onto the LAN with a token the operator never chose.
  it('refuses a non-loopback bind without an explicit token', async () => {
    await expect(startWebServer({ port: 0, host: '0.0.0.0' })).rejects.toThrow(
      /refusing to bind/i,
    );
  });

  it('allows a non-loopback bind once a token is explicit', async () => {
    const h = await start({ host: '0.0.0.0', token: 'deliberate' });
    expect(h.port).toBeGreaterThan(0);
  });
});

describe('auth', () => {
  it('rejects an API call with no token', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/sessions'));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  it('rejects a wrong token', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/sessions'), {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts the correct bearer token', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/sessions'), {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).sessions)).toBe(true);
  });

  // A query token is a bootstrap affordance for the document load only; it must
  // never be honoured on an API route, where it would leak via referrer/history.
  it('does NOT accept a query token on an API route', async () => {
    const h = await start();
    const res = await fetch(api(h, `/api/sessions?token=${h.token}`));
    expect(res.status).toBe(401);
  });
});

describe('CSRF / Origin', () => {
  it('rejects a mutating request from a foreign Origin', async () => {
    const h = await start({ owned: new Set(['s1']) });
    const res = await fetch(api(h, '/api/sessions/s1/prompt'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.token}`,
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
  });

  it('allows a mutating request with no Origin (non-browser client)', async () => {
    const submitted: string[] = [];
    const h = await start({
      owned: new Set(['s1']),
      submitPrompt: async (_id, text) => {
        submitted.push(text);
      },
    });
    const res = await fetch(api(h, '/api/sessions/s1/prompt'), {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(res.status).toBe(202);
    expect(submitted).toEqual(['hello']);
  });
});

describe('session ownership boundary', () => {
  // The load-bearing case: the elicitation router is a single-slot, per-process
  // singleton, so a session owned by another process can never be driven from
  // here. It must fail loudly rather than hang.
  it('rejects a prompt to a foreign session with 409', async () => {
    const h = await start({ owned: new Set(['mine']) });
    const res = await fetch(api(h, '/api/sessions/theirs/prompt'), {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('session_not_owned');
  });

  it('rejects an approval to a foreign session with 409', async () => {
    const h = await start({ owned: new Set(['mine']) });
    const res = await fetch(api(h, '/api/sessions/theirs/approve'), {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'el_1', response: { action: 'accept' } }),
    });
    expect(res.status).toBe(409);
  });

  it('returns 404 for an approval with an unknown requestId on an owned session', async () => {
    const h = await start({ owned: new Set(['mine']) });
    const res = await fetch(api(h, '/api/sessions/mine/approve'), {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'nope', response: { action: 'accept' } }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('unknown_request');
  });

  it('rejects a malformed prompt body with 400', async () => {
    const h = await start({ owned: new Set(['mine']), submitPrompt: async () => {} });
    const res = await fetch(api(h, '/api/sessions/mine/prompt'), {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ nope: 1 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('static serving', () => {
  it('refuses the document without a token', async () => {
    const h = await start();
    const res = await fetch(api(h, '/'));
    expect(res.status).toBe(401);
  });

  // Running from a source checkout without `pnpm build:web-ui` is a normal
  // state; it must be an actionable message, not a crash.
  it('returns an actionable 503 when the bundle is absent', async () => {
    const h = await start();
    const res = await fetch(api(h, `/?token=${h.token}`));
    expect([200, 503]).toContain(res.status);
    if (res.status === 503) {
      expect(await res.text()).toMatch(/build:web-ui/);
    }
  });

  it('rejects path traversal', async () => {
    const h = await start();
    const res = await fetch(api(h, '/../../etc/passwd'), { redirect: 'manual' });
    expect(res.status).not.toBe(200);
  });
});

describe('routing', () => {
  it('404s an unknown API route', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/nope'), {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(404);
  });

  it('exposes pending elicitations', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/pending'), {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).pending).toEqual([]);
  });

  /**
   * Invariant: the command list is what the browser's autocomplete ranks
   * against, so it must be populated in a process that never boots a REPL —
   * the slash registry starts EMPTY here, and `handleCommands` is the only
   * thing that fills it. A regression that skipped registration would still
   * answer 200, just with an empty list and a silently dead dropdown.
   */
  it('serves the slash-command universe for autocomplete', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/commands'), {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(200);
    const { commands } = (await res.json()) as { commands: { name: string; summary?: string }[] };
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((c) => c.name.startsWith('/'))).toBe(true);
    // A few builtins that exist regardless of the machine's installed skills.
    expect(commands.map((c) => c.name)).toEqual(expect.arrayContaining(['/help', '/clear']));
  });

  it('surfaces command initialization failure and retries successfully', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loader = vi
      .fn<() => Promise<{ name: string }[]>>()
      .mockRejectedValueOnce(new Error('skills unreadable'))
      .mockResolvedValueOnce([{ name: '/help' }]);
    setCommandUniverseLoaderForTests(loader);
    const h = await start();
    const headers = { authorization: `Bearer ${h.token}` };

    const failed = await fetch(api(h, '/api/commands'), { headers });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ error: 'command_universe_unavailable' });
    expect(error).toHaveBeenCalledWith(
      '[web] failed to initialize slash-command universe: skills unreadable',
    );

    const retried = await fetch(api(h, '/api/commands'), { headers });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ commands: [{ name: '/help' }] });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight command initialization across concurrent requests', async () => {
    let release!: (commands: { name: string }[]) => void;
    const pending = new Promise<{ name: string }[]>((resolve) => {
      release = resolve;
    });
    const loader = vi.fn(() => pending);
    setCommandUniverseLoaderForTests(loader);
    const h = await start();
    const headers = { authorization: `Bearer ${h.token}` };

    const first = fetch(api(h, '/api/commands'), { headers });
    const second = fetch(api(h, '/api/commands'), { headers });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(loader).toHaveBeenCalledTimes(1);
    release([{ name: '/help' }]);

    const responses = await Promise.all([first, second]);
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map((res) => res.json()))).toEqual([
      { commands: [{ name: '/help' }] },
      { commands: [{ name: '/help' }] },
    ]);
  });

  it('requires a bearer token for the command list', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/commands'));
    expect(res.status).toBe(401);
  });
});

/**
 * Invariant: these cover the boundary that makes the surface safe to expose —
 * a session this process did NOT create can never be driven from a browser,
 * because its elicitation handler lives in another process's memory and any
 * prompt sent to it would block forever with no way to answer.
 */
describe('startWebServer — owned sessions', () => {
  const post = async (h: WebServerHandle, path: string, body: unknown) =>
    fetch(api(h, path), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.token}`,
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${h.port}`,
      },
      body: JSON.stringify(body),
    });

  it('reports 501 for session creation when attach-only (no owner wired)', async () => {
    const h = await start();
    const res = await post(h, '/api/sessions', {});
    expect(res.status).toBe(501);
    expect((await res.json()).error).toBe('sessions_not_supported');
  });

  it('creates a session through an injected owner and marks it owned', async () => {
    const owned = new Set<string>();
    const fake = {
      owned,
      create: async () => {
        owned.add('sess-1');
        return { id: 'sess-1', cwd: '/tmp', model: 'm', createdAt: 'now' };
      },
      submitPrompt: async () => {},
      interrupt: async () => {},
    };
    const h = await start({ owner: fake as never });

    const res = await post(h, '/api/sessions', {});
    expect(res.status).toBe(201);
    expect((await res.json()).session.id).toBe('sess-1');

    // Now owned, so a prompt is accepted rather than 409'd. 202, not 200: the
    // turn runs asynchronously and streams over SSE, so the POST acknowledges
    // acceptance rather than completion.
    const prompt = await post(h, '/api/sessions/sess-1/prompt', { text: 'hi' });
    expect(prompt.status).toBe(202);
  });

  it('409s a prompt to a session this process does not own', async () => {
    const h = await start({ owner: { owned: new Set<string>() } as never });
    const res = await post(h, '/api/sessions/foreign-id/prompt', { text: 'hi' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('session_not_owned');
  });

  // Backpressure: SessionOwner.isBusy() is the intended cap on chaining
  // unbounded turns onto one session; these two tests are its only exercise.
  describe('prompt backpressure', () => {
    it('409s a prompt to an owned session that already has a turn in flight', async () => {
      const h = await start({ owned: new Set(['mine']), isBusy: () => true, submitPrompt: async () => {} });
      const res = await post(h, '/api/sessions/mine/prompt', { text: 'hi' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe('session_busy');
    });

    it('202s a prompt to an owned, idle session', async () => {
      const h = await start({ owned: new Set(['mine']), isBusy: () => false, submitPrompt: async () => {} });
      const res = await post(h, '/api/sessions/mine/prompt', { text: 'hi' });
      expect(res.status).toBe(202);
    });
  });

  it('409s an interrupt to a foreign session, and 200s an owned one', async () => {
    let interrupted: string | undefined;
    const owned = new Set<string>(['mine']);
    const h = await start({
      owner: {
        owned,
        create: async () => ({ id: 'mine', cwd: '/tmp', model: 'm', createdAt: 'now' }),
        submitPrompt: async () => {},
        interrupt: async (id: string) => {
          interrupted = id;
        },
      } as never,
    });

    expect((await post(h, '/api/sessions/theirs/interrupt', {})).status).toBe(409);
    expect(interrupted).toBeUndefined();

    expect((await post(h, '/api/sessions/mine/interrupt', {})).status).toBe(200);
    expect(interrupted).toBe('mine');
  });

  it('surfaces a session-start failure as 500 rather than a silent hang', async () => {
    const h = await start({
      owner: {
        owned: new Set<string>(),
        create: async () => {
          throw new Error('no api key');
        },
        submitPrompt: async () => {},
        interrupt: async () => {},
      } as never,
    });
    const res = await post(h, '/api/sessions', {});
    expect(res.status).toBe(500);
    expect((await res.json()).message).toContain('no api key');
  });

  it('exposes pending elicitations so a blocked turn is visible to the browser', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/pending'), {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: [] });
  });
});

describe('document auth survives a refresh', () => {
  // History: the frontend strips `?token=` from the URL on first load. With the
  // token held only in memory, a refresh requested `/` bare and got 401 — which
  // broke the resume flow the SSE transport exists to provide.
  it('accepts the document cookie on the document GET', async () => {
    const h = await start();
    const res = await fetch(api(h, '/'), {
      headers: { cookie: `afk_web_doc=${await docCookie(h)}` },
    });
    // 503 = authenticated, but the UI bundle is not built in this checkout.
    // Either way it is NOT the 401 a bare refresh used to produce.
    expect(res.status).not.toBe(401);
  });

  it('still refuses a document GET with a wrong cookie', async () => {
    const h = await start();
    const res = await fetch(api(h, '/'), { headers: { cookie: 'afk_web_doc=nope' } });
    expect(res.status).toBe(401);
  });

  it('refuses a cookie whose value is the BEARER token', async () => {
    // Invariant: the two credentials are disjoint. If the bearer token ever
    // authenticated as the document key again, the cookie would once more be a
    // replayable agent credential.
    const h = await start();
    const res = await fetch(api(h, '/'), { headers: { cookie: `afk_web_doc=${h.token}` } });
    expect(res.status).toBe(401);
  });

  it('never accepts the cookie on an API route', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/sessions'), {
      headers: { cookie: `afk_web_doc=${await docCookie(h)}` },
    });
    expect(res.status).toBe(401);
  });
});

/**
 * Invariant: the bearer token reaches the page through the SERVED HTML and the
 * cookie is set BY THE SERVER as HttpOnly. It used to be written from JS, which
 * made it readable via `document.cookie` — and because cookies are scoped by
 * host and not by port, any page on any other 127.0.0.1:<port> origin could
 * read it and drive the agent.
 *
 * These tests tolerate 503 (bundle not built in a source checkout) wherever the
 * assertion needs the document BODY, but never where it needs the auth outcome.
 */
describe('document token delivery', () => {
  it('sets an HttpOnly, non-Secure document cookie that is NOT the token', async () => {
    const h = await start();
    const res = await fetch(api(h, `/?token=${h.token}`));
    const cookie = res.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    expect(cookie).toMatch(/afk_web_doc=[0-9a-f]{64}/);
    // The whole point of the redesign: a cookie captured by a sibling loopback
    // port must not be the agent-driving credential.
    expect(cookie).not.toContain(h.token);
    expect(cookie?.toLowerCase()).toContain('httponly');
    expect(cookie?.toLowerCase()).toContain('samesite=strict');
    // Secure would stop the browser storing it over plain-http loopback, which
    // would silently reintroduce the 401-on-refresh bug the cookie prevents.
    expect(cookie?.toLowerCase()).not.toContain('secure');
    expect(cookie).not.toMatch(/__Host-/);
  });

  it('injects the token into the served HTML meta tag', async () => {
    const h = await start();
    const res = await fetch(api(h, `/?token=${h.token}`));
    if (res.status === 503) return; // bundle not built in this checkout
    const html = await res.text();
    expect(html).toContain(`<meta name="afk-token" content="${h.token}"`);
    expect(html).not.toContain('__AFK_WEB_TOKEN__');
  });

  it('does not set the token cookie on a non-document asset', async () => {
    const h = await start();
    const cookie = await docCookie(h);
    const res = await fetch(api(h, '/styles.css'), {
      headers: { cookie: `afk_web_doc=${cookie}` },
    });
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

// The regression guard for the whole cookie design: the frontend strips
// `?token=` from the visible URL, so a refresh arrives with the cookie alone.
describe('refresh still authenticates', () => {
  it('serves a bare / carrying only the cookie', async () => {
    const h = await start();
    const res = await fetch(api(h, '/'), {
      headers: { cookie: `afk_web_doc=${await docCookie(h)}` },
    });
    expect(res.status).not.toBe(401);
    expect([200, 503]).toContain(res.status);
  });
});

describe('security headers', () => {
  const assertHeaders = (res: Response): void => {
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    // The document answers /favicon.ico with an inline data: URI.
    expect(csp).toContain("img-src 'self' data:");
    // fetch + EventSource are same-origin by construction.
    expect(csp).toContain("connect-src 'self'");
  };

  it('sets them on a JSON response', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/sessions'), {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(200);
    assertHeaders(res);
  });

  it('sets them on the document response', async () => {
    const h = await start();
    assertHeaders(await fetch(api(h, `/?token=${h.token}`)));
  });

  it('sets them on an unauthenticated 401 too', async () => {
    const h = await start();
    assertHeaders(await fetch(api(h, '/')));
  });
});

// The document was gated but its subresources were not, so the bundle was
// readable by any unauthenticated local client.
describe('static assets require the same credential as the document', () => {
  it('401s /app.js without credentials', async () => {
    const h = await start();
    const res = await fetch(api(h, '/app.js'));
    expect(res.status).toBe(401);
  });

  it('401s /styles.css without credentials', async () => {
    const h = await start();
    expect((await fetch(api(h, '/styles.css'))).status).toBe(401);
  });

  it('serves an asset once the cookie is presented', async () => {
    const h = await start();
    const cookie = await docCookie(h);
    const res = await fetch(api(h, '/styles.css'), {
      headers: { cookie: `afk_web_doc=${cookie}` },
    });
    // 404 = authenticated but unbuilt; the point is that it is NOT 401.
    expect(res.status).not.toBe(401);
  });
});

describe('session id validation', () => {
  // A bad id used to open a 200 event-stream that never emitted a frame,
  // because every ledger reader treats an unsafe id as "no such session".
  it('400s a traversal-shaped session id on the stream route', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/sessions/..%2F..%2Fetc%2Fpasswd/stream'), {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_session_id');
  });

  it('400s a malformed session id on the stream route', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/sessions/not%20a%20valid%20id/stream'), {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(400);
  });

  it('400s a traversal-shaped session id on the prompt route', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/sessions/..%2F..%2Fetc/prompt'), {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(400);
  });
});

/**
 * Invariant: the session-agnostic route is additive. The per-session route
 * resolved by requestId alone anyway, so its id constrained nothing — but a
 * user viewing a READ-ONLY session could never answer a prompt, because the
 * frontend fell back to the active session id and got a permanent 409.
 */
describe('POST /api/approve — session-agnostic approval', () => {
  const pend = async (h: WebServerHandle): Promise<string> => {
    const controller = new AbortController();
    void elicitationRouter
      .route({ message: 'approve?' } as never, { signal: controller.signal })
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    return h.bridge.list()[0]!.id;
  };

  it('resolves a pending elicitation with no session id in the path', async () => {
    const h = await start();
    const id = await pend(h);
    const res = await fetch(api(h, '/api/approve'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.token}`,
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ requestId: id, response: { action: 'accept' } }),
    });
    expect(res.status).toBe(200);
    expect(h.bridge.list()).toHaveLength(0);
  });

  it('404s an unknown requestId', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/approve'), {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('still requires the bearer token', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/approve'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('still rejects a foreign Origin', async () => {
    const h = await start();
    const res = await fetch(api(h, '/api/approve'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.token}`,
        'content-type': 'application/json',
        origin: 'https://evil.example',
      },
      body: JSON.stringify({ requestId: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  // Backward compatibility: the per-session route keeps working.
  it('leaves the per-session approve route working on an owned session', async () => {
    const h = await start({ owned: new Set(['mine']) });
    const id = await pend(h);
    const res = await fetch(api(h, '/api/sessions/mine/approve'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.token}`,
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${h.port}`,
      },
      body: JSON.stringify({ requestId: id, response: { action: 'accept' } }),
    });
    expect(res.status).toBe(200);
  });
});

describe('tokenExplicit is threaded, not inferred', () => {
  // The documented invariant held only by coincidence: server.ts re-derived
  // explicitness from token presence rather than the caller's real intent.
  it('refuses a non-loopback bind when the token was not explicit', async () => {
    await expect(
      startWebServer({ port: 0, host: '0.0.0.0', token: 'minted-not-chosen', tokenExplicit: false }),
    ).rejects.toThrow(/refusing to bind/i);
  });

  it('allows a non-loopback bind when the caller reports an explicit token', async () => {
    const h = await start({ host: '0.0.0.0', token: 'deliberate', tokenExplicit: true });
    expect(h.token).toBe('deliberate');
  });

  it('falls back to token presence when the flag is omitted', async () => {
    const h = await start({ host: '0.0.0.0', token: 'deliberate' });
    expect(h.port).toBeGreaterThan(0);
  });

  // The contradiction this closes: tokenExplicit: true clears checkBind's
  // non-loopback guard, but with no token supplied `token` below still
  // auto-mints one — a LAN-exposed agent behind a credential nobody chose.
  it('rejects tokenExplicit: true with no token, even on loopback', async () => {
    await expect(
      startWebServer({ port: 0, tokenExplicit: true }),
    ).rejects.toThrow(/tokenExplicit is true but no token was supplied/i);
  });
});

describe('approval bodies fail closed', () => {
  it('declines an approval whose body carries no recognized action', async () => {
    const h = await start();
    const controller = new AbortController();
    const result = elicitationRouter.route(
      { message: 'run rm -rf?' } as never,
      { signal: controller.signal },
    );

    // Let the bridge register the request, then answer it with a body that
    // never says "accept". The object-shaped fallback used to return
    // { action: 'accept' } here, approving a tool call nobody approved.
    await new Promise((r) => setTimeout(r, 20));
    const pending = h.bridge.list();
    expect(pending.length).toBe(1);

    const res = await fetch(api(h, '/api/sessions/any/approve'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ requestId: pending[0]!.id, response: { foo: 'bar' } }),
    });
    // The session is not owned, so the route 409s before resolving. Answer it
    // through the bridge directly to assert the normalization contract itself.
    expect([200, 409]).toContain(res.status);
    h.bridge.resolve(pending[0]!.id, { foo: 'bar' });

    await expect(result).resolves.toEqual({ action: 'decline' });
    controller.abort();
  });

  /**
   * Invariant: a bare scalar can never express consent. It used to be wrapped
   * into `{ action: 'accept', content: { value } }`, so `response: false` and
   * `response: 'decline'` both APPROVED the pending file-edit or shell command
   * — the exact inversion of the decline-by-default this surface promises.
   */
  it.each([[false], [true], [0], [1], ['decline'], ['accept'], [null], [''], [undefined]])(
    'declines a scalar response body: %s',
    async (scalar) => {
      const h = await start();
      const controller = new AbortController();
      const result = elicitationRouter.route(
        { message: 'run rm -rf?' } as never,
        { signal: controller.signal },
      );
      await new Promise((r) => setTimeout(r, 20));
      const pending = h.bridge.list();
      expect(pending.length).toBe(1);

      h.bridge.resolve(pending[0]!.id, scalar);
      await expect(result).resolves.toEqual({ action: 'decline' });
      controller.abort();
    },
  );

  it('still accepts an explicit object action', async () => {
    const h = await start();
    const controller = new AbortController();
    const result = elicitationRouter.route(
      { message: 'run rm -rf?' } as never,
      { signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 20));
    const pending = h.bridge.list();
    h.bridge.resolve(pending[0]!.id, { action: 'accept' });
    await expect(result).resolves.toEqual({ action: 'accept' });
    controller.abort();
  });
});

/**
 * Invariant: the bearer token is templated into the document ONLY for a request
 * that presented a NON-REPLAYABLE credential — `?token=` or a single-use `?k=`
 * nonce. A cookie-authenticated load gets the same bundle with an empty token.
 *
 * This is the half of the cookie fix that actually closes the hole. Making the
 * cookie opaque is not sufficient on its own: a sibling loopback port that
 * captured the cookie could otherwise simply `GET /` and scrape the bearer
 * token straight out of the returned HTML.
 */
describe('bearer token is withheld from a cookie-only document load', () => {
  it('omits the token when the request authenticated by cookie alone', async () => {
    const h = await start();
    const res = await fetch(api(h, '/'), {
      headers: { cookie: `afk_web_doc=${await docCookie(h)}` },
    });
    if (res.status === 503) return; // bundle not built in this checkout
    const html = await res.text();
    expect(html).not.toContain(h.token);
    expect(html).toContain('<meta name="afk-token" content=""');
  });

  it('includes the token when the request presented ?token=', async () => {
    const h = await start();
    const res = await fetch(api(h, `/?token=${h.token}`));
    if (res.status === 503) return;
    expect(await res.text()).toContain(h.token);
  });
});

/**
 * Invariant: the auto-opened URL carries a one-shot nonce, never the bearer
 * token, because `open`/`xdg-open` publish their arguments in the process table.
 */
describe('handoff nonce for the auto-open path', () => {
  it('openUrl carries ?k= and never the bearer token', async () => {
    const h = await start();
    expect(h.openUrl).toMatch(/\?k=[0-9a-f]{64}$/);
    expect(h.openUrl).not.toContain(h.token);
    // The PRINTED url still carries the token — terminal output is not argv.
    expect(h.url).toContain(`?token=${h.token}`);
  });

  it('authenticates the document once, then refuses the replay', async () => {
    const h = await start();
    const nonce = new URL(h.openUrl).searchParams.get('k') ?? '';
    const first = await fetch(api(h, `/?k=${nonce}`));
    expect(first.status).not.toBe(401);
    const replay = await fetch(api(h, `/?k=${nonce}`));
    expect(replay.status).toBe(401);
  });

  it('delivers the bearer token on the one load it authenticates', async () => {
    const h = await start();
    const nonce = new URL(h.openUrl).searchParams.get('k') ?? '';
    const res = await fetch(api(h, `/?k=${nonce}`));
    if (res.status === 503) return;
    expect(await res.text()).toContain(h.token);
  });

  it('is refused on an API route', async () => {
    const h = await start();
    const nonce = new URL(h.openUrl).searchParams.get('k') ?? '';
    const res = await fetch(api(h, `/api/sessions?k=${nonce}`));
    expect(res.status).toBe(401);
  });

  it('is refused when unknown', async () => {
    const h = await start();
    const res = await fetch(api(h, '/?k=not-a-real-nonce'));
    expect(res.status).toBe(401);
  });
});
