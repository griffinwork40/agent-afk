/**
 * Contract: these tests exercise a REAL node:http server on an ephemeral port
 * with native fetch — the pattern established by src/agent/daemon.test.ts. No
 * mocks, no supertest, no new dependencies.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startWebServer, type WebServerHandle } from './server.js';

let handle: WebServerHandle | undefined;

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
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
