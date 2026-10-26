import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'http';
import type { AddressInfo } from 'net';
import { checkSlotEndpoints, modelsUrl, planProbeAuth, sanitizeUrl } from './doctor-slot-endpoints.js';
import type { ModelSlots } from '../../agent/session/model-slots.js';
import type { Check } from './doctor-checks.js';

const SECRET = 'sk-local-super-secret-123';

interface Seen {
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

let server: Server;
let base: string;
const seen: Seen[] = [];

/** Routes: /ok/ lists models, /auth/ → 401, /err/ → 500, /slow/ hangs. */
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url?.startsWith('/auth/')) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (req.url?.startsWith('/slow/')) return; // never responds
    if (req.url?.startsWith('/err/')) {
      res.writeHead(500).end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen-a' }, { id: 'qwen-b' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function slots(overrides: Partial<ModelSlots>): ModelSlots {
  return {
    local: overrides.local ?? { id: 'claude-haiku-5-5' },
    small: overrides.small ?? { id: 'claude-haiku-5-5' },
    medium: overrides.medium ?? { id: 'claude-sonnet-4-6' },
    large: overrides.large ?? { id: 'claude-opus-5-5' },
    subagent: overrides.subagent ?? { id: '' },
  };
}

// Stub the wire route so results never depend on the host's AFK_PROVIDER / env.
const routed = (route: string) => async (): Promise<string> => route;
const openaiRoute = routed('openai-compatible');

async function run(bindings: ModelSlots, timeoutMs = 2000, route = openaiRoute): Promise<Check[]> {
  return checkSlotEndpoints({ bindings, timeoutMs, routeOf: route });
}

function lastAuthHeader(): string | undefined {
  return seen[seen.length - 1]!.headers.authorization;
}

function allText(checks: Check[]): string {
  return JSON.stringify(checks);
}

describe('modelsUrl / sanitizeUrl', () => {
  it('keeps a trailing /v1 and never doubles slashes', () => {
    expect(modelsUrl('http://localhost:8000/v1')).toBe('http://localhost:8000/v1/models');
    expect(modelsUrl('http://localhost:8000/v1/')).toBe('http://localhost:8000/v1/models');
    expect(modelsUrl('http://localhost:11434')).toBe('http://localhost:11434/models');
  });

  it('strips userinfo and query strings', () => {
    expect(sanitizeUrl('http://user:pw@host:1/v1?key=x')).toBe('http://host:1/v1');
    expect(sanitizeUrl('not a url user:pw@x')).not.toContain('pw@');
  });
});

