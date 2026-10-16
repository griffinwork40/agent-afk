import { describe, expect, it } from 'vitest';
import { hasToolResultBlock, isUserAuthoredTurn, messageText } from './user-authored.js';

const toolResult = { type: 'tool_result', tool_use_id: 't1', content: 'ok' };

describe('hasToolResultBlock', () => {
  it('detects a tool_result block and ignores strings / empty / missing content', () => {
    expect(hasToolResultBlock([toolResult])).toBe(true);
    expect(hasToolResultBlock([{ type: 'text', text: 'hi' }])).toBe(false);
    expect(hasToolResultBlock('plain')).toBe(false);
    expect(hasToolResultBlock([])).toBe(false);
    expect(hasToolResultBlock(undefined)).toBe(false);
    expect(hasToolResultBlock(null)).toBe(false);
  });
});

describe('messageText', () => {
  it('passes strings through and joins only text blocks', () => {
    expect(messageText('plain')).toBe('plain');
    expect(
      messageText([
        { type: 'text', text: 'a' },
        { type: 'image', source: {} } as never,
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a b');
    expect(messageText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], '\n')).toBe('a\nb');
    expect(messageText(undefined)).toBe('');
  });
});

describe('isUserAuthoredTurn', () => {
  it('accepts user text in string or block form (Anthropic, OpenAI, journal shapes)', () => {
    expect(isUserAuthoredTurn({ role: 'user', content: 'hello' })).toBe(true);
    expect(isUserAuthoredTurn({ role: 'user', content: [{ type: 'text', text: 'hello' }] })).toBe(true);
  });

  it('rejects non-user roles, including OpenAI role:tool output', () => {
    expect(isUserAuthoredTurn({ role: 'assistant', content: 'hi' })).toBe(false);
    expect(isUserAuthoredTurn({ role: 'tool', content: 'output' })).toBe(false);
    expect(isUserAuthoredTurn({ role: 'system', content: 'sys' })).toBe(false);
  });

  it('rejects a tool-round carrier regardless of the harness text beside it', () => {
    for (const text of ['[vitals] Thu 18:31 EDT · turn 4s', 'queued follow-up', 'anything']) {
      expect(isUserAuthoredTurn({ role: 'user', content: [toolResult, { type: 'text', text }] })).toBe(false);
    }
  });

  it('rejects empty, whitespace-only, and image-only user turns', () => {
    expect(isUserAuthoredTurn({ role: 'user', content: '   ' })).toBe(false);
    expect(isUserAuthoredTurn({ role: 'user', content: [] })).toBe(false);
    expect(isUserAuthoredTurn({ role: 'user', content: [{ type: 'image_url' }] })).toBe(false);
  });

  it('does not filter a typed prompt by its text, even one that looks like a harness note', () => {
    expect(isUserAuthoredTurn({ role: 'user', content: '[vitals] what does this line mean?' })).toBe(true);
  });
});
