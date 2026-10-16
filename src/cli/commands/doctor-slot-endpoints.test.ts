import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'http';
import type { AddressInfo } from 'net';
import { checkSlotEndpoints, modelsUrl, planProbeAuth, sanitizeUrl } from './doctor-slot-endpoints.js';
import type { ModelSlots } from '../../agent/session/model-slots.js';
import type { Check } from './doctor-checks.js';

const SECRET = 'sk-local-super-secret-123';
const ENV_KEY = 'sk-env-injected-abc';
const envOnly = { readEnv: (k: string) => (k === 'OPENAI_API_KEY' ? ENV_KEY : undefined), readFile: () => null };

interface Seen {
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

let server: Server;
let base: string;
const seen: Seen[] = [];

/** Routes: /ok/ lists models, /auth/ → 401, /keyed/ → 401 unless Bearer ENV_KEY, /slow/ hangs. */
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url?.startsWith('/auth/')) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (req.url?.startsWith('/keyed/') && req.headers.authorization !== `Bearer ${ENV_KEY}`) {
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
    local: { id: 'claude-haiku-5-5' },
    small: { id: 'claude-haiku-5-5' },
    medium: { id: 'claude-sonnet-4-6' },
    large: { id: 'claude-opus-5-5' },
    ...overrides,
  };
}

const notAnthropic = async (): Promise<boolean> => false;

async function run(bindings: ModelSlots, timeoutMs = 2000): Promise<Check[]> {
  return checkSlotEndpoints({ bindings, timeoutMs, isAnthropicRouted: notAnthropic });
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
    // Supply an explicit apiKey so the probe sends a credential and the 401
    // branch reports "auth rejected / check the slot API key" (the authSource
    // === 'config' path). Inject empty authDeps so no real env is read.
    const noEnv = { readEnv: () => undefined, readFile: () => null };
    const checks = await checkSlotEndpoints({
      bindings: slots({
        local: { id: 'qwen-a', baseUrl: `${base}/auth/v1`, apiKey: SECRET },
        small: { id: 'qwen-a', baseUrl: `${base}/err/v1` },
      }),
      timeoutMs: 2000,
      isAnthropicRouted: notAnthropic,
      authDeps: noEnv,
    });
    expect(checks.map((c) => c.state)).toEqual(['warn', 'warn']);
    expect(checks[0]!.detail).toContain('401');
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
      isAnthropicRouted: notAnthropic,
    });
    expect(checks).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips Anthropic-routed shim slots', async () => {
    const fetchImpl = vi.fn();
    const checks = await checkSlotEndpoints({
      bindings: slots({ local: { id: 'local-foo', baseUrl: `${base}/ok/v1` } }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      isAnthropicRouted: async () => true,
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

  it('PASS using OPENAI_API_KEY fallback when slot has baseUrl but no apiKey', async () => {
    // /keyed/ answers 401 unless the probe sends exactly the injected env key,
    // so a pass proves the fallback credential was resolved and sent.
    seen.length = 0;
    const checks = await checkSlotEndpoints({
      bindings: slots({ local: { id: 'qwen-a', baseUrl: `${base}/keyed/v1` } }),
      timeoutMs: 2000,
      isAnthropicRouted: notAnthropic,
      authDeps: envOnly,
    });

    expect(checks).toHaveLength(1);
    expect(checks[0]!.state).toBe('pass');
    // Key was sent as a Bearer header.
    const lastSeen = seen[seen.length - 1];
    expect(lastSeen!.headers.authorization).toBe(`Bearer ${ENV_KEY}`);
    // Key must not appear in any returned string.
    expect(allText(checks)).not.toContain(ENV_KEY);
  });

  it('WARN "auth unverified" on 401 when slot auth is unreproducible (xAI)', async () => {
    // A slot with provider: 'xai' routes to the xAI provider (own auth).
    // The probe sends no credential; on 401 it must say "auth unverified",
    // not "auth rejected / check the slot API key".
    const checks = await checkSlotEndpoints({
      bindings: slots({ local: { id: 'grok-3', baseUrl: `${base}/auth/v1`, provider: 'xai' } }),
      timeoutMs: 2000,
      isAnthropicRouted: notAnthropic,
      authDeps: { readEnv: () => undefined, readFile: () => null },
    });

    expect(checks).toHaveLength(1);
    expect(checks[0]!.state).toBe('warn');
    expect(checks[0]!.detail).toContain('auth unverified');
    expect(checks[0]!.detail).not.toContain('auth rejected');
    expect(checks[0]!.fix).not.toMatch(/API key/i);
    expect(checks[0]!.fix).not.toMatch(/AFK_MODEL/);
  });
  it('WARN "no credential configured" on 401 when no key resolves anywhere', async () => {
    // No slot key, no env key, no ~/.codex/auth.json: the runtime would send no
    // credential either, so the warn names a missing key, not unverifiable auth.
    const checks = await checkSlotEndpoints({
      bindings: slots({ local: { id: 'qwen-a', baseUrl: `${base}/auth/v1` } }),
      timeoutMs: 2000,
      isAnthropicRouted: notAnthropic,
      authDeps: { readEnv: () => undefined, readFile: () => null },
    });

    expect(checks).toHaveLength(1);
    expect(checks[0]!.state).toBe('warn');
    expect(checks[0]!.detail).toContain('no credential configured');
    expect(checks[0]!.detail).not.toContain('auth unverified');
    expect(checks[0]!.fix).toContain('OPENAI_API_KEY');
  });
  it('never sends OPENAI_API_KEY to an xAI route inferred from a grok-* id', async () => {
    // No provider field: routing infers xAI from the id (real routing decision).
    seen.length = 0;
    const checks = await checkSlotEndpoints({
      bindings: slots({ local: { id: 'grok-4', baseUrl: `${base}/auth/v1` } }),
      timeoutMs: 2000,
      isAnthropicRouted: notAnthropic,
      authDeps: envOnly,
    });

    expect(checks).toHaveLength(1);
    expect(seen[seen.length - 1]!.headers.authorization).toBeUndefined();
    expect(checks[0]!.detail).toContain('auth unverified');
    expect(allText(checks)).not.toContain(ENV_KEY);
  });

  it('sends no credential for a forced-OAuth slot even when it carries an apiKey', async () => {
    seen.length = 0;
    const checks = await checkSlotEndpoints({
      bindings: slots({
        local: { id: 'gpt-5', baseUrl: `${base}/auth/v1`, provider: 'chatgpt-oauth', apiKey: SECRET },
      }),
      timeoutMs: 2000,
      isAnthropicRouted: notAnthropic,
      authDeps: envOnly,
    });

    expect(seen[seen.length - 1]!.headers.authorization).toBeUndefined();
    expect(checks[0]!.state).toBe('warn');
    expect(checks[0]!.detail).toContain('auth unverified');
  });

  it('planProbeAuth: xAI route uses only the slot key; OpenAI route falls back', () => {
    expect(planProbeAuth({ id: 'grok-4', apiKey: SECRET }, 'xai', envOnly)).toEqual({ key: SECRET, source: 'config' });
    expect(planProbeAuth({ id: 'grok-4' }, 'xai', envOnly)).toEqual({});
    expect(planProbeAuth({ id: 'qwen-a' }, 'openai-compatible', envOnly)).toMatchObject({
      key: ENV_KEY,
      source: 'env',
      envVar: 'OPENAI_API_KEY',
    });
    expect(planProbeAuth({ id: 'qwen-a' }, 'openai-compatible', { readEnv: () => undefined, readFile: () => null })).toEqual({
      source: 'none',
    });
  });
});
