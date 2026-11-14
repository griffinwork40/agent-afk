/** #4882: base URL host classification for credential provenance. */
import { describe, it, expect } from 'vitest';
import { classifyEndpoint, OFFICIAL_API_HOSTS } from './credential-endpoint.js';

const OPENAI = OFFICIAL_API_HOSTS.openai;

describe('classifyEndpoint', () => {
  it.each([
    'http://griffin-cm:8767/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:8000/v1',
    'http://[::1]:8000/v1', 'http://10.1.2.3/v1', 'http://172.20.0.5/v1', 'http://192.168.1.9/v1',
    'http://169.254.10.1/v1', 'http://100.83.226.50:8767/v1', 'http://[fd12::1]/v1',
    'http://box.local/v1', 'http://box.lan/v1', 'http://svc.internal/v1', 'http://nas.home.arpa/v1',
    'http://griffin-cm.tail1234.ts.net:8767/v1',
  ])('%s is local', (url) => {
    expect(classifyEndpoint(url, OPENAI)).toBe('local');
  });

  it.each([
    'https://openrouter.ai/api/v1', 'https://api.together.xyz/v1', 'https://opencode.ai/zen/v1',
    'http://8.8.8.8/v1', 'http://100.128.0.1/v1', 'not a url', '',
  ])('%s is custom', (url) => {
    expect(classifyEndpoint(url, OPENAI)).toBe('custom');
  });

  it('official hosts (trailing dot, case) are official', () => {
    expect(classifyEndpoint('https://api.openai.com/v1', OPENAI)).toBe('official');
    expect(classifyEndpoint('https://API.anthropic.com./', OFFICIAL_API_HOSTS.anthropic)).toBe('official');
    expect(classifyEndpoint('https://api.x.ai/v1', OFFICIAL_API_HOSTS.xai)).toBe('official');
    // Another provider's official host is not official for this family.
    expect(classifyEndpoint('https://api.anthropic.com', OPENAI)).toBe('custom');
  });
});
