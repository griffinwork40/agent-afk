import { describe, it, expect, vi, beforeEach } from 'vitest';

const collectUsage = vi.fn();
const loadAnthropicCredential = vi.fn<() => string | undefined>();
const loadXaiApiKey = vi.fn<() => string | undefined>();

vi.mock('../../agent/usage/usage-snapshot.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/usage/usage-snapshot.js')>()),
  collectUsage: (...a: unknown[]) => collectUsage(...a),
}));
vi.mock('../../agent/auth/credential-resolver.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/auth/credential-resolver.js')>()),
  loadAnthropicCredential: () => loadAnthropicCredential(),
  loadXaiApiKey: () => loadXaiApiKey(),
}));

const { collectUsageSummary } = await import('./usage.js');

const NOW = 1_800_000_000_000;
const ids = (s: Awaited<ReturnType<typeof collectUsageSummary>>): string[] =>
  s.providers.map((p) => `${p.provider}/${p.account}:${p.status}`);

describe('collectUsageSummary credential placeholders', () => {
  beforeEach(() => {
    collectUsage.mockResolvedValue({ records: [], anthropic: { kind: 'unavailable', reason: 'no-token' } });
    loadAnthropicCredential.mockReturnValue(undefined);
    loadXaiApiKey.mockReturnValue(undefined);
  });

  it('lists a ChatGPT/Codex sign-in as an unknown codex subscription', async () => {
    const s = await collectUsageSummary(NOW, { chatgpt: () => ({ source: 'chatgpt-oauth' }), openaiApiKey: () => undefined });
    expect(ids(s)).toEqual(['codex/chatgpt-subscription:unknown']);
  });

  it('still lists an expired ChatGPT sign-in (usage unknown, not absent)', async () => {
    const s = await collectUsageSummary(NOW, { chatgpt: () => ({ source: 'chatgpt-oauth-expired' }), openaiApiKey: () => undefined });
    expect(ids(s)).toEqual(['codex/chatgpt-subscription:unknown']);
  });

  it('labels an OpenAI API key as openai/api-key, never as a Codex subscription', async () => {
    const s = await collectUsageSummary(NOW, { chatgpt: () => ({ source: 'no-usable-auth' }), openaiApiKey: () => 'sk-test' });
    expect(ids(s)).toEqual(['openai/api-key:unknown']);
  });

  it('omits the openai placeholder once the ledger has an openai record', async () => {
    collectUsage.mockResolvedValue({
      records: [{ v: 1, provider: 'openai', account: 'api.openai.com', perMinute: { requestsRemaining: 10, observedAt: NOW } }],
      anthropic: { kind: 'unavailable', reason: 'no-token' },
    });
    const s = await collectUsageSummary(NOW, { chatgpt: () => ({ source: 'no-usable-auth' }), openaiApiKey: () => 'sk-test' });
    expect(s.providers.map((p) => p.provider)).toEqual(['openai']);
    expect(s.providers[0]?.account).toBe('api.openai.com');
  });

  it('shows why a signed-in Codex has no numbers when its endpoint fails', async () => {
    collectUsage.mockResolvedValue({
      records: [],
      anthropic: { kind: 'unavailable', reason: 'no-token' },
      codex: { kind: 'unavailable', reason: 'http-error', detail: 'Usage endpoint returned HTTP 403.' },
    });
    const s = await collectUsageSummary(NOW, { chatgpt: () => ({ source: 'chatgpt-oauth' }), openaiApiKey: () => undefined });
    expect(ids(s)).toEqual(['codex/chatgpt-subscription:error']);
    expect(s.providers[0]?.errorDetail).toBe('Usage endpoint returned HTTP 403.');
  });

  it('falls back to an unknown anthropic row when nothing is configured', async () => {
    const s = await collectUsageSummary(NOW, { chatgpt: () => ({ source: 'no-usable-auth' }), openaiApiKey: () => undefined });
    expect(ids(s)).toEqual(['anthropic/oauth:unknown']);
  });
});
