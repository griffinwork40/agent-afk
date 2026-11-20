import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkCredential } from './auth-wizard.check.js';
import { oneShotCompletionWithStop } from '../agent/providers/anthropic-direct/oneshot.js';
import { loadConfig } from './config.js';

vi.mock('../agent/providers/anthropic-direct/oneshot.js', () => ({ oneShotCompletionWithStop: vi.fn() }));
vi.mock('./config.js', () => ({ loadConfig: vi.fn(() => ({})) }));
const fakeKey = 'sk-ant-api03-obviously-fake';
beforeEach(() => { vi.resetAllMocks(); vi.mocked(loadConfig).mockReturnValue({} as ReturnType<typeof loadConfig>); });
afterEach(() => { vi.restoreAllMocks(); });

describe('credential live check', () => {
  it('makes one minimal request with the pasted credential and a deadline', async () => {
    vi.mocked(oneShotCompletionWithStop).mockResolvedValue({ text: 'ok', stopReason: 'end' });
    expect(await checkCredential(fakeKey)).toEqual({ kind: 'accepted' });
    expect(oneShotCompletionWithStop).toHaveBeenCalledOnce();
    expect(oneShotCompletionWithStop).toHaveBeenCalledWith(expect.objectContaining({
      token: fakeKey, maxTokens: 1, signal: expect.any(AbortSignal),
    }));
  });
  it('passes the configured custom endpoint instead of forcing Anthropic', async () => {
    vi.mocked(loadConfig).mockReturnValue({ baseUrl: 'https://gateway.example.invalid' } as ReturnType<typeof loadConfig>);
    await checkCredential(fakeKey);
    expect(oneShotCompletionWithStop).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'https://gateway.example.invalid' }));
  });
  it('leaves SDK default endpoint resolution intact (including ANTHROPIC_BASE_URL)', async () => {
    await checkCredential(fakeKey);
    expect(oneShotCompletionWithStop).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: undefined }));
  });
  it.each([401, 403])('distinguishes provider rejection: %s', async (status) => {
    vi.mocked(oneShotCompletionWithStop).mockRejectedValue(Object.assign(new Error('fake rejection'), { status }));
    expect(await checkCredential(fakeKey)).toEqual({ kind: 'rejected' });
  });
  it('recognizes no-credit responses using the existing usage classifier', async () => {
    vi.mocked(oneShotCompletionWithStop).mockRejectedValue(Object.assign(new Error('invalid_request_error: Your credit balance is too low'), { status: 400 }));
    expect(await checkCredential(fakeKey)).toEqual({ kind: 'credit' });
  });
  it.each([new Error('fake offline'), Object.assign(new Error('fake overload'), { status: 503 }), Object.assign(new Error('fake unknown'), { status: 400 }), new Error('fake timeout')])('returns unknown for uncertain failures without leaking errors', async (error) => {
    vi.mocked(oneShotCompletionWithStop).mockRejectedValue(error);
    expect(await checkCredential(fakeKey)).toEqual({ kind: 'unknown' });
  });
});
