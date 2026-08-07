/**
 * Tests for the Telegram auth matrix.
 *
 * Previously inline in src/telegram.ts's main(), so the only way to exercise
 * "which credential does the bot run on" was to boot a daemon with real
 * secrets. The plan/apply split makes the decision pure and the effect narrow.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  planTelegramCredential,
  applyTelegramCredentialPlan,
  isOpenAiRoutedProvider,
} from './credentials.js';

const OAUTH_TOKEN = 'sk-ant-oat01-example';
const API_KEY = 'sk-ant-api03-example';

const savedOauth = process.env['CLAUDE_CODE_OAUTH_TOKEN']; // audit-env-access: allow — test save/restore
const savedApiKey = process.env['ANTHROPIC_API_KEY']; // audit-env-access: allow — test save/restore

beforeEach(() => {
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  delete process.env['ANTHROPIC_API_KEY'];
});

afterEach(() => {
  if (savedOauth === undefined) delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  else process.env['CLAUDE_CODE_OAUTH_TOKEN'] = savedOauth;
  if (savedApiKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = savedApiKey;
});

describe('isOpenAiRoutedProvider', () => {
  it('covers both the current and the legacy provider name', () => {
    expect(isOpenAiRoutedProvider('openai-compatible')).toBe(true);
    expect(isOpenAiRoutedProvider('openai-codex')).toBe(true);
    expect(isOpenAiRoutedProvider('anthropic-direct')).toBe(false);
  });
});

describe('planTelegramCredential — OpenAI-routed models', () => {
  it('reports the env key when one is set', () => {
    const plan = planTelegramCredential('openai-compatible', { openaiApiKey: 'sk-oai' });
    expect(plan.kind).toBe('openai');
    expect(plan.kind === 'openai' && plan.notices[0]).toContain('OPENAI_API_KEY / CODEX_API_KEY');
  });

  it('falls back to CODEX_API_KEY', () => {
    const plan = planTelegramCredential('openai-codex', { codexApiKey: 'sk-codex' });
    expect(plan.kind === 'openai' && plan.notices[0]).toContain('OPENAI_API_KEY / CODEX_API_KEY');
  });

  it('surfaces the ~/.codex/auth.json fallback path when neither is set', () => {
    const plan = planTelegramCredential('openai-compatible', {
      openaiApiKey: undefined,
      codexApiKey: undefined,
    });
    expect(plan.kind === 'openai' && plan.notices[0]).toContain('~/.codex/auth.json');
  });

  it('never consults the Anthropic credential loader', () => {
    const loadAnthropicCredential = vi.fn();
    planTelegramCredential('openai-compatible', { openaiApiKey: 'sk', loadAnthropicCredential });
    expect(loadAnthropicCredential).not.toHaveBeenCalled();
  });
});

describe('planTelegramCredential — Claude models', () => {
  it('routes an oauth-shaped token to CLAUDE_CODE_OAUTH_TOKEN', () => {
    const plan = planTelegramCredential('anthropic-direct', {
      loadAnthropicCredential: () => OAUTH_TOKEN,
    });
    expect(plan).toMatchObject({ kind: 'anthropic', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' });
  });

  it('routes an api-key-shaped token to ANTHROPIC_API_KEY', () => {
    const plan = planTelegramCredential('anthropic-direct', {
      loadAnthropicCredential: () => API_KEY,
    });
    expect(plan).toMatchObject({ kind: 'anthropic', envVar: 'ANTHROPIC_API_KEY' });
  });

  it('reports missing when the loader returns undefined', () => {
    const plan = planTelegramCredential('anthropic-direct', {
      loadAnthropicCredential: () => undefined,
    });
    expect(plan.kind).toBe('missing');
    expect(plan.kind === 'missing' && plan.errors.join(' ')).toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('treats an empty-string credential as missing', () => {
    const plan = planTelegramCredential('anthropic-direct', {
      loadAnthropicCredential: () => '',
    });
    expect(plan.kind).toBe('missing');
  });

  it('is pure — writes nothing to process.env', () => {
    planTelegramCredential('anthropic-direct', { loadAnthropicCredential: () => OAUTH_TOKEN });
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
  });
});

describe('applyTelegramCredentialPlan', () => {
  it('stashes an oauth token and threads it onto config.apiKey', () => {
    const config: { apiKey?: string | undefined } = {};
    const plan = planTelegramCredential('anthropic-direct', {
      loadAnthropicCredential: () => OAUTH_TOKEN,
    });
    expect(applyTelegramCredentialPlan(plan, config, { log: () => {} })).toBe(true);
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBe(OAUTH_TOKEN);
    expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(config.apiKey).toBe(OAUTH_TOKEN);
  });

  it('stashes an api-key token under ANTHROPIC_API_KEY', () => {
    const config: { apiKey?: string | undefined } = {};
    const plan = planTelegramCredential('anthropic-direct', {
      loadAnthropicCredential: () => API_KEY,
    });
    applyTelegramCredentialPlan(plan, config, { log: () => {} });
    expect(process.env['ANTHROPIC_API_KEY']).toBe(API_KEY);
    expect(process.env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(config.apiKey).toBe(API_KEY);
  });

  it('returns false and emits errors for a missing credential, without exiting', () => {
    const error = vi.fn();
    const config: { apiKey?: string | undefined } = {};
    const plan = planTelegramCredential('anthropic-direct', {
      loadAnthropicCredential: () => undefined,
    });
    expect(applyTelegramCredentialPlan(plan, config, { error })).toBe(false);
    expect(error).toHaveBeenCalledTimes(2);
    expect(config.apiKey).toBeUndefined();
  });

  it('leaves config.apiKey untouched for OpenAI-routed models', () => {
    const config: { apiKey?: string | undefined } = { apiKey: 'preexisting' };
    const plan = planTelegramCredential('openai-compatible', { openaiApiKey: 'sk-oai' });
    expect(applyTelegramCredentialPlan(plan, config, { log: () => {} })).toBe(true);
    expect(config.apiKey).toBe('preexisting');
  });

  it('emits the plan notices to the log sink', () => {
    const log = vi.fn();
    const plan = planTelegramCredential('anthropic-direct', {
      loadAnthropicCredential: () => OAUTH_TOKEN,
    });
    applyTelegramCredentialPlan(plan, {}, { log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('auto-refresh on 401');
  });

  it('never logs the credential itself', () => {
    const log = vi.fn();
    const plan = planTelegramCredential('anthropic-direct', {
      loadAnthropicCredential: () => OAUTH_TOKEN,
    });
    applyTelegramCredentialPlan(plan, {}, { log });
    expect(String(log.mock.calls[0]?.[0])).not.toContain(OAUTH_TOKEN);
  });
});
