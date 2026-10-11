import { describe, it, expect } from 'vitest';

import { appendSystemPromptBlock } from './append-system-prompt-block.js';
import type { AgentConfig } from '../types/config-types.js';

const BLOCK = '# Test block\n\nSome preamble content.';

describe('appendSystemPromptBlock', () => {
  it('appends with \\n\\n separator when a non-empty string prompt exists', () => {
    const config: AgentConfig = { systemPrompt: 'You are an agent.' };
    const out = appendSystemPromptBlock(config, BLOCK);
    expect(out.systemPrompt).toBe(`You are an agent.\n\n${BLOCK}`);
  });

  it('becomes the prompt when none is set (undefined)', () => {
    const config: AgentConfig = {};
    const out = appendSystemPromptBlock(config, BLOCK);
    expect(out.systemPrompt).toBe(BLOCK);
  });

  it('becomes the prompt when the existing string is empty', () => {
    const config: AgentConfig = { systemPrompt: '' };
    const out = appendSystemPromptBlock(config, BLOCK);
    expect(out.systemPrompt).toBe(BLOCK);
  });

  it('appends into the append slot of a preset prompt', () => {
    const config: AgentConfig = {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'extra' },
    };
    const out = appendSystemPromptBlock(config, BLOCK);
    expect(out.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: `extra\n\n${BLOCK}`,
    });
  });

  it('sets append on a preset with no prior append', () => {
    const config: AgentConfig = {
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    };
    const out = appendSystemPromptBlock(config, BLOCK);
    expect(out.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: BLOCK,
    });
  });

  it('does not mutate the input config', () => {
    const config: AgentConfig = { systemPrompt: 'original' };
    appendSystemPromptBlock(config, BLOCK);
    expect(config.systemPrompt).toBe('original');
  });

  it('does not mutate the input preset config', () => {
    const sp = { type: 'preset' as const, preset: 'claude_code' as const, append: 'prior' };
    const config: AgentConfig = { systemPrompt: sp };
    appendSystemPromptBlock(config, BLOCK);
    expect(sp.append).toBe('prior');
  });
});
