import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveWebPort,
  resolveWebHost,
  resolveWebToken,
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
} from './web-options.js';

const KEYS = ['AFK_WEB_PORT', 'AFK_WEB_HOST', 'AFK_WEB_TOKEN'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveWebPort', () => {
  it('defaults when nothing is set', () => {
    expect(resolveWebPort()).toBe(DEFAULT_WEB_PORT);
  });

  it('prefers the flag over env', () => {
    process.env['AFK_WEB_PORT'] = '5000';
    expect(resolveWebPort('6000')).toBe(6000);
  });

  it('falls back to env', () => {
    process.env['AFK_WEB_PORT'] = '5000';
    expect(resolveWebPort()).toBe(5000);
  });

  it('accepts a numeric flag', () => {
    expect(resolveWebPort(7000)).toBe(7000);
  });

  it('accepts 0 (ephemeral)', () => {
    expect(resolveWebPort(0)).toBe(0);
  });

  it('ignores out-of-range and non-numeric values', () => {
    expect(resolveWebPort('99999')).toBe(DEFAULT_WEB_PORT);
    expect(resolveWebPort('-1')).toBe(DEFAULT_WEB_PORT);
    expect(resolveWebPort('abc')).toBe(DEFAULT_WEB_PORT);
  });
});

describe('resolveWebHost', () => {
  it('defaults to loopback', () => {
    expect(resolveWebHost()).toBe(DEFAULT_WEB_HOST);
  });

  it('prefers the flag over env', () => {
    process.env['AFK_WEB_HOST'] = '10.0.0.1';
    expect(resolveWebHost('0.0.0.0')).toBe('0.0.0.0');
  });

  it('falls back to env', () => {
    process.env['AFK_WEB_HOST'] = '10.0.0.1';
    expect(resolveWebHost()).toBe('10.0.0.1');
  });

  it('ignores whitespace-only input', () => {
    expect(resolveWebHost('   ')).toBe(DEFAULT_WEB_HOST);
  });
});

describe('resolveWebToken', () => {
  // Explicitness gates the non-loopback bind, so "no token" must never be
  // reported as explicit — that would defeat the refusal in checkBind().
  it('reports not-explicit when unset', () => {
    expect(resolveWebToken()).toEqual({ explicit: false });
  });

  it('reports explicit for a flag', () => {
    expect(resolveWebToken('abc')).toEqual({ token: 'abc', explicit: true });
  });

  it('reports explicit for env', () => {
    process.env['AFK_WEB_TOKEN'] = 'from-env';
    expect(resolveWebToken()).toEqual({ token: 'from-env', explicit: true });
  });

  it('prefers the flag over env', () => {
    process.env['AFK_WEB_TOKEN'] = 'from-env';
    expect(resolveWebToken('from-flag')).toEqual({ token: 'from-flag', explicit: true });
  });

  it('treats whitespace-only as absent', () => {
    expect(resolveWebToken('   ')).toEqual({ explicit: false });
  });
});