describe('checkSlotEndpoints', () => {
  it('PASS when the model id is listed', async () => {
    const checks = await run(slots({ local: { id: 'qwen-a', baseUrl: `${base}/ok/v1` } }));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.state).toBe('pass');
    expect(checks[0]!.name).toContain('local');
    expect(checks[0]!.detail).toContain(`${base}/ok/v1/models`);
  });

  it('WARN listing available ids when the model id is absent', async () => {
    const checks = await run(slots({ small: { id: 'missing-model', baseUrl: `${base}/ok/v1` } }));
    expect(checks[0]!.state).toBe('warn');
    expect(checks[0]!.detail).toContain('missing-model not listed');
    expect(checks[0]!.detail).toContain('qwen-a, qwen-b');
  });

  it('WARN on 401 and on other non-2xx', async () => {
    // The slot's own key was sent, so a 401 means the server rejected it.
    const checks = await run(
      slots({
        local: { id: 'qwen-a', baseUrl: `${base}/auth/v1`, apiKey: SECRET },
        small: { id: 'qwen-a', baseUrl: `${base}/err/v1` },
      }),
    );
    expect(checks.map((c) => c.state)).toEqual(['warn', 'warn']);
    expect(checks[0]!.detail).toContain('401 (auth rejected)');
    expect(checks[0]!.fix).toMatch(/API key/);
    expect(checks[1]!.detail).toContain('500');
  });

  it('FAIL on connection refused with a curl hint', async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const checks = await run(slots({ local: { id: 'qwen-a', baseUrl: `http://127.0.0.1:${port}/v1` } }));
    expect(checks[0]!.state).toBe('fail');
    expect(checks[0]!.detail).toContain('connection refused');
    expect(checks[0]!.fix).toContain(`curl http://127.0.0.1:${port}/v1/models`);
  });

  it('FAIL on timeout, quickly', async () => {
    const t0 = Date.now();
    const checks = await run(slots({ local: { id: 'qwen-a', baseUrl: `${base}/slow/v1` } }), 50);
    expect(checks[0]!.state).toBe('fail');
    expect(checks[0]!.detail).toContain('timed out');
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('makes no probes when no slot has a custom baseUrl', async () => {
    const fetchImpl = vi.fn();
    const checks = await checkSlotEndpoints({
      bindings: slots({}),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      routeOf: openaiRoute,
    });
    expect(checks).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips Anthropic-routed shim slots', async () => {
    const fetchImpl = vi.fn();
    const checks = await checkSlotEndpoints({
      bindings: slots({ local: { id: 'local-foo', baseUrl: `${base}/ok/v1` } }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      routeOf: routed('anthropic-direct'),
    });
    expect(checks).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the API key as a bearer header but never prints it', async () => {
    seen.length = 0;
    const checks = await run(
      slots({
        local: { id: 'qwen-a', baseUrl: `${base}/ok/v1`, apiKey: SECRET },
        small: { id: 'nope', baseUrl: `${base}/auth/v1`, apiKey: SECRET },
      }),
    );
    expect(seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
    expect(allText(checks)).not.toContain(SECRET);
  });

  it('strips userinfo from printed URLs and does not send it', async () => {
    seen.length = 0;
    const withCreds = base.replace('http://', 'http://alice:hunter2@');
    const refused = 'http://bob:pa55@127.0.0.1:1/v1';
    const checks = await run(
      slots({
        local: { id: 'qwen-a', baseUrl: `${withCreds}/ok/v1` },
        small: { id: 'qwen-a', baseUrl: refused },
      }),
    );
    expect(checks[0]!.state).toBe('pass');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    const text = allText(checks);
    for (const leaked of ['alice', 'hunter2', 'bob', 'pa55']) expect(text).not.toContain(leaked);
  });

  it('uses the real routing decision by default (local-* ids are not probed)', async () => {
    const fetchImpl = vi.fn();
    const checks = await checkSlotEndpoints({
      bindings: slots({ local: { id: 'local-foo', baseUrl: `${base}/ok/v1` } }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(checks).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends nothing for a slot with no key of its own; 401 reads "auth unverified", not "rejected"', async () => {
    // The runtime would fall back to OPENAI_API_KEY / Codex credentials; doctor
    // deliberately does not replicate that, so it must not blame a missing key.
    seen.length = 0;
    const checks = await run(slots({ local: { id: 'qwen-a', baseUrl: `${base}/auth/v1` } }));

    expect(lastAuthHeader()).toBeUndefined();
    expect(checks[0]!.state).toBe('warn');
    expect(checks[0]!.detail).toContain('auth unverified: the slot has no key of its own');
    expect(checks[0]!.detail).toContain('OPENAI_API_KEY');
    expect(checks[0]!.detail).not.toContain('auth rejected');
  });

  it('WARN "auth unverified" on 401 for an xAI slot, sending nothing', async () => {
    seen.length = 0;
    const checks = await run(
      slots({ local: { id: 'grok-3', baseUrl: `${base}/auth/v1`, provider: 'xai' } }),
      2000,
      routed('xai'),
    );

    expect(lastAuthHeader()).toBeUndefined();
    expect(checks[0]!.state).toBe('warn');
    expect(checks[0]!.detail).toContain('auth unverified');
    expect(checks[0]!.detail).not.toContain('auth rejected');
    expect(checks[0]!.fix).not.toMatch(/AFK_MODEL/);
  });

  it('never sends the slot key on an inferred xAI route (runtime may abort on key + stored OAuth)', async () => {
    // Round-3 finding 2: a grok-* slot with apiKey and stored xAI OAuth is
    // ambiguous at runtime (xai/auth.ts), so a keyed probe "pass" would lie.
    seen.length = 0;
    const checks = await run(
      slots({ local: { id: 'grok-4', baseUrl: `${base}/ok/v1`, apiKey: SECRET } }),
      2000,
      routed('xai'),
    );

    expect(lastAuthHeader()).toBeUndefined();
    expect(allText(checks)).not.toContain(SECRET);
  });

  it('never sends a key when the wire route and the slot endpoint route disagree', async () => {
    // Round-3 finding 1: AFK_PROVIDER=openai beats a `provider: 'anthropic'`
    // slot on the wire, but applySlotCredentials puts that slot's baseUrl on
    // the Anthropic field, so the runtime never sends anything to this URL.
    seen.length = 0;
    const checks = await run(
      slots({ local: { id: 'qwen-a', baseUrl: `${base}/auth/v1`, provider: 'anthropic', apiKey: SECRET } }),
    );

    expect(lastAuthHeader()).toBeUndefined();
    expect(checks[0]!.detail).toContain('auth unverified');
    expect(checks[0]!.detail).toContain('anthropic-direct endpoint');
    expect(allText(checks)).not.toContain(SECRET);
  });

  it('sends no credential for a forced-OAuth slot even when it carries an apiKey', async () => {
    seen.length = 0;
    const checks = await run(
      slots({ local: { id: 'gpt-5', baseUrl: `${base}/auth/v1`, provider: 'chatgpt-oauth', apiKey: SECRET } }),
    );

    expect(lastAuthHeader()).toBeUndefined();
    expect(checks[0]!.state).toBe('warn');
    expect(checks[0]!.detail).toContain('auth unverified: the slot uses ChatGPT OAuth');
    expect(allText(checks)).not.toContain(SECRET);
  });

  it('planProbeAuth: only the slot key, only when both routes are openai-compatible', () => {
    const oa = 'openai-compatible';
    expect(planProbeAuth({ id: 'qwen-a', apiKey: SECRET }, oa)).toEqual({ kind: 'slot-key', key: SECRET });
    expect(planProbeAuth({ id: 'qwen-a', apiKey: SECRET, provider: 'openai' }, oa)).toEqual({
      kind: 'slot-key',
      key: SECRET,
    });
    expect(planProbeAuth({ id: 'qwen-a' }, oa)).toEqual({ kind: 'no-slot-key' });
    expect(planProbeAuth({ id: 'grok-4', apiKey: SECRET }, 'xai').kind).toBe('unverified');
    expect(planProbeAuth({ id: 'grok-4', apiKey: SECRET, provider: 'xai-oauth' }, 'xai').kind).toBe('unverified');
    expect(planProbeAuth({ id: 'q', apiKey: SECRET, provider: 'anthropic' }, oa).kind).toBe('unverified');
    expect(planProbeAuth({ id: 'q', apiKey: SECRET, provider: 'xai' }, oa).kind).toBe('unverified');
    expect(planProbeAuth({ id: 'gpt-5', apiKey: SECRET, provider: 'chatgpt-oauth' }, oa).kind).toBe('unverified');
  });
});
