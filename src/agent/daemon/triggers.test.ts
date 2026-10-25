/**
 * Tests for validateScheduledTask — specifically ISO 8601 date validation
 * on runAt and expiresAt fields (#3585).
 */

import { describe, it, expect } from 'vitest';
import { validateScheduledTask } from './triggers.js';
import type { ScheduledTask } from './triggers.js';

const baseTask: ScheduledTask = {
  taskId: 'test-task',
  command: '/cmd',
  trigger: 'cron',
  cronExpression: '* * * * *',
};

describe('validateScheduledTask — runAt ISO validation', () => {
  it('accepts a valid ISO date-only runAt', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, cronExpression: undefined, runAt: '2027-06-15' }),
    ).not.toThrow();
  });

  it('accepts a valid ISO datetime with Z runAt', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, cronExpression: undefined, runAt: '2027-06-15T12:00:00Z' }),
    ).not.toThrow();
  });

  it('rejects a locale-format runAt (01/02/2027)', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, cronExpression: undefined, runAt: '01/02/2027' }),
    ).toThrow(/runAt must be a valid ISO 8601/);
  });

  it('rejects an overflowing runAt (2026-02-30)', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, cronExpression: undefined, runAt: '2026-02-30' }),
    ).toThrow(/runAt must be a valid ISO 8601/);
  });

  it('rejects a plainly invalid runAt string', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, cronExpression: undefined, runAt: 'not-a-date' }),
    ).toThrow(/runAt must be a valid ISO 8601/);
  });

  it('includes the offending value in the runAt error message', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, cronExpression: undefined, runAt: 'not-a-date' }),
    ).toThrow(/\(got: not-a-date\)/);
  });
});

describe('validateScheduledTask — expiresAt ISO validation', () => {
  it('accepts a valid ISO date-only expiresAt', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, expiresAt: '2027-12-31' }),
    ).not.toThrow();
  });

  it('accepts a valid ISO datetime with Z expiresAt', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, expiresAt: '2027-12-31T23:59:59Z' }),
    ).not.toThrow();
  });

  it('rejects a locale-format expiresAt (01/02/2027)', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, expiresAt: '01/02/2027' }),
    ).toThrow(/expiresAt must be a valid ISO 8601/);
  });

  it('rejects an overflowing expiresAt (2026-02-30)', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, expiresAt: '2026-02-30' }),
    ).toThrow(/expiresAt must be a valid ISO 8601/);
  });

  it('rejects a plainly invalid expiresAt string', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, expiresAt: 'bad' }),
    ).toThrow(/expiresAt must be a valid ISO 8601/);
  });

  it('includes the offending value in the expiresAt error message', () => {
    expect(() =>
      validateScheduledTask({ ...baseTask, expiresAt: 'bad' }),
    ).toThrow(/\(got: bad\)/);
  });
});
