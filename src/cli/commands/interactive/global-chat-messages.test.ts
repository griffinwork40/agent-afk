import { describe, it, expect } from 'vitest';
import { explainFailure, explainIdentityFailure, formatWait } from './global-chat-messages.js';
import { relayErrorLine } from './global-chat-actions.js';

describe('failure explanations', () => {
  it('formats waits', () => {
    expect(formatWait(0)).toBe('1 second');
    expect(formatWait(30_000)).toBe('30 seconds');
    expect(formatWait(90_000)).toBe('2 minutes');
    expect(formatWait(5 * 3600_000)).toBe('5 hours');
  });
  it('covers each post failure in plain language', () => {
    const f = (code: string, extra = {}) => explainFailure({ ok: false, code, message: 'm', ...extra } as never);
    expect(f('rate_limited', { retryAfterMs: 1000 })).toContain('1 second');
    expect(f('rate_limited')).toContain('too fast');
    expect(f('too_long')).toContain('500');
    expect(f('too_many_links')).toContain('2');
    expect(f('secret_detected', { spans: [{ kind: 'openai', start: 0, end: 1 }, { kind: 'jwt', start: 2, end: 3 }] })).toContain('an OpenAI API key, a JWT');
    expect(f('secret_detected', { spans: [] })).toContain('relay thinks');
    expect(f('readonly')).toContain('read-only');
    expect(f('closed')).toContain('closed');
    expect(f('not_connected')).toContain('Not connected');
    expect(f('timeout')).toContain('did not answer');
    for (const c of ['banned', 'forbidden', 'unknown_target', 'duplicate', 'stale_timestamp', 'bad_frame']) expect(f(c)).toBeTruthy();
  });
  it('explains identity failures', () => {
    expect(explainIdentityFailure({ ok: false, code: 'name_change_too_soon', retryAfterMs: 3600_000 })).toContain('once a day');
    expect(explainIdentityFailure({ ok: false, code: 'name_change_too_soon' })).toContain('later');
    for (const code of ['bad_name', 'reserved_name', 'not_created', 'already_exists'] as const) {
      expect(explainIdentityFailure({ ok: false, code })).toBeTruthy();
    }
  });
  it('relay errors with an id are left to the action result', () => {
    expect(relayErrorLine({ code: 'rate_limited', message: 'x', id: 'abc' })).toBeNull();
    expect(relayErrorLine({ code: 'banned', message: 'x' })).toContain('banned');
    expect(relayErrorLine({ code: 'secret_detected', message: 'x' })).toContain('credential');
    expect(relayErrorLine({ code: 'rate_limited', message: 'x', retryAfterMs: 4000 })).toContain('4 seconds');
  });
});
