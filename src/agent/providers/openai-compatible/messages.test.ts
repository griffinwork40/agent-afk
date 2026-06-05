import { describe, it, expect } from 'vitest';
import { buildMessages, flattenUserContent, resolveSystemPrompt } from './messages.js';
import type { AgentConfig } from '../../types/config-types.js';

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    model: 'gpt-4o-mini',
    ...overrides,
  }) as AgentConfig;

describe('resolveSystemPrompt', () => {
  it('returns plain string as-is', () => {
    expect(resolveSystemPrompt(baseConfig({ systemPrompt: 'be helpful' }))).toBe('be helpful');
  });

  it('returns undefined for missing or empty', () => {
    expect(resolveSystemPrompt(baseConfig())).toBeUndefined();
    expect(resolveSystemPrompt(baseConfig({ systemPrompt: '' }))).toBeUndefined();
  });

  it('strips claude_code preset, keeps append', () => {
    const r = resolveSystemPrompt(
      baseConfig({ systemPrompt: { type: 'preset', preset: 'claude_code', append: 'extra' } }),
    );
    expect(r).toBe('extra');
  });

  it('returns undefined if preset has no append', () => {
    const r = resolveSystemPrompt(
      baseConfig({ systemPrompt: { type: 'preset', preset: 'claude_code' } }),
    );
    expect(r).toBeUndefined();
  });
});

describe('flattenUserContent', () => {
  it('returns string content unchanged', () => {
    expect(flattenUserContent('hello world')).toBe('hello world');
  });

  it('joins text blocks with newlines', () => {
    expect(
      flattenUserContent([
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ]),
    ).toBe('line 1\nline 2');
  });

  it('stubs image blocks to a placeholder', () => {
    expect(
      flattenUserContent([
        { type: 'text', text: 'see this:' },
        // Minimal valid image block shape — exact source shape doesn't matter for the flatten.
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } } as never,
      ]),
    ).toBe('see this:\n[image omitted]');
  });
});

describe('buildMessages', () => {
  it('emits system + user when system prompt set', () => {
    const m = buildMessages({
      config: baseConfig({ systemPrompt: 'sys' }),
      currentUserText: 'hi',
    });
    expect(m).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('omits system when not set', () => {
    const m = buildMessages({ config: baseConfig(), currentUserText: 'hi' });
    expect(m).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('expands resumeHistory before current user turn', () => {
    const m = buildMessages({
      config: baseConfig({ systemPrompt: 'sys' }),
      resumeHistory: [
        { user: 'q1', assistant: 'a1' },
        { user: 'q2', assistant: 'a2' },
      ],
      currentUserText: 'q3',
    });
    expect(m).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
    ]);
  });

  it('skips empty turn halves in resumeHistory', () => {
    const m = buildMessages({
      config: baseConfig(),
      resumeHistory: [{ user: 'q', assistant: '' }],
      currentUserText: 'next',
    });
    expect(m).toEqual([
      { role: 'user', content: 'q' },
      { role: 'user', content: 'next' },
    ]);
  });

  it('appends priorTurns after history but before current user turn', () => {
    const m = buildMessages({
      config: baseConfig(),
      priorTurns: [
        { role: 'assistant', content: 'thinking...' },
        { role: 'tool', content: 'tool result', tool_call_id: 'call_1' },
      ],
      currentUserText: 'continue',
    });
    expect(m).toEqual([
      { role: 'assistant', content: 'thinking...' },
      { role: 'tool', content: 'tool result', tool_call_id: 'call_1' },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('handles a turn with no currentUserText (e.g. continuation of a tool loop)', () => {
    const m = buildMessages({
      config: baseConfig(),
      priorTurns: [{ role: 'tool', content: 'r', tool_call_id: 'x' }],
    });
    expect(m).toEqual([{ role: 'tool', content: 'r', tool_call_id: 'x' }]);
  });
});
