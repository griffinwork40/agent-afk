/**
 * Tests for `src/cli/input/suggest-prompt.ts` — the empty-prompt suggestion
 * prompt builder and its acceptance guard. Pure: no provider, no REPL, no env.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPromptSuggestionSystem,
  buildPromptSuggestionUser,
  isValidPromptSuggestion,
  normalizePromptSuggestion,
} from './suggest-prompt.js';
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
