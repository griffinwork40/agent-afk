/**
 * Tests for parseTaskRequestTime.
 *
 * @module agent/daemon/task-request-time.test
 */

import { describe, it, expect } from 'vitest';
import { parseTaskRequestTime } from './task-request-time.js';

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('parseTaskRequestTime — valid inputs', () => {
  it('accepts cron only', () => {
    const r = parseTaskRequestTime({ cron: '0 * * * *' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron).toBe('0 * * * *');
    expect(r.runAt).toBeUndefined();
    expect(r.expiresAt).toBeUndefined();
  });

  it('accepts runAt only (Z suffix)', () => {
    const r = parseTaskRequestTime({ runAt: '2099-01-01T00:00:00Z' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.runAt).toBe('2099-01-01T00:00:00Z');
  });

  it('accepts runAt with fractional seconds', () => {
    const r = parseTaskRequestTime({ runAt: '2099-01-01T00:00:00.000Z' });
    expect(r.ok).toBe(true);
  });

  it('accepts runAt with UTC offset', () => {
    const r = parseTaskRequestTime({ runAt: '2099-01-01T00:00:00+05:30' });
    expect(r.ok).toBe(true);
  });

  it('accepts date-only runAt', () => {
    const r = parseTaskRequestTime({ runAt: '2099-01-01' });
    expect(r.ok).toBe(true);
  });

  it('accepts expiresAt alongside cron', () => {
    const r = parseTaskRequestTime({ cron: '0 * * * *', expiresAt: '2099-12-31T23:59:59Z' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.expiresAt).toBe('2099-12-31T23:59:59Z');
  });

  it('passes cronExpression alias through as cron', () => {
    const r = parseTaskRequestTime({ cronExpression: '0 2 * * *' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron).toBe('0 2 * * *');
  });
});

// ---------------------------------------------------------------------------
// Structural errors
// ---------------------------------------------------------------------------

describe('parseTaskRequestTime — structural errors', () => {
  it('errors when neither cron nor runAt is supplied', () => {
    const r = parseTaskRequestTime({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/cron.*runAt|runAt.*cron/i);
  });

  it('errors when cron is not a string', () => {
    const r = parseTaskRequestTime({ cron: 42 });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runAt rejection — non-ISO and overflowing dates
// ---------------------------------------------------------------------------

describe('parseTaskRequestTime — runAt rejection', () => {
  it('rejects locale-style MM/DD/YYYY', () => {
    const r = parseTaskRequestTime({ runAt: '01/02/2027' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/ISO 8601/);
  });

  it('rejects overflowing Feb 30', () => {
    const r = parseTaskRequestTime({ runAt: '2026-02-30T00:00:00Z' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/ISO 8601/);
  });

  it('rejects Feb 29 in a non-leap year', () => {
    const r = parseTaskRequestTime({ runAt: '2026-02-29T00:00:00Z' });
    expect(r.ok).toBe(false);
  });

  it('rejects arbitrary text', () => {
    const r = parseTaskRequestTime({ runAt: 'not-a-date' });
    expect(r.ok).toBe(false);
  });

  it('rejects null for runAt (no "clear" semantic on create)', () => {
    const r = parseTaskRequestTime({ runAt: null });
    expect(r.ok).toBe(false);
  });

  it('rejects a number for runAt', () => {
    const r = parseTaskRequestTime({ runAt: 1234567890 });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// expiresAt rejection — non-ISO and overflowing dates
// ---------------------------------------------------------------------------

describe('parseTaskRequestTime — expiresAt rejection', () => {
  it('rejects locale-style for expiresAt', () => {
    const r = parseTaskRequestTime({ cron: '0 * * * *', expiresAt: '01/02/2027' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/ISO 8601/);
  });

  it('rejects overflowing Feb 30 for expiresAt', () => {
    const r = parseTaskRequestTime({ cron: '0 * * * *', expiresAt: '2026-02-30T00:00:00Z' });
    expect(r.ok).toBe(false);
  });

  it('rejects null for expiresAt (consistent with runAt on create)', () => {
    const r = parseTaskRequestTime({ cron: '0 * * * *', expiresAt: null });
    expect(r.ok).toBe(false);
  });

  it('rejects arbitrary text for expiresAt', () => {
    const r = parseTaskRequestTime({ cron: '0 * * * *', expiresAt: 'bad' });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Null consistency (item 3 from issue)
// ---------------------------------------------------------------------------

describe('parseTaskRequestTime — null consistency', () => {
  it('treats null runAt the same as null expiresAt: both rejected', () => {
    const r1 = parseTaskRequestTime({ runAt: null });
    const r2 = parseTaskRequestTime({ cron: '0 * * * *', expiresAt: null });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });
});
