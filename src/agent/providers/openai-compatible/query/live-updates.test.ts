/**
 * Unit tests for live-updates.ts — the setSystemPrompt helper.
 */

import { describe, it, expect } from 'vitest';
import { applySetSystemPrompt } from './live-updates.js';
import type { AgentConfig } from '../../../types/config-types.js';

function makeConfig(systemPrompt?: string): AgentConfig {
  return { systemPrompt } as AgentConfig;
}

describe('applySetSystemPrompt', () => {
  it('mutates config.systemPrompt in place when no factory is provided', () => {
    const config = makeConfig('old prompt');
    const result = applySetSystemPrompt(config, 'new prompt');
    expect(config.systemPrompt).toBe('new prompt');
    expect(result).toBe(false);
  });

  it('sets systemPrompt to undefined when basePrompt is undefined and no factory', () => {
    const config = makeConfig('old prompt');
    const result = applySetSystemPrompt(config, undefined);
    expect(config.systemPrompt).toBeUndefined();
    expect(result).toBe(false);
  });

  it('calls factory with basePrompt and assigns the result when factory is provided', () => {
    const config = makeConfig('old');
    const factory = (base: string | undefined) => `PREFIX:${base ?? ''}:SUFFIX`;
    const result = applySetSystemPrompt(config, 'custom base', factory);
    expect(config.systemPrompt).toBe('PREFIX:custom base:SUFFIX');
    expect(result).toBe(true);
  });

  it('factory receives undefined when basePrompt is undefined', () => {
    const config = makeConfig('old');
    const factory = (base: string | undefined) => `[${base}]`;
    applySetSystemPrompt(config, undefined, factory);
    expect(config.systemPrompt).toBe('[undefined]');
  });

  it('factory result replaces the prior systemPrompt value', () => {
    const config = makeConfig('initial');
    const factory = (_base: string | undefined) => 'rebuilt';
    applySetSystemPrompt(config, 'whatever', factory);
    expect(config.systemPrompt).toBe('rebuilt');
  });
});
