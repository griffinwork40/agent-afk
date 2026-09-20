/**
 * Tests for the error utilities in src/utils/errors.ts.
 *
 * @module utils/errors.test
 */
import { describe, expect, it } from 'vitest';
import {
  errorMessage,
  AbortError,
  TimeoutError,
  IdleWatchdogError,
  HookBlockedError,
  StreamIncompleteError,
  BudgetExceededError,
  DenialCircuitBreakerError,
  UnsupportedProviderConfigError,
} from './errors.js';

// ── errorMessage() ────────────────────────────────────────────────────────────

describe('errorMessage', () => {
  it('returns Error.message for an Error instance', () => {
    expect(errorMessage(new Error('something went wrong'))).toBe('something went wrong');
  });

  it('returns Error.message for a subclass of Error', () => {
    class CustomError extends Error {}
    expect(errorMessage(new CustomError('custom'))).toBe('custom');
  });

  it('stringifies a raw string', () => {
    expect(errorMessage('raw string error')).toBe('raw string error');
  });

  it('stringifies a number', () => {
    expect(errorMessage(42)).toBe('42');
  });

  it('stringifies a boolean', () => {
    expect(errorMessage(false)).toBe('false');
    expect(errorMessage(true)).toBe('true');
  });

  it('stringifies null', () => {
    expect(errorMessage(null)).toBe('null');
  });

  it('stringifies undefined', () => {
    expect(errorMessage(undefined)).toBe('undefined');
  });

  it('stringifies a plain object using String()', () => {
    expect(errorMessage({ code: 404 })).toBe('[object Object]');
  });

  it('stringifies an array', () => {
    expect(errorMessage([1, 2, 3])).toBe('1,2,3');
  });

  it('handles an Error with an empty message', () => {
    expect(errorMessage(new Error(''))).toBe('');
  });

  it('handles a Symbol (String coercion produces "Symbol(...)")', () => {
    const sym = Symbol('oops');
    // Symbol cannot be implicitly coerced — String() handles it explicitly.
    expect(errorMessage(sym)).toBe('Symbol(oops)');
  });
});

// ── AbortError ────────────────────────────────────────────────────────────────

describe('AbortError', () => {
  it('is an instance of Error', () => {
    expect(new AbortError()).toBeInstanceOf(Error);
  });

  it('has name "AbortError"', () => {
    expect(new AbortError().name).toBe('AbortError');
  });

  it('stores the provided message', () => {
    expect(new AbortError('aborted').message).toBe('aborted');
  });

  it('can be constructed without arguments', () => {
    expect(() => new AbortError()).not.toThrow();
  });

  it('is caught by instanceof AbortError', () => {
    const err = new AbortError('x');
    expect(err instanceof AbortError).toBe(true);
  });
});

// ── TimeoutError ──────────────────────────────────────────────────────────────

describe('TimeoutError', () => {
  it('is an instance of Error', () => {
    expect(new TimeoutError('timed out', 5000)).toBeInstanceOf(Error);
  });

  it('has name "TimeoutError"', () => {
    expect(new TimeoutError('timed out', 5000).name).toBe('TimeoutError');
  });

  it('stores the message', () => {
    expect(new TimeoutError('too slow', 3000).message).toBe('too slow');
  });

  it('stores timeoutMs as a public readonly property', () => {
    const err = new TimeoutError('timed out', 8000);
    expect(err.timeoutMs).toBe(8000);
  });
});

// ── IdleWatchdogError ─────────────────────────────────────────────────────────

describe('IdleWatchdogError', () => {
  it('is an instance of TimeoutError', () => {
    expect(new IdleWatchdogError('idle', 480_000)).toBeInstanceOf(TimeoutError);
  });

  it('is an instance of Error', () => {
    expect(new IdleWatchdogError('idle', 480_000)).toBeInstanceOf(Error);
  });

  it('has name "IdleWatchdogError"', () => {
    expect(new IdleWatchdogError('idle', 480_000).name).toBe('IdleWatchdogError');
  });

  it('exposes timeoutMs from the TimeoutError parent', () => {
    const err = new IdleWatchdogError('idle timeout', 480_000);
    expect(err.timeoutMs).toBe(480_000);
    expect(err.message).toBe('idle timeout');
  });
});

// ── HookBlockedError ──────────────────────────────────────────────────────────

