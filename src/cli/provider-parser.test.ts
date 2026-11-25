import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProvider } from './provider-parser.js';
import { AnthropicDirectProvider } from '../agent/providers/index.js';
import { OpenAICompatibleProvider } from '../agent/providers/openai-compatible/index.js';
import { XaiProvider } from '../agent/providers/xai/index.js';
import { checkToolPermission, type ToolPermissionConfig } from '../agent/tools/permissions.js';

afterEach(() => vi.unstubAllEnvs());

function permissions(provider: unknown): ToolPermissionConfig {
  if (provider instanceof XaiProvider) return permissions(provider._innerForTesting);
  if (provider instanceof OpenAICompatibleProvider) {
    return (provider as unknown as { providerOpts: { permissions: ToolPermissionConfig } }).providerOpts.permissions;
  }
  return (provider as { permissions: ToolPermissionConfig }).permissions;
}

// Read constructor-owned state, without network requests or model SDK mocks.
function approval(provider: unknown): unknown {
  if (provider instanceof XaiProvider) return approval(provider._innerForTesting);
  if (provider instanceof OpenAICompatibleProvider) {
    return (provider as unknown as { providerOpts: { canUseTool?: unknown } }).providerOpts.canUseTool;
  }
  return (provider as { canUseTool?: unknown }).canUseTool;
}

describe('parseProvider desktop allowlist', () => {
  it.each(['anthropic-direct', 'openai-compatible', 'xai', 'xai-oauth'])(
    'shares the live opt-in gate for %s', (raw) => {
      for (const value of [undefined, 'off', '1', ' TrUe ', ' YeS ', ' ON ']) {
        vi.stubEnv('AFK_DESKTOP_ENABLED', value);
        const config = permissions(parseProvider(raw));
        const enabled = value !== undefined && value !== 'off';
        expect(config.allowedTools?.includes('desktop_screenshot')).toBe(enabled);
        expect(checkToolPermission('desktop_screenshot', config).allowed).toBe(enabled);
        expect(checkToolPermission('read_file', config).allowed).toBe(true);
        expect(config.allowedTools).not.toContain('agent');
      }
    },
  );
});

describe('parseProvider approval callback', () => {
  it.each([
    ['claude-sonnet-4-6', AnthropicDirectProvider],
    ['gpt-4.1', OpenAICompatibleProvider],
    ['grok-4', XaiProvider],
  ])('preserves approval for auto-routed %s', (model, Provider) => {
    const canUseTool = vi.fn(async () => ({ behavior: 'allow' as const }));
    // Anthropic auto-selection intentionally returns undefined for the caller's fallback.
    const provider = parseProvider(model === 'claude-sonnet-4-6' ? 'anthropic-direct' : undefined,
      { model: String(model), canUseTool });
    expect(provider).toBeInstanceOf(Provider);
    expect(approval(provider)).toBe(canUseTool);
  });

  it.each(['anthropic-direct', 'openai-compatible', 'xai', 'xai-oauth'])(
    'leaves %s unchanged when the callback is absent', (raw) => {
      expect(approval(parseProvider(raw))).toBeUndefined();
    },
  );
});
