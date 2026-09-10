/**
 * Unit tests for src/browser/agent-browser/client.ts
 *
 * Covers:
 * 1. Envelope unwrapping -- `ok: true` with `result` payload returns the payload directly
 * 2. `ok: false` error path -- throws with structured `code`/`message` from server error
 * 3. `ok: false` edge cases -- `{ok: false, error: null}`, `{ok: false}` (missing error field), `{ok: 0}` (non-boolean falsy)
 * 4. `listTabs` -- returns array directly (not `{tabs:[...]}`), objects have `isLoading: boolean` and optional `isActive`
 * 5. `openTab` -- maps server `{ id }` to public `{ tabId }`
 * 6. `closeTab` -- swallowed-error path (eval fails, no throw to caller)
 * 7. HTTP error layering -- non-ok HTTP response (4xx/5xx) throws before envelope parse
 * 8. Actions & page inspection methods -- param formatting, header transmission, timeout calculations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentBrowserClient } from './client.js';
import type { AgentBrowserConnection } from './connection.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const mockConnection: AgentBrowserConnection = {
  url: 'http://127.0.0.1:8833',
  token: 'test-auth-token',
  pid: 12345,
  version: '0.3.0',
};

let capturedRequests: CapturedRequest[] = [];

function mockFetchResponse(status: number, body: unknown, statusText = 'OK'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headersObj: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((val, key) => {
            headersObj[key.toLowerCase()] = val;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) {
            headersObj[k.toLowerCase()] = v;
          }
        } else {
          for (const [k, v] of Object.entries(init.headers)) {
            headersObj[k.toLowerCase()] = String(v);
          }
        }
      }

      let parsedBody: unknown = undefined;
      if (typeof init?.body === 'string') {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }

      capturedRequests.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: headersObj,
        body: parsedBody,
      });

      const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
      const isOk = status >= 200 && status < 300;

      return {
        ok: isOk,
        status,
        statusText,
        text: async () => bodyText,
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
      } as unknown as Response;
    }),
  );
}

describe('AgentBrowserClient', () => {
  let client: AgentBrowserClient;

  beforeEach(() => {
    capturedRequests = [];
    client = new AgentBrowserClient(mockConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // 1. Envelope unwrapping
  // -------------------------------------------------------------------------
  describe('Envelope unwrapping', () => {
    it('unwraps ok: true with result payload directly', async () => {
      const payload = { title: 'Test Page', count: 42 };
      mockFetchResponse(200, { ok: true, result: payload });

      const res = await client.evalScript('tab-1', 'document.title');

      expect(res).toEqual(payload);
      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0].url).toBe('http://127.0.0.1:8833/agent');
      expect(capturedRequests[0].method).toBe('POST');
      expect(capturedRequests[0].headers['authorization']).toBe('Bearer test-auth-token');
      expect(capturedRequests[0].headers['content-type']).toBe('application/json');
      expect(capturedRequests[0].headers['host']).toBe('127.0.0.1:8833');
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.eval',
        params: { id: 'tab-1', script: 'document.title' },
      });
    });

    it('falls back to envelope when result field is omitted (backward compatibility)', async () => {
      const rawEnvelope = { ok: true, legacyData: 'fallback' };
      mockFetchResponse(200, rawEnvelope);

      const res = await client.evalScript('tab-1', '1 + 1');

      expect(res).toEqual(rawEnvelope);
    });
  });

  // -------------------------------------------------------------------------
  // 2. ok: false error path
  // -------------------------------------------------------------------------
  describe('ok: false error path', () => {
    it('throws with structured code and message from server error', async () => {
      mockFetchResponse(200, {
        ok: false,
        error: {
          code: 'ELEMENT_NOT_FOUND',
          message: 'No element found matching selector #submit',
        },
      });

      await expect(client.click('tab-1', 'elem-99')).rejects.toThrow(
        'Agent Browser page.click failed: [ELEMENT_NOT_FOUND] No element found matching selector #submit',
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. ok: false edge cases
  // -------------------------------------------------------------------------
  describe('ok: false edge cases', () => {
    it('handles { ok: false, error: null } by falling back to UNKNOWN and stringifying envelope', async () => {
      const envelope = { ok: false, error: null };
      mockFetchResponse(200, envelope);

      await expect(client.click('tab-1', 'elem-1')).rejects.toThrow(
        `Agent Browser page.click failed: [UNKNOWN] ${JSON.stringify(envelope)}`,
      );
    });

    it('handles { ok: false } with missing error field', async () => {
      const envelope = { ok: false };
      mockFetchResponse(200, envelope);

      await expect(client.click('tab-1', 'elem-1')).rejects.toThrow(
        `Agent Browser page.click failed: [UNKNOWN] ${JSON.stringify(envelope)}`,
      );
    });

    it('handles { ok: 0 } (non-boolean falsy) without throwing error', async () => {
      const envelope = { ok: 0, result: { value: 123 } };
      mockFetchResponse(200, envelope);

      const res = await client.evalScript('tab-1', 'return 123');
      expect(res).toEqual({ value: 123 });
    });
  });

  // -------------------------------------------------------------------------
  // 4. listTabs
  // -------------------------------------------------------------------------
  describe('listTabs', () => {
    it('returns array directly (not wrapped in { tabs: [...] })', async () => {
      const tabs = [
        {
          id: 'tab-1',
          title: 'Dashboard',
          url: 'http://localhost:3000',
          isLoading: false,
          isActive: true,
        },
        {
          id: 'tab-2',
          title: 'Docs',
          url: 'http://localhost:3000/docs',
          isLoading: true,
        },
      ];
      mockFetchResponse(200, { ok: true, result: tabs });

      const result = await client.listTabs();

      expect(result).toEqual(tabs);
      expect(Array.isArray(result)).toBe(true);
      expect(result[0].isLoading).toBe(false);
      expect(result[0].isActive).toBe(true);
      expect(result[1].isLoading).toBe(true);
      expect(result[1].isActive).toBeUndefined();

      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'tabs.list',
        params: null,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 5. openTab
  // -------------------------------------------------------------------------
  describe('openTab', () => {
    it('maps server { id } to public { tabId }', async () => {
      mockFetchResponse(200, {
        ok: true,
        result: { id: 'tab-generated-42' },
      });

      const result = await client.openTab('https://example.com');

      expect(result).toEqual({ tabId: 'tab-generated-42' });
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'tabs.open',
        params: { url: 'https://example.com' },
      });
    });
  });

  // -------------------------------------------------------------------------
  // 6. closeTab
  // -------------------------------------------------------------------------
  describe('closeTab', () => {
    it('invokes page.eval with window.close() and succeeds', async () => {
      mockFetchResponse(200, { ok: true, result: undefined });

      await expect(client.closeTab('tab-1')).resolves.toBeUndefined();

      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.eval',
        params: { id: 'tab-1', script: 'window.close()' },
      });
    });

    it('swallows errors when eval fails (no throw to caller)', async () => {
      mockFetchResponse(200, {
        ok: false,
        error: { code: 'EVAL_FAILED', message: 'Window script execution failed' },
      });

      await expect(client.closeTab('tab-dead')).resolves.toBeUndefined();
    });

    it('swallows errors when network request rejects', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('Connection refused');
        }),
      );

      await expect(client.closeTab('tab-network-fail')).resolves.toBeUndefined();
    });

    it('swallows errors when HTTP status is 500', async () => {
      mockFetchResponse(500, 'Internal Server Error', 'Server Error');

      await expect(client.closeTab('tab-server-err')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 7. HTTP error layering
  // -------------------------------------------------------------------------
  describe('HTTP error layering', () => {
    it('throws HTTP error on non-ok status before envelope parsing', async () => {
      mockFetchResponse(500, 'Database connection timeout', 'Internal Server Error');

      await expect(client.listTabs()).rejects.toThrow(
        'Agent Browser tabs.list failed (HTTP 500): Database connection timeout',
      );
    });

    it('throws HTTP error on 401 Unauthorized', async () => {
      mockFetchResponse(401, 'Unauthorized token', 'Unauthorized');

      await expect(client.openTab('https://example.com')).rejects.toThrow(
        'Agent Browser tabs.open failed (HTTP 401): Unauthorized token',
      );
    });

    it('throws HTTP error even if body contains ok:false json', async () => {
      const jsonBody = JSON.stringify({
        ok: false,
        error: { code: 'AUTH_REQUIRED', message: 'Token invalid' },
      });
      mockFetchResponse(403, jsonBody, 'Forbidden');

      await expect(client.inspect('tab-1')).rejects.toThrow(
        `Agent Browser page.inspect failed (HTTP 403): ${jsonBody}`,
      );
    });
  });

  // -------------------------------------------------------------------------
  // 8. Actions and page inspection methods
  // -------------------------------------------------------------------------
  describe('Page inspection and action methods', () => {
    it('read: sends id and options with default main mode', async () => {
      const readResult = {
        content: '# Heading\nText',
        url: 'https://example.com',
        title: 'Example',
        wordCount: 3,
      };
      mockFetchResponse(200, { ok: true, result: readResult });

      const res = await client.read('tab-1');
      expect(res).toEqual(readResult);
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.read',
        params: { id: 'tab-1', mode: 'main' },
      });
    });

    it('read: passes custom mode, query, and budget', async () => {
      mockFetchResponse(200, { ok: true, result: {} });

      await client.read('tab-1', { mode: 'article', query: 'summary', budget: 500 });
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.read',
        params: { id: 'tab-1', mode: 'article', query: 'summary', budget: 500 },
      });
    });

    it('inspect: sends id and options with default interactive mode', async () => {
      const inspectResult = {
        elements: [
          {
            id: 'btn-1',
            tag: 'button',
            role: 'button',
            label: 'Submit',
            kind: null,
            value: null,
            placeholder: null,
            disabled: false,
            bbox: { x: 10, y: 20, w: 100, h: 30 },
          },
        ],
      };
      mockFetchResponse(200, { ok: true, result: inspectResult });

      const res = await client.inspect('tab-1');
      expect(res).toEqual(inspectResult);
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.inspect',
        params: { id: 'tab-1', mode: 'interactive' },
      });
    });

    it('inspect: passes custom query and limit', async () => {
      mockFetchResponse(200, { ok: true, result: { elements: [] } });

      await client.inspect('tab-1', { mode: 'all', query: 'input', limit: 10 });
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.inspect',
        params: { id: 'tab-1', mode: 'all', query: 'input', limit: 10 },
      });
    });

    it('click: sends tab id and elementId', async () => {
      mockFetchResponse(200, { ok: true, result: null });

      await client.click('tab-1', 'btn-login');
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.click',
        params: { id: 'tab-1', elementId: 'btn-login' },
      });
    });

    it('fill: sends tab id, elementId, and value', async () => {
      mockFetchResponse(200, { ok: true, result: null });

      await client.fill('tab-1', 'input-email', 'user@example.com');
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.fill',
        params: { id: 'tab-1', elementId: 'input-email', value: 'user@example.com' },
      });
    });

    it('press: sends tab id, key, and optional elementId', async () => {
      mockFetchResponse(200, { ok: true, result: null });

      await client.press('tab-1', 'Enter');
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.press',
        params: { id: 'tab-1', key: 'Enter' },
      });

      await client.press('tab-1', 'Tab', 'input-pass');
      expect(capturedRequests[1].body).toEqual({
        version: 1,
        method: 'page.press',
        params: { id: 'tab-1', key: 'Tab', elementId: 'input-pass' },
      });
    });

    it('select: sends tab id, elementId, and value', async () => {
      mockFetchResponse(200, { ok: true, result: null });

      await client.select('tab-1', 'select-country', 'US');
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.select',
        params: { id: 'tab-1', elementId: 'select-country', value: 'US' },
      });
    });

    it('waitFor: sends tab id, condition, value, and timeout', async () => {
      mockFetchResponse(200, { ok: true, result: null });

      await client.waitFor('tab-1', 'networkidle', { value: 'complete', timeout: 5000 });
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.wait',
        params: { id: 'tab-1', condition: 'networkidle', value: 'complete', timeout: 5000 },
      });
    });

    it('screenshot: sends tab id and returns data object', async () => {
      mockFetchResponse(200, { ok: true, result: { data: 'base64pngdata' } });

      const res = await client.screenshot('tab-1');
      expect(res).toEqual({ data: 'base64pngdata' });
      expect(capturedRequests[0].body).toEqual({
        version: 1,
        method: 'page.screenshot',
        params: { id: 'tab-1' },
      });
    });
  });
});
