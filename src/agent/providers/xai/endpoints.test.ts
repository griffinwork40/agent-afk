/**
 * Dual-endpoint resolution tests for the xAI provider.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_XAI_API_BASE_URL,
  DEFAULT_XAI_OAUTH_BASE_URL,
  resolveXaiEndpoint,
} from './endpoints.js';
import { CLI_CHAT_PROXY_HOST, type GrokCliHeaderDeps } from './headers.js';

/** Build a fully-isolated GrokCliHeaderDeps — no real env or filesystem. */
function headerDeps(overrides: Partial<GrokCliHeaderDeps> = {}): GrokCliHeaderDeps {
  return {
    readEnv: () => undefined,
    homeDir: () => '/test-home',
    readFile: () => {
      throw new Error('version file unavailable');
    },
    ...overrides,
  };
}

describe('resolveXaiEndpoint', () => {
  it('defaults API-key mode to api.x.ai without proxy headers', () => {
    const r = resolveXaiEndpoint('apikey', { readEnv: () => undefined });
    expect(r.baseURL).toBe(DEFAULT_XAI_API_BASE_URL);
    expect(r.proxyHeadersApplied).toBe(false);
    expect(r.defaultHeaders).toEqual({});
    expect(r.mode).toBe('apikey');
  });

  it('honors AFK_XAI_BASE_URL for apikey mode', () => {
    const r = resolveXaiEndpoint('apikey', {
      readEnv: (k) => (k === 'AFK_XAI_BASE_URL' ? 'https://proxy.example/v1/' : undefined),
    });
    expect(r.baseURL).toBe('https://proxy.example/v1');
    expect(r.proxyHeadersApplied).toBe(false);
  });

  it('defaults OAuth mode to CLI chat proxy with identity headers', () => {
    const r = resolveXaiEndpoint('oauth', {
      readEnv: () => undefined,
      clientVersion: '9.9.9',
    });
    expect(r.baseURL).toBe(DEFAULT_XAI_OAUTH_BASE_URL);
    expect(r.proxyHeadersApplied).toBe(true);
    expect(r.defaultHeaders['X-XAI-Token-Auth']).toBe('xai-grok-cli');
    expect(r.defaultHeaders['x-grok-client-version']).toBe('9.9.9');
    expect(r.defaultHeaders['x-grok-client-identifier']).toBe('grok-shell');
    expect(r.defaultHeaders['User-Agent']).toContain('9.9.9');
    expect(r.defaultHeaders['x-grok-client-version']).not.toBe('agent-afk');
  });

  it('honors AFK_XAI_OAUTH_BASE_URL and skips proxy headers on api.x.ai', () => {
    const r = resolveXaiEndpoint('oauth', {
      readEnv: (k) =>
        k === 'AFK_XAI_OAUTH_BASE_URL' ? 'https://api.x.ai/v1' : undefined,
    });
    expect(r.baseURL).toBe('https://api.x.ai/v1');
    expect(r.proxyHeadersApplied).toBe(false);
    expect(r.defaultHeaders).toEqual({});
  });

  it('still applies proxy headers when override stays on CLI proxy host', () => {
    const r = resolveXaiEndpoint('oauth', {
      readEnv: (k) =>
        k === 'AFK_XAI_OAUTH_BASE_URL'
          ? `https://${CLI_CHAT_PROXY_HOST}/custom/v1`
          : undefined,
    });
    expect(r.proxyHeadersApplied).toBe(true);
    expect(r.defaultHeaders['X-XAI-Token-Auth']).toBe('xai-grok-cli');
  });

  it('does not use AFK_XAI_BASE_URL for oauth mode', () => {
    const r = resolveXaiEndpoint('oauth', {
      readEnv: (k) =>
        k === 'AFK_XAI_BASE_URL' ? 'https://api-key-only.example/v1' : undefined,
    });
    expect(r.baseURL).toBe(DEFAULT_XAI_OAUTH_BASE_URL);
  });

  it('honors baseUrlOverride over env and defaults (slot baseUrl)', () => {
    const r = resolveXaiEndpoint('oauth', {
      readEnv: (k) =>
        k === 'AFK_XAI_OAUTH_BASE_URL' ? 'https://cli-chat-proxy.grok.com/v1' : undefined,
      baseUrlOverride: 'https://custom-xai.example/v1',
    });
    expect(r.baseURL).toBe('https://custom-xai.example/v1');
    expect(r.proxyHeadersApplied).toBe(false);
  });

  it('never consults AFK_OPENAI_BASE_URL (OpenAI shim must not hijack Grok)', () => {
    const r = resolveXaiEndpoint('apikey', {
      readEnv: (k) => {
        if (k === 'AFK_OPENAI_BASE_URL') return 'http://localhost:11434/v1';
        return undefined;
      },
    });
    expect(r.baseURL).toBe(DEFAULT_XAI_API_BASE_URL);
  });
});

