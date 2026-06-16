/**
 * Tests for per-slot provider credential application (model slots, Stage 2).
 * @module agent/session/slot-credentials.test
 */

import { describe, expect, it } from 'vitest';
import { applySlotCredentials, type SlotCredentialTarget } from './slot-credentials.js';
import { DEFAULT_SLOT_BINDINGS, type ModelSlots } from './model-slots.js';

function slots(over: Partial<ModelSlots>): ModelSlots {
  return {
    local: over.local ?? { id: DEFAULT_SLOT_BINDINGS.local.id },
    small: over.small ?? { id: DEFAULT_SLOT_BINDINGS.small.id },
    medium: over.medium ?? { id: DEFAULT_SLOT_BINDINGS.medium.id },
    large: over.large ?? { id: DEFAULT_SLOT_BINDINGS.large.id },
  };
}

describe('applySlotCredentials', () => {
  it('routes an OpenAI-inferred slot baseUrl to openaiBaseUrl + sets apiKey', () => {
    const config: SlotCredentialTarget = { model: 'small' };
    applySlotCredentials(
      config,
      slots({ small: { id: 'gpt-4o-mini', apiKey: 'sk-openai', baseUrl: 'http://localhost:8080/v1' } }),
    );
    expect(config.apiKey).toBe('sk-openai');
    expect(config.openaiBaseUrl).toBe('http://localhost:8080/v1');
    expect(config.baseUrl).toBeUndefined();
  });

  it('routes an Anthropic-inferred slot baseUrl to baseUrl + sets apiKey', () => {
    const config: SlotCredentialTarget = { model: 'large' };
    applySlotCredentials(
      config,
      slots({ large: { id: 'claude-opus-4-8', apiKey: 'sk-ant', baseUrl: 'http://localhost:9090' } }),
    );
    expect(config.apiKey).toBe('sk-ant');
    expect(config.baseUrl).toBe('http://localhost:9090');
    expect(config.openaiBaseUrl).toBeUndefined();
  });

  it('honors an explicit provider override for a bare id', () => {
    const config: SlotCredentialTarget = { model: 'medium' };
    applySlotCredentials(
      config,
      slots({ medium: { id: 'my-local-llama', provider: 'openai', baseUrl: 'http://x/v1', apiKey: 'k' } }),
    );
    expect(config.openaiBaseUrl).toBe('http://x/v1');
    expect(config.baseUrl).toBeUndefined();
    expect(config.apiKey).toBe('k');
  });

  it('applies apiKey without touching base urls', () => {
    const config: SlotCredentialTarget = { model: 'small' };
    applySlotCredentials(config, slots({ small: { id: 'gpt-4o-mini', apiKey: 'k' } }));
    expect(config.apiKey).toBe('k');
    expect(config.openaiBaseUrl).toBeUndefined();
    expect(config.baseUrl).toBeUndefined();
  });

  it('clears apiKey for an OpenAI slot with no per-slot key (prevents #548 global-credential leak)', () => {
    // The loadConfig gate may have written an Anthropic-shaped credential before
    // bindings were installed; an OpenAI tier must not keep it.
    const config: SlotCredentialTarget = { model: 'small', apiKey: 'sk-ant-oat01-LEAK' };
    applySlotCredentials(config, slots({ small: { id: 'gpt-4o-mini' } }));
    expect(config.apiKey).toBeUndefined();
    expect(config.openaiBaseUrl).toBeUndefined();
    expect(config.baseUrl).toBeUndefined();
  });

  it('preserves apiKey for an Anthropic cloud slot with no per-slot key', () => {
    const config: SlotCredentialTarget = { model: 'large', apiKey: 'keychain-oauth' };
    applySlotCredentials(config, slots({ large: { id: 'claude-opus-4-8' } }));
    expect(config.apiKey).toBe('keychain-oauth');
    expect(config.baseUrl).toBeUndefined();
    expect(config.openaiBaseUrl).toBeUndefined();
  });

  it('clears apiKey for an Anthropic local-shim slot (baseUrl, no key) so it uses the placeholder', () => {
    const config: SlotCredentialTarget = { model: 'large', apiKey: 'sk-ant-oat01-LEAK' };
    applySlotCredentials(
      config,
      slots({ large: { id: 'claude-opus-4-8', baseUrl: 'http://localhost:9090' } }),
    );
    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBe('http://localhost:9090');
    expect(config.openaiBaseUrl).toBeUndefined();
  });

  it('is a no-op for a raw id that is not a slot alias', () => {
    const config: SlotCredentialTarget = { model: 'claude-sonnet-4-6' };
    applySlotCredentials(config, slots({ small: { id: 'gpt-4o-mini', apiKey: 'k' } }));
    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBeUndefined();
    expect(config.openaiBaseUrl).toBeUndefined();
  });

  it('credential isolation: a child at the OpenAI tier does not inherit the Anthropic tier key', () => {
    // large = Anthropic (its own key); small = OpenAI (its own key). A session
    // running `small` must end up with the OpenAI key + endpoint only.
    const table = slots({
      large: { id: 'claude-opus-4-8', apiKey: 'sk-ant-oat01-PARENT' },
      small: { id: 'gpt-4o-mini', apiKey: 'sk-openai-CHILD', baseUrl: 'http://localhost:8080/v1' },
    });
    const child: SlotCredentialTarget = { model: 'small', apiKey: 'sk-ant-oat01-PARENT' }; // inherited
    applySlotCredentials(child, table);
    expect(child.apiKey).toBe('sk-openai-CHILD');
    expect(child.openaiBaseUrl).toBe('http://localhost:8080/v1');
  });

  it('credential isolation (no per-slot key): a child at the OpenAI tier drops the inherited Anthropic key', () => {
    // small = OpenAI tier with NO per-slot key. A child that inherited the
    // parent's Anthropic key (forkSubagent parentApiKey fallback) must end up
    // with it cleared, so resolveOpenAIAuth falls back to OPENAI_API_KEY.
    const table = slots({ small: { id: 'gpt-4o-mini' } });
    const child: SlotCredentialTarget = { model: 'small', apiKey: 'sk-ant-oat01-PARENT' };
    applySlotCredentials(child, table);
    expect(child.apiKey).toBeUndefined();
  });
});
