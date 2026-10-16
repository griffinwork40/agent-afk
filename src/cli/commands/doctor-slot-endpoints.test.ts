import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'http';
import type { AddressInfo } from 'net';
import { checkSlotEndpoints, modelsUrl, sanitizeUrl } from './doctor-slot-endpoints.js';
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

/** Routes: /ok/v1/models lists models, /auth/v1/models → 401, /slow/v1/models hangs. */
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
    const checks = await run(
      slots({
        local: { id: 'qwen-a', baseUrl: `${base}/auth/v1` },
        small: { id: 'qwen-a', baseUrl: `${base}/err/v1` },
      }),
    );
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
});
