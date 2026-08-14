/**
 * Dual-endpoint resolution tests for the xAI provider.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_XAI_API_BASE_URL,
  DEFAULT_XAI_OAUTH_BASE_URL,
  resolveXaiEndpoint,
} from './endpoints.js';
import { CLI_CHAT_PROXY_HOST } from './headers.js';

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
