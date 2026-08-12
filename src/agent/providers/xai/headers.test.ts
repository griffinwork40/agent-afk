import { describe, it, expect } from 'vitest';
import {
  isCliChatProxyBaseUrl,
  resolveGrokCliIdentityHeaders,
} from './headers.js';

describe('isCliChatProxyBaseUrl', () => {
  it('matches the default CLI proxy host', () => {
    expect(isCliChatProxyBaseUrl('https://cli-chat-proxy.grok.com/v1')).toBe(true);
  });

  it('rejects api.x.ai', () => {
    expect(isCliChatProxyBaseUrl('https://api.x.ai/v1')).toBe(false);
  });
});

describe('resolveGrokCliIdentityHeaders', () => {
  it('sets CLI identity headers without Authorization or JWT material', () => {
    const h = resolveGrokCliIdentityHeaders({ clientVersion: '1.0.0' });
    expect(h['X-XAI-Token-Auth']).toBe('xai-grok-cli');
    expect(h['x-grok-client-version']).toBe('1.0.0');
    expect(h['x-grok-client-identifier']).toBe('grok-shell');
    expect(h['User-Agent']).toContain('agent-afk/1.0.0');
    expect(h['Authorization']).toBeUndefined();
    expect(JSON.stringify(h)).not.toMatch(/eyJ/); // no JWT-looking blobs
  });
});
