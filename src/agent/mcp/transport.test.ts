/**
 * Unit tests for the MCP transport factory (`transport.ts`).
 *
 * These tests verify that `createTransport()` returns the correct SDK
 * transport class for each config shape, that headers expansion happens at
 * call time (not at config-load time), and that SSE emits a deprecation
 * warning. The tests do NOT exercise actual network connections — they verify
 * the factory logic only.
 *
 * Transport selection matrix (mirrors config-loader.ts inference logic):
 *   command set, type absent  → stdio (inferred)
 *   type: 'stdio'             → stdio (explicit)
 *   url set, type absent      → streamable-http (inferred)
 *   type: 'streamable-http'   → streamable-http (explicit)
 *   type: 'sse'               → SSE + deprecation warning
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import { createTransport, expandHeaders } from './transport.js';
import type { McpServerConfig } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin', HOME: '/home/test', ...overrides };
}

// ---------------------------------------------------------------------------
// createTransport — stdio
// ---------------------------------------------------------------------------

describe('createTransport — stdio', () => {
  it('returns StdioClientTransport for type: stdio', () => {
    const config: McpServerConfig = {
      type: 'stdio',
      command: 'node',
      args: ['server.mjs'],
    };
    const { transport, isSSE } = createTransport('test', config);
    expect(transport).toBeInstanceOf(StdioClientTransport);
    expect(isSSE).toBe(false);
  });

  it('infers stdio when command is set and type is absent', () => {
    const config: McpServerConfig = {
      command: 'python3',
      args: ['-m', 'mcp_server'],
    };
    const { transport, isSSE } = createTransport('inferred-stdio', config);
    expect(transport).toBeInstanceOf(StdioClientTransport);
    expect(isSSE).toBe(false);
  });

  it('throws when stdio has no command', () => {
    const config: McpServerConfig = { type: 'stdio' };
    expect(() => createTransport('bad-stdio', config)).toThrow(
      /stdio requires `command`/,
    );
  });

  it('warns on missing env vars but still returns the transport', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config: McpServerConfig = {
      type: 'stdio',
      command: 'node',
      env: { TOKEN: '${UNSET_TOKEN_VAR_XYZ}' },
    };
    const { transport } = createTransport('env-warn', config);
    expect(transport).toBeInstanceOf(StdioClientTransport);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('UNSET_TOKEN_VAR_XYZ'));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// createTransport — streamable-http
// ---------------------------------------------------------------------------

describe('createTransport — streamable-http', () => {
  it('returns StreamableHTTPClientTransport for type: streamable-http', () => {
    const config: McpServerConfig = {
      type: 'streamable-http',
      url: 'https://mcp.example.com/rpc',
    };
    const { transport, isSSE } = createTransport('http-server', config);
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(isSSE).toBe(false);
  });

  it('infers streamable-http when url is set and type is absent', () => {
    const config: McpServerConfig = {
      url: 'https://mcp.example.com/rpc',
    };
    const { transport, isSSE } = createTransport('inferred-http', config);
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(isSSE).toBe(false);
  });

  it('throws when streamable-http has no url', () => {
    const config: McpServerConfig = { type: 'streamable-http' };
    expect(() => createTransport('bad-http', config)).toThrow(/requires `url`/);
  });

  it('rejects non-HTTPS remote URLs to prevent plaintext credential transit', () => {
    const config: McpServerConfig = {
      type: 'streamable-http',
      url: 'http://example.com/mcp',
    };
    expect(() => createTransport('insecure-http', config)).toThrow(
      /credentials and tool I\/O would transit in plaintext/,
    );
  });

  it('allows http:// for loopback (localhost) so local-dev still works', () => {
    const config: McpServerConfig = {
      type: 'streamable-http',
      url: 'http://localhost:3000/mcp',
    };
    const { transport } = createTransport('local-http', config);
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('allows http:// for 127.0.0.1 loopback', () => {
    const config: McpServerConfig = {
      type: 'streamable-http',
      url: 'http://127.0.0.1:8080/mcp',
    };
    const { transport } = createTransport('local-http-ip', config);
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('allows http:// for IPv6 loopback ([::1])', () => {
    const config: McpServerConfig = {
      type: 'streamable-http',
      url: 'http://[::1]:8080/mcp',
    };
    const { transport } = createTransport('local-http-v6', config);
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
  });
});

// ---------------------------------------------------------------------------
// createTransport — SSE
// ---------------------------------------------------------------------------

describe('createTransport — SSE', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns SSEClientTransport for type: sse', () => {
    const config: McpServerConfig = {
      type: 'sse',
      url: 'https://legacy.example.com/sse',
    };
    const { transport, isSSE } = createTransport('sse-server', config);
    expect(transport).toBeInstanceOf(SSEClientTransport);
    expect(isSSE).toBe(true);
  });

  it('emits a deprecation warning to stderr for SSE', () => {
    const config: McpServerConfig = {
      type: 'sse',
      url: 'https://legacy.example.com/sse',
    };
    createTransport('sse-warn', config);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('SSE transport is deprecated'),
    );
  });

  it('throws when SSE has no url', () => {
    const config: McpServerConfig = { type: 'sse' };
    expect(() => createTransport('bad-sse', config)).toThrow(/requires `url`/);
  });

  it('rejects non-HTTPS SSE URLs (same plaintext guard as streamable-http)', () => {
    const config: McpServerConfig = {
      type: 'sse',
      url: 'http://legacy.example.com/sse',
    };
    expect(() => createTransport('insecure-sse', config)).toThrow(
      /credentials and tool I\/O would transit in plaintext/,
    );
  });
});

// ---------------------------------------------------------------------------
// expandHeaders — ${VAR} expansion
// ---------------------------------------------------------------------------

describe('expandHeaders', () => {
  it('expands ${VAR} from a supplied env source', () => {
    const source = makeEnv({ MY_TOKEN: 'secret-token' });
    const { headers, missing } = expandHeaders(
      { Authorization: 'Bearer ${MY_TOKEN}' },
      source,
    );
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(missing).toHaveLength(0);
  });

  it('reports missing vars and omits the header', () => {
    const source = makeEnv(); // MY_TOKEN not set
    const { headers, missing } = expandHeaders(
      { Authorization: 'Bearer ${MY_MISSING_TOKEN}' },
      source,
    );
    // Empty value → header is omitted (not passed as empty string)
    expect(headers).not.toHaveProperty('Authorization');
    expect(missing).toContain('MY_MISSING_TOKEN');
  });

  it('returns empty when headers is undefined', () => {
    const { headers, missing } = expandHeaders(undefined);
    expect(headers).toEqual({});
    expect(missing).toHaveLength(0);
  });

  it('leaves headers without placeholders unchanged', () => {
    const { headers } = expandHeaders({ 'X-Api-Version': '2024-01-01' });
    expect(headers['X-Api-Version']).toBe('2024-01-01');
  });

  it('handles multiple headers, some with placeholders and some without', () => {
    const source = makeEnv({ TOKEN: 'abc' });
    const { headers, missing } = expandHeaders(
      {
        Authorization: 'Bearer ${TOKEN}',
        'X-Static': 'static-value',
        'X-Missing': '${DOES_NOT_EXIST}',
      },
      source,
    );
    expect(headers['Authorization']).toBe('Bearer abc');
    expect(headers['X-Static']).toBe('static-value');
    expect(headers).not.toHaveProperty('X-Missing');
    expect(missing).toContain('DOES_NOT_EXIST');
  });
});

// ---------------------------------------------------------------------------
// Type inference consistency with config-loader rules
// ---------------------------------------------------------------------------

describe('type inference matches config-loader rules', () => {
  it('command-only → stdio (no url, no type)', () => {
    const { transport } = createTransport('cmd', { command: 'npx', args: ['@mcp/server'] });
    expect(transport).toBeInstanceOf(StdioClientTransport);
  });

  it('url-only → streamable-http (no command, no type)', () => {
    const { transport } = createTransport('url', { url: 'https://example.com/mcp' });
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('explicit type:stdio overrides even when url is also present', () => {
    // Unusual config but the factory should honour the explicit `type`.
    const { transport } = createTransport('explicit', {
      type: 'stdio',
      command: 'node',
      url: 'https://example.com/mcp',
    });
    expect(transport).toBeInstanceOf(StdioClientTransport);
  });
});
