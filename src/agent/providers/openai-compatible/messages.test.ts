import { describe, it, expect } from 'vitest';
import {
  buildMessages,
  buildUserContent,
  flattenUserContent,
  imageOmittedNotice,
  resolveSystemPrompt,
  type OpenAIContentPart,
} from './messages.js';
import type { AgentConfig } from '../../types/config-types.js';

/** Minimal valid Anthropic base64 image block — `as never` because the exact
 * source-union shape doesn't matter for these conversions. */
const imgBlock = (data: string, mediaType = 'image/png') =>
  ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } }) as never;

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

  it('replaces image blocks with a graceful notice instead of silently dropping them', () => {
    const out = flattenUserContent(
      [{ type: 'text', text: 'see this:' }, imgBlock('x')],
      'gpt-3.5-turbo',
    );
    expect(out).toContain('see this:');
    expect(out).toMatch(/cannot view images/i);
    // Names the model so the user learns which model is the limitation.
    expect(out).toContain('gpt-3.5-turbo');
  });

  it('consolidates multiple images into one pluralized notice and tolerates no leading text', () => {
    const out = flattenUserContent([imgBlock('a'), imgBlock('b')]);
    expect(out).toMatch(/2 images were attached/i);
  });
});

describe('imageOmittedNotice', () => {
  it('is singular for one image', () => {
    expect(imageOmittedNotice('gpt-4', 1)).toMatch(/An image was attached/);
  });

  it('is plural for many and names the model', () => {
    const n = imageOmittedNotice('local-model', 3);
    expect(n).toMatch(/3 images were attached/);
    expect(n).toContain('local-model');
  });

  it('instructs the model to tell the user (graceful-failure contract)', () => {
    expect(imageOmittedNotice('gpt-4', 1).toLowerCase()).toContain('user');
  });
});

describe('buildUserContent', () => {
  it('passes string content through unchanged', () => {
    expect(buildUserContent('hi', { vision: true, model: 'gpt-4o' })).toBe('hi');
  });

  it('builds multimodal parts (text + image_url data-URI) for a vision model', () => {
    const out = buildUserContent([{ type: 'text', text: 'caption' }, imgBlock('AAAA', 'image/jpeg')], {
      vision: true,
      model: 'gpt-4o',
    });
    expect(out).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    ]);
  });

  it('collapses to a bare string when only one text part remains', () => {
    expect(buildUserContent([{ type: 'text', text: 'just text' }], { vision: true, model: 'gpt-4o' })).toBe(
      'just text',
    );
  });

  it('degrades to a string notice for a non-vision model', () => {
    const out = buildUserContent([{ type: 'text', text: 'caption' }, imgBlock('AAAA')], {
      vision: false,
      model: 'gpt-3.5-turbo',
    });
    expect(typeof out).toBe('string');
    expect(out).toContain('caption');
    expect(out).toMatch(/cannot view images/i);
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

  it('down-converts image parts in history to text when target model has no vision', () => {
    const parts: OpenAIContentPart[] = [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
    ];
    const m = buildMessages({
      config: baseConfig(),
      priorTurns: [{ role: 'user', content: parts }],
      vision: false,
    });
    expect(m).toHaveLength(1);
    expect(typeof m[0]!.content).toBe('string');
    expect(m[0]!.content).toContain('look');
    expect(m[0]!.content).toMatch(/cannot view images/i);
  });

  it('passes image parts through untouched when vision is true', () => {
    const parts: OpenAIContentPart[] = [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
    ];
    const m = buildMessages({
      config: baseConfig(),
      priorTurns: [{ role: 'user', content: parts }],
      vision: true,
    });
    expect(m[0]!.content).toEqual(parts);
  });
});
