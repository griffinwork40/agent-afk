/**
 * Unit tests for classifyError. Written TDD-first before classifier.ts exists.
 *
 * Each test constructs a specific error input and asserts on the returned
 * ClassifiedError shape: kind, exitCode, userMessage, hint, and raw reference.
 */

import { describe, it, expect } from 'vitest';
import { classifyError } from './classifier.js';
import {
  BudgetExceededError,
  UnsupportedProviderConfigError,
  HookBlockedError,
  TimeoutError,
} from '../../utils/errors.js';

// ─── auth ─────────────────────────────────────────────────────────────────────

describe('classifyError — auth', () => {
  it('classifies HTTP 401 as auth', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    const result = classifyError(err);
    expect(result.kind).toBe('auth');
    expect(result.exitCode).toBe(1);
    expect(result.userMessage).toBeTruthy();
    // Must not leak raw SDK text
    expect(result.userMessage).not.toContain('Unauthorized');
  });

  it('classifies AuthenticationError by name as auth', () => {
    const err = Object.assign(new Error('some sdk message'), { name: 'AuthenticationError' });
    const result = classifyError(err);
    expect(result.kind).toBe('auth');
    expect(result.exitCode).toBe(1);
  });
});

// ─── rate_limit ───────────────────────────────────────────────────────────────

describe('classifyError — rate_limit', () => {
  it('classifies HTTP 429 as rate_limit', () => {
    const err = Object.assign(new Error('Rate limited'), { status: 429 });
    const result = classifyError(err);
    expect(result.kind).toBe('rate_limit');
    expect(result.exitCode).toBe(1);
  });

  it('classifies "too many requests" message as rate_limit', () => {
    const err = new Error('too many requests');
    const result = classifyError(err);
    expect(result.kind).toBe('rate_limit');
  });
});

// ─── budget_exceeded ──────────────────────────────────────────────────────────

describe('classifyError — budget_exceeded', () => {
  it('classifies BudgetExceededError with formatted dollar amounts', () => {
    const err = new BudgetExceededError(0.05, 0.04);
    const result = classifyError(err);
    expect(result.kind).toBe('budget_exceeded');
    expect(result.exitCode).toBe(1);
    expect(result.userMessage).toContain('$0.0500');
    expect(result.userMessage).toContain('$0.0400');
    expect(result.raw).toBe(err);
  });
});

// ─── unsupported_config ───────────────────────────────────────────────────────

describe('classifyError — unsupported_config', () => {
  it('classifies UnsupportedProviderConfigError with provider/field hint', () => {
    const err = new UnsupportedProviderConfigError('openai-codex', 'thinking');
    const result = classifyError(err);
    expect(result.kind).toBe('unsupported_config');
    expect(result.exitCode).toBe(1);
    expect(result.hint).toBeDefined();
    const hint = result.hint ?? '';
    expect(hint.includes('openai-codex') || hint.includes('thinking')).toBe(true);
  });
});

// ─── hook_blocked ────────────────────────────────────────────────────────────

describe('classifyError — hook_blocked', () => {
  it('classifies HookBlockedError with reason as hint', () => {
    const err = new HookBlockedError('hook blocked', 'SessionStart', 'policy violation');
    const result = classifyError(err);
    expect(result.kind).toBe('hook_blocked');
    expect(result.exitCode).toBe(1);
    expect(result.hint).toBe('policy violation');
  });
});

// ─── timeout ─────────────────────────────────────────────────────────────────

describe('classifyError — timeout', () => {
  it('classifies TimeoutError with exitCode 124 and hint mentioning duration', () => {
    const err = new TimeoutError('timed out', 30000);
    const result = classifyError(err);
    expect(result.kind).toBe('timeout');
    expect(result.exitCode).toBe(124);
    const hint = result.hint ?? '';
    expect(hint.includes('30000') || hint.includes('30s')).toBe(true);
  });
});

// ─── network ─────────────────────────────────────────────────────────────────

describe('classifyError — network', () => {
  it('classifies ECONNREFUSED as network', () => {
    const err = new Error('ECONNREFUSED');
    const result = classifyError(err);
    expect(result.kind).toBe('network');
    expect(result.exitCode).toBe(1);
  });
});

// ─── not_git_repo ─────────────────────────────────────────────────────────────

describe('classifyError — not_git_repo', () => {
  it('classifies "Not in a git repository." as not_git_repo', () => {
    const err = new Error('Not in a git repository.');
    const result = classifyError(err);
    expect(result.kind).toBe('not_git_repo');
    expect(result.exitCode).toBe(1);
  });
});

// ─── overloaded ──────────────────────────────────────────────────────────────

describe('classifyError — overloaded', () => {
  it('classifies HTTP 529 as overloaded', () => {
    const err = Object.assign(new Error('Overloaded'), { status: 529 });
    const result = classifyError(err);
    expect(result.kind).toBe('overloaded');
    expect(result.exitCode).toBe(1);
    expect(result.userMessage).toContain('529');
    expect(result.userMessage).not.toContain('"type":"error"');
    expect(result.hint).toBeDefined();
  });

  it('classifies HTTP 503 as overloaded', () => {
    const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
    const result = classifyError(err);
    expect(result.kind).toBe('overloaded');
    expect(result.exitCode).toBe(1);
    expect(result.userMessage).toContain('503');
  });

  it('does not leak raw SDK JSON into userMessage', () => {
    const err = Object.assign(
      new Error('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
      { status: 529 },
    );
    const result = classifyError(err);
    expect(result.kind).toBe('overloaded');
    expect(result.userMessage).not.toContain('"type":"error"');
  });
});

// ─── unknown fallback ────────────────────────────────────────────────────────

describe('classifyError — unknown fallback', () => {
  it('classifies unrecognized Error as unknown, preserves raw reference', () => {
    const err = new Error('something random');
    const result = classifyError(err);
    expect(result.kind).toBe('unknown');
    expect(result.exitCode).toBe(1);
    expect(result.raw).toBe(err);
  });

  it('classifies non-Error input as unknown with raw preserved', () => {
    const raw = 'a string';
    const result = classifyError(raw);
    expect(result.kind).toBe('unknown');
    expect(result.raw).toBe(raw);
  });
});