describe('resolveXaiEndpoint — GrokCliHeaderDeps forwarding', () => {
  // Verify that headerDeps.readEnv is forwarded through the oauth default path.
  it('forwards headerDeps.readEnv env-override through the oauth default path', () => {
    const r = resolveXaiEndpoint('oauth', {
      readEnv: () => undefined,
      headerDeps: headerDeps({ readEnv: () => '2.0.0' }),
    });
    expect(r.proxyHeadersApplied).toBe(true);
    expect(r.defaultHeaders['x-grok-client-version']).toBe('2.0.0');
    expect(r.defaultHeaders['User-Agent']).toBe('agent-afk (grok-cli-compat/2.0.0)');
  });

  // Verify that headerDeps.readFile (version file fallback) is forwarded through
  // the oauth default path when no env override is present.
  it('forwards headerDeps.readFile version-file fallback through the oauth default path', () => {
    const r = resolveXaiEndpoint('oauth', {
      readEnv: () => undefined,
      headerDeps: headerDeps({
        readFile: () => JSON.stringify({ version: '3.1.4' }),
        homeDir: () => '/injected-home',
      }),
    });
    expect(r.proxyHeadersApplied).toBe(true);
    expect(r.defaultHeaders['x-grok-client-version']).toBe('3.1.4');
  });

  // Verify the same forwarding when the proxy is reached via baseUrlOverride.
  it('forwards headerDeps.readEnv env-override through the baseUrlOverride proxy path', () => {
    const r = resolveXaiEndpoint('apikey', {
      baseUrlOverride: `https://${CLI_CHAT_PROXY_HOST}/v1`,
      headerDeps: headerDeps({ readEnv: () => '4.5.6' }),
    });
    expect(r.proxyHeadersApplied).toBe(true);
    expect(r.defaultHeaders['x-grok-client-version']).toBe('4.5.6');
    expect(r.defaultHeaders['User-Agent']).toBe('agent-afk (grok-cli-compat/4.5.6)');
  });

  // Verify the same forwarding through the oauth env-override path
  // (AFK_XAI_OAUTH_BASE_URL still resolves to the proxy host).
  it('forwards headerDeps.readEnv through the oauth AFK_XAI_OAUTH_BASE_URL path', () => {
    const r = resolveXaiEndpoint('oauth', {
      readEnv: (k) =>
        k === 'AFK_XAI_OAUTH_BASE_URL' ? `https://${CLI_CHAT_PROXY_HOST}/v1` : undefined,
      headerDeps: headerDeps({ readEnv: () => '5.0.0' }),
    });
    expect(r.proxyHeadersApplied).toBe(true);
    expect(r.defaultHeaders['x-grok-client-version']).toBe('5.0.0');
  });

  // When headerDeps has no valid sources, the endpoint falls back to
  // DEFAULT_GROK_CLI_COMPAT_VERSION — the internal seam is still honoured.
  it('falls through to clientVersion seam when headerDeps has no valid env or file', () => {
    const r = resolveXaiEndpoint('oauth', {
      readEnv: () => undefined,
      clientVersion: '7.7.7',
      headerDeps: headerDeps(), // readEnv returns undefined, readFile throws
    });
    expect(r.proxyHeadersApplied).toBe(true);
    expect(r.defaultHeaders['x-grok-client-version']).toBe('7.7.7');
  });

  // Lock the User-Agent format: agent-afk (grok-cli-compat/<version>)
  it('emits the expected User-Agent format (format lock)', () => {
    const r = resolveXaiEndpoint('oauth', {
      readEnv: () => undefined,
      clientVersion: '1.2.3',
      headerDeps: headerDeps(),
    });
    expect(r.defaultHeaders['User-Agent']).toBe('agent-afk (grok-cli-compat/1.2.3)');
  });
});
