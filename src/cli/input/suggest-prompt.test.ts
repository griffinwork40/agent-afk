/**
 * Tests for `src/cli/input/suggest-prompt.ts` — the empty-prompt suggestion
 * prompt builder and its acceptance guard. Pure: no provider, no REPL, no env.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPromptSuggestionSystem,
  buildPromptSuggestionUser,
  hasSuggestionGrounding,
  isEchoOfLastInput,
  isValidPromptSuggestion,
  normalizePromptSuggestion,
} from './suggest-prompt.js';
import { createSuggestEngine } from './suggest.js';
import type { SuggestContext } from './suggest.js';

function makeCtx(overrides: Partial<SuggestContext> = {}): SuggestContext {
  return {
    model: 'claude-sonnet-4-5',
    cwd: '/home/user/my-project',
    getHistory: () => [],
    getDropdownTopCandidate: () => null,
    getTranscriptTail: () => '',
    getRecentCommands: () => [],
    llmEnabled: () => true,
    promptSuggestEnabled: () => true,
    ...overrides,
  };
}

describe('buildPromptSuggestionSystem', () => {
  it('asks for a single imperative line and allows an empty answer', () => {
    const sys = buildPromptSuggestionSystem();
    expect(sys).toMatch(/ONE short imperative/);
    expect(sys).toMatch(/empty string/);
  });
});

describe('buildPromptSuggestionUser', () => {
  it('includes the cwd basename, not the full path', () => {
    const user = buildPromptSuggestionUser(makeCtx({ cwd: '/home/user/my-project' }));
    expect(user).toContain('cwd: my-project');
    expect(user).not.toContain('/home/user');
  });

  it('includes recent commands and the transcript tail', () => {
    const user = buildPromptSuggestionUser(
      makeCtx({
        getRecentCommands: () => ['/review', '/ship'],
        getTranscriptTail: () => 'user: fix the parser\nassistant: done',
      }),
    );
    expect(user).toContain('/review');
    expect(user).toContain('fix the parser');
  });

  it('omits empty sections rather than emitting blank labels', () => {
    const user = buildPromptSuggestionUser(makeCtx());
    expect(user).not.toContain('recent commands:');
    expect(user).not.toContain('what just happened:');
  });

  it('caps how many recent commands are sent', () => {
    const many = Array.from({ length: 20 }, (_, i) => `/cmd${i}`);
    const user = buildPromptSuggestionUser(makeCtx({ getRecentCommands: () => many }));
    expect(user).toContain('/cmd4');
    expect(user).not.toContain('/cmd5');
  });

  it('redacts secrets before egress', () => {
    // DATA-EGRESS: transcript content reaches a possibly-different endpoint.
    const leaked = 'user: deploy with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const user = buildPromptSuggestionUser(makeCtx({ getTranscriptTail: () => leaked }));
    expect(user).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });
});

describe('hasSuggestionGrounding', () => {
  it('is false at the startup prompt (no completed turn yet)', () => {
    expect(hasSuggestionGrounding(makeCtx({ getTranscriptTail: () => '' }))).toBe(false);
  });

  it('is false when the transcript tail is only whitespace', () => {
    expect(hasSuggestionGrounding(makeCtx({ getTranscriptTail: () => '  \n ' }))).toBe(false);
  });

  it('ignores cross-session history — a stale ring alone is not grounding', () => {
    // The history ring is loaded from disk at startup, so it holds the PREVIOUS
    // session's commands. It must not by itself unlock a suggestion.
    const ctx = makeCtx({
      getTranscriptTail: () => '',
      getRecentCommands: () => ['/review', '/ship'],
      getHistory: () => ['/review', '/ship'],
    });
    expect(hasSuggestionGrounding(ctx)).toBe(false);
  });

  it('is true once a turn has completed in this session', () => {
    const ctx = makeCtx({ getTranscriptTail: () => 'user: fix the parser\nassistant: done' });
    expect(hasSuggestionGrounding(ctx)).toBe(true);
  });
});

describe('isValidPromptSuggestion', () => {
  const accepted = [
    'run the failing tests',
    '/review the open PR',
    'explain why the daemon restarts',
  ];
  for (const s of accepted) {
    it(`accepts ${JSON.stringify(s)}`, () => {
      expect(isValidPromptSuggestion(s)).toBe(true);
    });
  }

  const rejected: [string, string][] = [
    ['', 'empty'],
    ['   ', 'whitespace only'],
    [' leading space', 'leading whitespace would render detached from the caret'],
    ['line one\nline two', 'multi-line cannot render on one input row'],
    ['fix the bug\u2028rm -rf /tmp/x', 'U+2028 is a line terminator many terminals render as a break'],
    ['para one\u2029para two', 'U+2029 is a line terminator many terminals render as a break'],
    ['a'.repeat(121), 'over the length ceiling'],
    ["I cannot suggest anything useful", 'refusal'],
    ['Sorry, there is nothing to do', 'refusal'],
    ['N/A', 'refusal'],
  ];
  for (const [s, why] of rejected) {
    it(`rejects ${JSON.stringify(s.slice(0, 24))} — ${why}`, () => {
      expect(isValidPromptSuggestion(s)).toBe(false);
    });
  }
});

describe('normalizePromptSuggestion', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizePromptSuggestion('  run the tests  ')).toBe('run the tests');
  });

  it('unwraps a fully double-quoted reply', () => {
    expect(normalizePromptSuggestion('"run the tests"')).toBe('run the tests');
  });

  it('unwraps a fully single-quoted reply', () => {
    expect(normalizePromptSuggestion("'run the tests'")).toBe('run the tests');
  });

  it('drops a single trailing period', () => {
    expect(normalizePromptSuggestion('run the tests.')).toBe('run the tests');
  });

  it('keeps a trailing question mark', () => {
    expect(normalizePromptSuggestion('why did the daemon restart?')).toBe(
      'why did the daemon restart?',
    );
  });

  it('does not strip an internal quote', () => {
    expect(normalizePromptSuggestion('grep for "TODO"')).toBe('grep for "TODO"');
  });

  it('returns null for a refusal', () => {
    expect(normalizePromptSuggestion('I cannot help with that')).toBeNull();
  });

  it('returns null for an empty reply', () => {
    expect(normalizePromptSuggestion('   ')).toBeNull();
  });

  it('returns null for a multi-line reply', () => {
    expect(normalizePromptSuggestion('do this\nthen that')).toBeNull();
  });
});

describe('isEchoOfLastInput', () => {
  it('returns true when suggestion matches the last user message (case-insensitive)', () => {
    const ctx = makeCtx({
      getTranscriptTail: () =>
        'user: fix the parser\nassistant: done',
    });
    expect(isEchoOfLastInput('fix the parser', ctx)).toBe(true);
    // Case-insensitive
    expect(isEchoOfLastInput('FIX THE PARSER', ctx)).toBe(true);
    // Leading/trailing whitespace trimmed
    expect(isEchoOfLastInput('  fix the parser  ', ctx)).toBe(true);
  });

  it('returns false when suggestion differs from the last user message', () => {
    const ctx = makeCtx({
      getTranscriptTail: () =>
        'user: fix the parser\nassistant: done',
    });
    expect(isEchoOfLastInput('run the tests', ctx)).toBe(false);
    expect(isEchoOfLastInput('fix the parser now', ctx)).toBe(false);
  });

  it('returns false when the transcript is empty', () => {
    const ctx = makeCtx({ getTranscriptTail: () => '' });
    expect(isEchoOfLastInput('fix the parser', ctx)).toBe(false);
  });

  it('extracts the last user message from multi-turn transcripts', () => {
    // The most recent "user: " line should be used, not an earlier one.
    const ctx = makeCtx({
      getTranscriptTail: () =>
        'user: first message\nassistant: first reply\nuser: second message\nassistant: second reply',
    });
    expect(isEchoOfLastInput('second message', ctx)).toBe(true);
    expect(isEchoOfLastInput('first message', ctx)).toBe(false);
  });
});

describe('generatePromptSuggestion — echo guard', () => {
  function enabledCtx(overrides: Partial<SuggestContext> = {}): SuggestContext {
    return makeCtx({
      llmEnabled: () => true,
      promptSuggestEnabled: () => true,
      getTranscriptTail: () => 'user: fix the parser\nassistant: done',
      ...overrides,
    });
  }

  it('returns null when the model echoes the last user input', async () => {
    // The model returns the exact last user message — the echo guard must discard it.
    const engine = createSuggestEngine({
      completeFn: async () => 'fix the parser',
    });
    await engine.primePromptSuggestion(enabledCtx());
    expect(engine.peekPromptSuggestion()).toBeNull();
  });

  it('returns the suggestion when it differs from the last user input', async () => {
    // A different, valid suggestion should still be stored.
    const engine = createSuggestEngine({
      completeFn: async () => 'run the failing tests',
    });
    await engine.primePromptSuggestion(enabledCtx());
    expect(engine.peekPromptSuggestion()).toBe('run the failing tests');
  });
});