describe('HookBlockedError', () => {
  it('is an instance of Error', () => {
    expect(new HookBlockedError('blocked', 'PreToolUse')).toBeInstanceOf(Error);
  });

  it('has name "HookBlockedError"', () => {
    expect(new HookBlockedError('blocked', 'PreToolUse').name).toBe('HookBlockedError');
  });

  it('stores message and event', () => {
    const err = new HookBlockedError('not allowed', 'PostToolUse');
    expect(err.message).toBe('not allowed');
    expect(err.event).toBe('PostToolUse');
  });

  it('stores optional reason', () => {
    const err = new HookBlockedError('blocked', 'PreToolUse', 'policy violation');
    expect(err.reason).toBe('policy violation');
  });

  it('reason is undefined when not provided', () => {
    const err = new HookBlockedError('blocked', 'PreToolUse');
    expect(err.reason).toBeUndefined();
  });

  it('stores cause from options', () => {
    const cause = new Error('underlying issue');
    const err = new HookBlockedError('blocked', 'PreToolUse', undefined, { cause });
    expect(err.cause).toBe(cause);
  });

  it('cause is undefined when not provided', () => {
    const err = new HookBlockedError('blocked', 'PreToolUse');
    expect(err.cause).toBeUndefined();
  });

  it('stores injectContext from options', () => {
    const err = new HookBlockedError('blocked', 'PreToolUse', undefined, {
      injectContext: 'additional context for the model',
    });
    expect(err.injectContext).toBe('additional context for the model');
  });

  it('injectContext is undefined when not provided', () => {
    const err = new HookBlockedError('blocked', 'PreToolUse');
    expect(err.injectContext).toBeUndefined();
  });
});

// ── StreamIncompleteError ─────────────────────────────────────────────────────

describe('StreamIncompleteError', () => {
  it('is an instance of Error', () => {
    expect(new StreamIncompleteError('stream cut off')).toBeInstanceOf(Error);
  });

  it('has name "StreamIncompleteError"', () => {
    expect(new StreamIncompleteError('stream cut off').name).toBe('StreamIncompleteError');
  });

  it('stores the message', () => {
    expect(new StreamIncompleteError('zero output').message).toBe('zero output');
  });

  it('toolResultsGathered is undefined by default', () => {
    expect(new StreamIncompleteError('cut off').toolResultsGathered).toBeUndefined();
  });

  it('allows toolResultsGathered to be set after construction', () => {
    const err = new StreamIncompleteError('cut off');
    err.toolResultsGathered = 3;
    expect(err.toolResultsGathered).toBe(3);
  });
});

// ── BudgetExceededError ───────────────────────────────────────────────────────

describe('BudgetExceededError', () => {
  it('is an instance of Error', () => {
    expect(new BudgetExceededError(1.5, 1.0)).toBeInstanceOf(Error);
  });

  it('has name "BudgetExceededError"', () => {
    expect(new BudgetExceededError(1.5, 1.0).name).toBe('BudgetExceededError');
  });

  it('stores runningCostUsd and maxBudgetUsd', () => {
    const err = new BudgetExceededError(1.2345, 1.0);
    expect(err.runningCostUsd).toBe(1.2345);
    expect(err.maxBudgetUsd).toBe(1.0);
  });

  it('generates a default message when none is provided', () => {
    const err = new BudgetExceededError(1.2345, 1.0);
    expect(err.message).toContain('1.2345');
    expect(err.message).toContain('1.0000');
  });

  it('uses a custom message when provided', () => {
    const err = new BudgetExceededError(1.5, 1.0, 'custom budget message');
    expect(err.message).toBe('custom budget message');
  });

  it('default message format matches the documented pattern', () => {
    const err = new BudgetExceededError(0.5678, 0.5);
    expect(err.message).toMatch(/Budget ceiling reached/);
    expect(err.message).toContain('0.5678');
    expect(err.message).toContain('0.5000');
  });
});

// ── DenialCircuitBreakerError ─────────────────────────────────────────────────

describe('DenialCircuitBreakerError', () => {
  it('is an instance of Error', () => {
    expect(new DenialCircuitBreakerError('too many denials')).toBeInstanceOf(Error);
  });

  it('has name "DenialCircuitBreakerError"', () => {
    expect(new DenialCircuitBreakerError('too many denials').name).toBe('DenialCircuitBreakerError');
  });

  it('stores the message', () => {
    expect(new DenialCircuitBreakerError('circuit broken').message).toBe('circuit broken');
  });
});

// ── UnsupportedProviderConfigError ────────────────────────────────────────────

describe('UnsupportedProviderConfigError', () => {
  it('is an instance of Error', () => {
    expect(new UnsupportedProviderConfigError('openai', 'thinking')).toBeInstanceOf(Error);
  });

  it('has name "UnsupportedProviderConfigError"', () => {
    expect(new UnsupportedProviderConfigError('openai', 'thinking').name).toBe(
      'UnsupportedProviderConfigError',
    );
  });

  it('stores provider and field', () => {
    const err = new UnsupportedProviderConfigError('openai', 'thinking');
    expect(err.provider).toBe('openai');
    expect(err.field).toBe('thinking');
  });

  it('generates a default message referencing provider and field', () => {
    const err = new UnsupportedProviderConfigError('openai', 'thinking');
    expect(err.message).toContain('openai');
    expect(err.message).toContain('thinking');
  });

  it('uses a custom message when provided', () => {
    const err = new UnsupportedProviderConfigError('openai', 'thinking', 'custom msg');
    expect(err.message).toBe('custom msg');
  });

  it('default message matches the documented format', () => {
    const err = new UnsupportedProviderConfigError('myProvider', 'myField');
    expect(err.message).toBe('myProvider provider does not support AgentConfig.myField.');
  });
});
