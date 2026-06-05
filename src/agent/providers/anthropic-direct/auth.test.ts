/**
 * Pure-function tests for the `anthropic-direct` provider's auth module.
 *
 * Covers:
 *  - Token shape detection (`detectAuthMode`)
 *  - Client constructor option shape (`buildClientOptions`)
 *  - Per-request HTTP header shape (`buildRequestHeaders`)
 *  - System-prompt prefix shape (`buildSystemPrefix`)
 */

import { describe, it, expect } from 'vitest';
import {
  detectAuthMode,
  buildClientOptions,
  buildRequestHeaders,
  buildSystemPrefix,
  OAUTH_BETA_HEADER,
  EFFORT_BETA_HEADER,
  CLI_USER_AGENT,
  BILLING_HEADER_TEXT,
} from './auth.js';

describe('anthropic-direct auth', () => {
  it('detectAuthMode returns "oauth" for sk-ant-oat01-* tokens', () => {
    expect(detectAuthMode('sk-ant-oat01-abc123XYZ')).toBe('oauth');
  });

  it('detectAuthMode returns "api-key" for sk-ant-api03-* tokens', () => {
    expect(detectAuthMode('sk-ant-api03-xyz789ABC')).toBe('api-key');
  });

  it('detectAuthMode returns "api-key" for unrecognized tokens (default-safe)', () => {
    expect(detectAuthMode('garbage')).toBe('api-key');
  });

  it('buildClientOptions(token, "oauth") yields { authToken } and no apiKey', () => {
    const opts = buildClientOptions('tok', 'oauth');
    expect(opts).toEqual({ authToken: 'tok' });
    expect((opts as Record<string, unknown>)['apiKey']).toBeUndefined();
  });

  it('buildClientOptions(token, "api-key") yields { apiKey } and no authToken', () => {
    const opts = buildClientOptions('tok', 'api-key');
    expect(opts).toEqual({ apiKey: 'tok' });
    expect((opts as Record<string, unknown>)['authToken']).toBeUndefined();
  });

  it('buildClientOptions forwards a non-empty baseUrl as the SDK-camelCase baseURL', () => {
    expect(buildClientOptions('tok', 'api-key', 'http://127.0.0.1:8080')).toEqual({
      apiKey: 'tok',
      baseURL: 'http://127.0.0.1:8080',
    });
    expect(buildClientOptions('oauth-tok', 'oauth', 'http://127.0.0.1:9000')).toEqual({
      authToken: 'oauth-tok',
      baseURL: 'http://127.0.0.1:9000',
    });
  });

  it('buildClientOptions omits baseURL when baseUrl is undefined or empty', () => {
    expect(buildClientOptions('tok', 'api-key')).toEqual({ apiKey: 'tok' });
    expect(buildClientOptions('tok', 'api-key', '')).toEqual({ apiKey: 'tok' });
  });

  it('OAUTH_BETA_HEADER includes the interleaved-thinking beta', () => {
    expect(OAUTH_BETA_HEADER).toContain('interleaved-thinking-2025-05-14');
  });

  it('OAUTH_BETA_HEADER pins all pre-existing betas (regression guard)', () => {
    expect(OAUTH_BETA_HEADER).toContain('claude-code-20250219');
    expect(OAUTH_BETA_HEADER).toContain('oauth-2025-04-20');
  });

  it('OAUTH_BETA_HEADER enables the 1-hour prompt-cache TTL (extended-cache-ttl)', () => {
    // cache-policy.ts stamps `ttl: '1h'` on every cache_control breakpoint;
    // without this beta the server downgrades it to the 5-minute default. Pin
    // the beta so the cache policy's intended 1h TTL stays live.
    expect(OAUTH_BETA_HEADER).toContain('extended-cache-ttl-2025-04-11');
  });

  it('buildRequestHeaders("oauth", sid, rid) returns the cli-mimicry recipe', () => {
    const headers = buildRequestHeaders('oauth', 'sid-1', 'rid-2');
    expect(headers['anthropic-beta']).toBe(OAUTH_BETA_HEADER);
    expect(headers['x-app']).toBe('cli');
    expect(headers['User-Agent']).toBe(CLI_USER_AGENT);
    expect(headers['X-Claude-Code-Session-Id']).toBe('sid-1');
    expect(headers['x-client-request-id']).toBe('rid-2');
  });

  it('buildRequestHeaders("api-key", sid, rid) returns an empty object', () => {
    expect(buildRequestHeaders('api-key', 'sid', 'rid')).toEqual({});
  });

  it('buildRequestHeaders("oauth", ..., withEffort=true) appends effort beta', () => {
    const headers = buildRequestHeaders('oauth', 'sid', 'rid', true);
    expect(headers['anthropic-beta']).toContain(OAUTH_BETA_HEADER);
    expect(headers['anthropic-beta']).toContain(EFFORT_BETA_HEADER);
  });

  it('buildRequestHeaders("oauth", ..., withEffort=false) omits effort beta', () => {
    const headers = buildRequestHeaders('oauth', 'sid', 'rid', false);
    expect(headers['anthropic-beta']).toBe(OAUTH_BETA_HEADER);
    expect(headers['anthropic-beta']).not.toContain(EFFORT_BETA_HEADER);
  });

  it('buildRequestHeaders("api-key", ..., withEffort=true) still returns empty object', () => {
    // api-key mode never sends beta headers — effort flag has no effect.
    expect(buildRequestHeaders('api-key', 'sid', 'rid', true)).toEqual({});
  });

  it('buildSystemPrefix("oauth") returns the billing-header text block', () => {
    const prefix = buildSystemPrefix('oauth');
    expect(prefix).toEqual([{ type: 'text', text: BILLING_HEADER_TEXT }]);
    expect(prefix?.length).toBe(1);
  });

  it('buildSystemPrefix("api-key") returns null', () => {
    expect(buildSystemPrefix('api-key')).toBeNull();
  });
});
