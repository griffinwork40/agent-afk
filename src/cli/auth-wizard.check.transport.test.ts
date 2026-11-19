import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCredential } from './auth-wizard.check.js';
import { h1ModelFetch } from '../agent/providers/shared/h1-fetch.js';
import { loadConfig } from './config.js';

// Exercise the real one-shot helper and SDK, with only the HTTP boundary mocked.
vi.mock('../agent/providers/shared/h1-fetch.js', () => ({ h1ModelFetch: vi.fn() }));
vi.mock('./config.js', () => ({ loadConfig: vi.fn(() => ({})) }));
const fakeKey = 'sk-ant-api03-obviously-fake-transport';
function response(status: number, error?: string, message?: string): Response {
  return new Response(JSON.stringify(error ? { type: 'error', error: { type: error, message } } : {
    id: 'fake-message', type: 'message', role: 'assistant', model: 'fake-model',
    content: [{ type: 'text', text: 'Hi' }], stop_reason: 'max_tokens',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status, headers: { 'content-type': 'application/json' } });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadConfig).mockReturnValue({} as ReturnType<typeof loadConfig>);
  vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
  vi.stubEnv('ANTHROPIC_API_KEY', undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('sign-in check HTTP boundary', () => {
  it('sends one tiny authenticated Messages request without retrying', async () => {
    vi.mocked(h1ModelFetch).mockResolvedValue(response(200));
    expect(await checkCredential(fakeKey)).toEqual({ kind: 'accepted' });
    expect(h1ModelFetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(h1ModelFetch).mock.calls[0]!;
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    // The installed SDK uses Bearer for API keys as of its current release.
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${fakeKey}`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] });
  });
  it.each([
    [401, 'authentication_error', 'fake rejection', 'rejected'],
    [403, 'permission_error', 'fake access denied', 'rejected'],
    [400, 'invalid_request_error', 'Your credit balance is too low', 'credit'],
    [400, 'invalid_request_error', 'fake invalid model', 'unknown'],
    [429, 'rate_limit_error', 'fake throttled', 'unknown'],
    [503, 'api_error', 'fake unavailable', 'unknown'],
  ])('classifies a real SDK error from HTTP %s', async (status, type, message, kind) => {
    vi.mocked(h1ModelFetch).mockResolvedValue(response(status, type, message));
    expect(await checkCredential(fakeKey)).toEqual({ kind });
    expect(h1ModelFetch).toHaveBeenCalledOnce();
  });
  it('honors SDK ANTHROPIC_BASE_URL without reading environment outside the registry', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.example.invalid/prefix');
    vi.mocked(h1ModelFetch).mockResolvedValue(response(200));
    await checkCredential(fakeKey);
    expect(String(vi.mocked(h1ModelFetch).mock.calls[0]?.[0])).toBe('https://gateway.example.invalid/prefix/v1/messages');
  });
  it('gives configured baseUrl precedence over SDK environment defaults', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://unused.example.invalid');
    vi.mocked(loadConfig).mockReturnValue({ baseUrl: 'https://configured.example.invalid' } as ReturnType<typeof loadConfig>);
    vi.mocked(h1ModelFetch).mockResolvedValue(response(200));
    await checkCredential(fakeKey);
    expect(String(vi.mocked(h1ModelFetch).mock.calls[0]?.[0])).toBe('https://configured.example.invalid/v1/messages');
  });
  it('treats a transport failure as unknown after one attempt', async () => {
    vi.mocked(h1ModelFetch).mockRejectedValue(new Error('fake offline'));
    expect(await checkCredential(fakeKey)).toEqual({ kind: 'unknown' });
    expect(h1ModelFetch).toHaveBeenCalledOnce();
  });
});
