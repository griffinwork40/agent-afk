import { describe, expect, it, vi } from 'vitest';
import { createAcpProvider } from './acp.session.provider.js';
import { AnthropicDirectProvider } from '../../agent/providers/anthropic-direct/index.js';
import { OpenAICompatibleProvider } from '../../agent/providers/openai-compatible/index.js';
import { XaiProvider } from '../../agent/providers/xai/index.js';
import type { CanUseTool } from './acp.wire.js';

describe('ACP provider approval wiring', () => {
  it('keeps the callback on the Anthropic auto-routing fallback', () => {
    const canUseTool: CanUseTool = vi.fn(async () => ({ behavior: 'allow' as const }));
    const provider = createAcpProvider({ model: 'claude-sonnet-4-6', canUseTool });
    expect(provider).toBeInstanceOf(AnthropicDirectProvider);
    expect((provider as unknown as { canUseTool: CanUseTool }).canUseTool).toBe(canUseTool);
    provider.close?.();
  });

  it.each(['gpt-4.1', 'grok-4'])('keeps the callback on the non-Anthropic %s provider', (model) => {
    const canUseTool: CanUseTool = vi.fn(async () => ({ behavior: 'allow' as const }));
    const provider = createAcpProvider({ model, canUseTool });
    const inner = provider instanceof XaiProvider ? provider._innerForTesting : provider;
    expect(inner).toBeInstanceOf(OpenAICompatibleProvider);
    expect((inner as unknown as { providerOpts: { canUseTool: CanUseTool } }).providerOpts.canUseTool).toBe(canUseTool);
    provider.close?.();
  });
});
