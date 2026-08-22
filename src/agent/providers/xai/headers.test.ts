import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_GROK_CLI_COMPAT_VERSION,
  isCliChatProxyBaseUrl,
  readOfficialGrokCliVersion,
  resolveGrokCliIdentityHeaders,
  type GrokCliHeaderDeps,
} from './headers.js';

const VERSION_FILE = '/test-home/.grok/version.json';

function deps(overrides: Partial<GrokCliHeaderDeps> = {}): GrokCliHeaderDeps {
  return {
    readEnv: () => undefined,
    homeDir: () => '/test-home',
    readFile: () => { throw new Error('version file unavailable'); },
    ...overrides,
  };
}

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
    const h = resolveGrokCliIdentityHeaders({ clientVersion: '1.0.0' }, deps());
    expect(h['X-XAI-Token-Auth']).toBe('xai-grok-cli');
    expect(h['x-grok-client-version']).toBe('1.0.0');
    expect(h['x-grok-client-identifier']).toBe('grok-shell');
    expect(h['User-Agent']).toContain('1.0.0');
    expect(h['Authorization']).toBeUndefined();
    expect(JSON.stringify(h)).not.toMatch(/eyJ/); // no JWT-looking blobs
  });

  it('uses the environment override ahead of the compatibility seam and version file', () => {
    const readFile = vi.fn(() => JSON.stringify({ version: '1.0.5' }));
    const h = resolveGrokCliIdentityHeaders(
      { clientVersion: '1.0.4' },
      deps({ readEnv: () => ' 1.0.6 ', readFile }),
    );
    expect(h['x-grok-client-version']).toBe('1.0.6');
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each(['agent-afk', '  '])('falls through invalid environment values to the official version file: %s', (override) => {
    const h = resolveGrokCliIdentityHeaders(
      {},
      deps({
        readEnv: () => override,
        readFile: (filePath) => {
          expect(filePath).toBe(VERSION_FILE);
          return JSON.stringify({ version: ' 1.2.3-rc.1+build.42 ' });
        },
      }),
    );
    expect(h['x-grok-client-version']).toBe('1.2.3-rc.1+build.42');
  });

  it('uses the internal clientVersion seam only after no valid env override', () => {
    const readFile = vi.fn(() => JSON.stringify({ version: '1.0.5' }));
    const h = resolveGrokCliIdentityHeaders(
      { clientVersion: '1.0.4' },
      deps({ readFile }),
    );
    expect(h['x-grok-client-version']).toBe('1.0.4');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('falls through an invalid clientVersion seam to the official version file', () => {
    const h = resolveGrokCliIdentityHeaders(
      { clientVersion: 'agent-afk' },
      deps({ readFile: () => JSON.stringify({ version: '1.0.5' }) }),
    );
    expect(h['x-grok-client-version']).toBe('1.0.5');
  });

  it.each([
    'not-json',
    JSON.stringify({}),
    JSON.stringify({ version: 105 }),
    JSON.stringify({ version: '1.0' }),
    JSON.stringify({ version: '1.0.5garbage' }),
  ])('uses the fallback for unusable official version data: %s', (contents) => {
    const h = resolveGrokCliIdentityHeaders({}, deps({ readFile: () => contents }));
    expect(h['x-grok-client-version']).toBe(DEFAULT_GROK_CLI_COMPAT_VERSION);
  });

  it('uses the fallback when the official version file cannot be read', () => {
    const h = resolveGrokCliIdentityHeaders({}, deps());
    expect(h['x-grok-client-version']).toBe(DEFAULT_GROK_CLI_COMPAT_VERSION);
    expect(h['x-grok-client-version']).not.toBe('agent-afk');
  });
});

describe('readOfficialGrokCliVersion', () => {
  it('uses injected home and file dependencies', () => {
    const readFile = vi.fn(() => JSON.stringify({ version: '1.0.5' }));
    expect(readOfficialGrokCliVersion(deps({ readFile }))).toBe('1.0.5');
    expect(readFile).toHaveBeenCalledWith(VERSION_FILE);
  });
});
