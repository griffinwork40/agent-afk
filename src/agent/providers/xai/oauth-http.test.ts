import { describe, expect, it } from 'vitest';
import { tokenResponseToBundle } from './oauth-http.js';

describe('tokenResponseToBundle', () => {
  const base = { access_token: 'at', refresh_token: 'rt' };
  const fixedNow = () => 1000;

  it('passes through a normal expires_in', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: 3600 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 3600);
  });

  it('floors expires_in: 0 above the refresh skew', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: 0 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 240);
  });

  it('floors negative expires_in above the refresh skew', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: -500 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 240);
  });

  it('floors expires_in below the refresh-safe minimum', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: 30 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 240);
  });

  it('allows expires_in at the ceiling (86400)', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: 86400 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 86400);
  });

  it('caps expires_in above ceiling to 86400', () => {
    const b = tokenResponseToBundle({ ...base, expires_in: 999999 }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 86400);
  });

  it('defaults to 3600 when expires_in is not a number', () => {
    const b = tokenResponseToBundle({ ...base }, fixedNow);
    expect(b?.expires_at).toBe(1000 + 3600);
  });
});
