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
  THINKING_BINDING_CONTROLS_BETA_HEADER,
} from './auth.js';
import { h1ModelFetch } from '../shared/h1-fetch.js';

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
    // fetch: h1ModelFetch is always included to force HTTP/1.1 (issue #3335).
    expect(opts).toEqual({ authToken: 'tok', maxRetries: 0, fetch: h1ModelFetch });
    expect((opts as Record<string, unknown>)['apiKey']).toBeUndefined();
  });

  it('buildClientOptions(token, "api-key") yields { apiKey } and no authToken', () => {
    const opts = buildClientOptions('tok', 'api-key');
    // fetch: h1ModelFetch is always included to force HTTP/1.1 (issue #3335).
    expect(opts).toEqual({ apiKey: 'tok', maxRetries: 0, fetch: h1ModelFetch });
    expect((opts as Record<string, unknown>)['authToken']).toBeUndefined();
  });

  it('buildClientOptions always sets maxRetries: 0 so AFK retry layers own retries (#2422)', () => {
    // The SDK defaults to maxRetries=2; without this override the SDK retries
    // silently stack under AFK's own loop (round-retry.ts, retry-layer.ts),
    // turning each failing call into up to 3× the attempts AFK believes it is
    // making — and those SDK-level retries are invisible in the witness trace.
    expect(buildClientOptions('tok', 'api-key').maxRetries).toBe(0);
    expect(buildClientOptions('tok', 'oauth').maxRetries).toBe(0);
    expect(buildClientOptions('tok', 'api-key', 'http://127.0.0.1:8080').maxRetries).toBe(0);
    const fakeFetch = () => Promise.resolve(new Response());
    expect(buildClientOptions('tok', 'api-key', undefined, fakeFetch).maxRetries).toBe(0);
  });

  it('buildClientOptions forwards a non-empty baseUrl as the SDK-camelCase baseURL', () => {
    expect(buildClientOptions('tok', 'api-key', 'http://127.0.0.1:8080')).toEqual({
      apiKey: 'tok',
      baseURL: 'http://127.0.0.1:8080',
      maxRetries: 0,
      fetch: h1ModelFetch,
    });
    expect(buildClientOptions('oauth-tok', 'oauth', 'http://127.0.0.1:9000')).toEqual({
      authToken: 'oauth-tok',
      baseURL: 'http://127.0.0.1:9000',
      maxRetries: 0,
      fetch: h1ModelFetch,
    });
  });

  it('buildClientOptions omits baseURL when baseUrl is undefined or empty', () => {
    // fetch is always present; baseURL is omitted when not supplied (issue #3335).
    expect(buildClientOptions('tok', 'api-key')).toEqual({ apiKey: 'tok', maxRetries: 0, fetch: h1ModelFetch });
    expect(buildClientOptions('tok', 'api-key', '')).toEqual({ apiKey: 'tok', maxRetries: 0, fetch: h1ModelFetch });
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

// ── thinking-binding-controls beta (drop_block policy, Fable 5.1) ─────────

describe('buildRequestHeaders: thinkingBindingControls (drop_block, Fable 5.1)', () => {
  it('oauth + withThinkingBindingControls=true appends THINKING_BINDING_CONTROLS_BETA_HEADER', () => {
    const h = buildRequestHeaders('oauth', 'sid', 'rid', false, false, false, true);
    expect(h['anthropic-beta']).toContain(THINKING_BINDING_CONTROLS_BETA_HEADER);
    // Must keep all pre-existing oauth betas (regression guard)
    expect(h['anthropic-beta']).toContain(OAUTH_BETA_HEADER.split(',')[0]);
  });

  it('api-key + withThinkingBindingControls=true appends THINKING_BINDING_CONTROLS_BETA_HEADER', () => {
    // api-key mode normally returns an empty object; when drop_block is
    // requested the beta must be forwarded so the server surfaces
    // input_transformations instead of returning HTTP 400.
    const h = buildRequestHeaders('api-key', 'sid', 'rid', false, false, false, true);
    expect(h['anthropic-beta']).toBe(THINKING_BINDING_CONTROLS_BETA_HEADER);
  });

  it('oauth + withThinkingBindingControls=false omits THINKING_BINDING_CONTROLS_BETA_HEADER', () => {
    const h = buildRequestHeaders('oauth', 'sid', 'rid', false, false, false, false);
    expect(h['anthropic-beta']).not.toContain(THINKING_BINDING_CONTROLS_BETA_HEADER);
  });

  it('api-key + withThinkingBindingControls=false omits the beta (empty object for non-Fable)', () => {
    // Non-Fable api-key requests never send thinkingBindingControls; result
    // must be an empty object so no stray beta header corrupts unrelated calls.
    const h = buildRequestHeaders('api-key', 'sid', 'rid', false, false, false, false);
    expect(h['anthropic-beta']).toBeUndefined();
    expect(Object.keys(h)).toHaveLength(0);
  });

  it('oauth + withThinkingBindingControls=true + withEffort=true includes both betas', () => {
    const h = buildRequestHeaders('oauth', 'sid', 'rid', true, false, false, true);
    expect(h['anthropic-beta']).toContain(EFFORT_BETA_HEADER);
    expect(h['anthropic-beta']).toContain(THINKING_BINDING_CONTROLS_BETA_HEADER);
  });
});
