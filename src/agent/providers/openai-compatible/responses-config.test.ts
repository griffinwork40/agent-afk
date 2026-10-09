import { describe, it, expect } from 'vitest';
import {
  resolveWireMode,
  envFlagEnabled,
  isClaudeFamilyModel,
  buildChatGptOAuthHeaders,
  CHATGPT_BACKEND_BASE_URL,
  RESPONSES_OPT_IN_ENV,
} from './responses-config.js';

describe('resolveWireMode', () => {
  it('defaults to chat-completions when not opted in', () => {
    expect(resolveWireMode({ source: 'env' })).toEqual({ mode: 'chat-completions' });
  });

  it('forces Responses + ChatGPT backend + headers for chatgpt-oauth auth', () => {
    const res = resolveWireMode({ source: 'chatgpt-oauth', accountId: 'acct_123' });
    expect(res.mode).toBe('responses');
    expect(res.baseURL).toBe(CHATGPT_BACKEND_BASE_URL);
    expect(res.headers).toEqual({
      'OpenAI-Beta': 'responses=experimental',
      originator: 'agent-afk',
      'chatgpt-account-id': 'acct_123',
    });
  });

  it('opts a normal API-key session into Responses (no base/header override)', () => {
    expect(resolveWireMode({ source: 'env' }, true)).toEqual({ mode: 'responses' });
  });

  it('chatgpt-oauth selects Responses even when the public opt-in is false', () => {
    expect(resolveWireMode({ source: 'chatgpt-oauth', accountId: 'a' }, false).mode).toBe('responses');
  });

  // Fix 1: customBaseURL suppresses the chatgpt-oauth forced redirect
  it('when customBaseURL is set and auth is chatgpt-oauth, returns chat-completions (no baseURL override)', () => {
    const res = resolveWireMode(
      { source: 'chatgpt-oauth', accountId: 'acct_123' },
      false,
      'http://localhost:8000/v1',
    );
    expect(res.mode).toBe('chat-completions');
    expect(res.baseURL).toBeUndefined();
    expect(res.headers).toBeUndefined();
  });

  it('when customBaseURL is the chatgpt backend itself, still forces the ChatGPT route', () => {
    const res = resolveWireMode(
      { source: 'chatgpt-oauth', accountId: 'acct_123' },
      false,
      CHATGPT_BACKEND_BASE_URL,
    );
    expect(res.mode).toBe('responses');
    expect(res.baseURL).toBe(CHATGPT_BACKEND_BASE_URL);
  });

  it('when customBaseURL is empty string, still forces ChatGPT route (treated as not set)', () => {
    const res = resolveWireMode({ source: 'chatgpt-oauth', accountId: 'a' }, false, '');
    expect(res.mode).toBe('responses');
    expect(res.baseURL).toBe(CHATGPT_BACKEND_BASE_URL);
  });

  it('when customBaseURL is set but auth is not chatgpt-oauth, returns chat-completions', () => {
    const res = resolveWireMode({ source: 'env' }, false, 'http://myserver/v1');
    expect(res.mode).toBe('chat-completions');
  });
});

describe('envFlagEnabled', () => {
  it('treats 1/true/yes/on (any case, trimmed) as enabled', () => {
    for (const v of ['1', 'true', 'YES', 'on', 'On', ' true ']) expect(envFlagEnabled(v)).toBe(true);
  });
  it('treats undefined/empty/0/false/no as disabled', () => {
    for (const v of [undefined, '', '0', 'false', 'no']) expect(envFlagEnabled(v)).toBe(false);
  });
});

describe('isClaudeFamilyModel', () => {
  it('detects Claude/Anthropic-family ids (incl. versioned + short aliases + local shims)', () => {
    for (const m of [
      'sonnet', 'opus', 'haiku', 'opus-4', 'sonnet-4.5', 'haiku-3.5', 'opus_1m',
      'claude-3-5-sonnet', 'claude_x', 'claude', 'local-foo',
    ]) {
      expect(isClaudeFamilyModel(m)).toBe(true);
    }
  });
  it('does not match OpenAI / unknown / empty ids', () => {
    for (const m of ['gpt-5.5', 'gpt-5', 'o3', 'codex-x', 'mistral-large', undefined, '']) {
      expect(isClaudeFamilyModel(m)).toBe(false);
    }
  });
});

describe('buildChatGptOAuthHeaders', () => {
  it('omits chatgpt-account-id when no account id is known', () => {
    expect(buildChatGptOAuthHeaders()).toEqual({
      'OpenAI-Beta': 'responses=experimental',
      originator: 'agent-afk',
    });
  });
});

describe('RESPONSES_OPT_IN_ENV', () => {
  it('names the AFK_OPENAI_USE_RESPONSES flag (read via the central env module)', () => {
    expect(RESPONSES_OPT_IN_ENV).toBe('AFK_OPENAI_USE_RESPONSES');
  });
});
