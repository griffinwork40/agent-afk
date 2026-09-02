import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_BACKOFF_MS,
  computeBackoffMs,
  type TaskRecord,
  type TaskState,
} from './task-lifecycle.js';

describe('task-lifecycle types and defaults', () => {
  it('DEFAULT_RETRY_POLICY has maxAttempts=1 (no-retry behaviour)', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(1);
    expect(DEFAULT_RETRY_POLICY.backoffStrategy).toBe('fixed');
    expect(DEFAULT_RETRY_POLICY.backoffBaseMs).toBe(30_000);
  });

  it('DEFAULT_LEASE_TTL_MS is 10 minutes', () => {
    expect(DEFAULT_LEASE_TTL_MS).toBe(10 * 60 * 1_000);
  });

  it('TaskState is a union that includes all expected states', () => {
    const states: TaskState[] = [
      'queued',
      'leased',
      'running',
      'succeeded',
      'failed',
      'retrying',
      'dead-letter',
    ];
    // No assertion beyond type-checking — if this compiles, the union is correct.
    expect(states).toHaveLength(7);
  });

  it('TaskRecord has the expected shape', () => {
    const record: TaskRecord = {
      id: 'q-1-abc',
      command: '/test',
      state: 'leased',
      attempts: 1,
      maxAttempts: 1,
      leaseExpiry: Date.now() + 60_000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      backoffStrategy: 'fixed',
      backoffBaseMs: 30_000,
      meta: { enqueuedAt: new Date().toISOString(), sequence: 1 },
    };
    expect(record.id).toBe('q-1-abc');
    expect(record.state).toBe('leased');
    expect(record.attempts).toBe(1);
    expect(record.maxAttempts).toBe(1);
  });
});

describe('computeBackoffMs', () => {
  it('fixed strategy always returns backoffBaseMs', () => {
    const policy = { maxAttempts: 3, backoffStrategy: 'fixed' as const, backoffBaseMs: 5_000 };
    expect(computeBackoffMs(1, policy)).toBe(5_000);
    expect(computeBackoffMs(2, policy)).toBe(5_000);
    expect(computeBackoffMs(3, policy)).toBe(5_000);
  });

  it('exponential strategy doubles delay each attempt', () => {
    const policy = { maxAttempts: 5, backoffStrategy: 'exponential' as const, backoffBaseMs: 1_000 };
    expect(computeBackoffMs(1, policy)).toBe(1_000);   // 1000 * 2^0
    expect(computeBackoffMs(2, policy)).toBe(2_000);   // 1000 * 2^1
    expect(computeBackoffMs(3, policy)).toBe(4_000);   // 1000 * 2^2
    expect(computeBackoffMs(4, policy)).toBe(8_000);   // 1000 * 2^3
  });

  it('exponential strategy with attempts=0 uses base delay', () => {
    const policy = { maxAttempts: 1, backoffStrategy: 'exponential' as const, backoffBaseMs: 2_000 };
    expect(computeBackoffMs(0, policy)).toBe(2_000); // 2^max(0,-1)=2^0=1
  });

  it('exponential strategy caps at DEFAULT_MAX_BACKOFF_MS for high attempt counts', () => {
    // attempts=20, backoffBaseMs=1000 → 1000 * 2^19 ≈ 524M ms (~145 hours) without cap
    const policy = { maxAttempts: 30, backoffStrategy: 'exponential' as const, backoffBaseMs: 1_000 };
    expect(computeBackoffMs(20, policy)).toBe(DEFAULT_MAX_BACKOFF_MS);
    expect(computeBackoffMs(30, policy)).toBe(DEFAULT_MAX_BACKOFF_MS);
  });

  it('exponential strategy respects custom maxBackoffMs', () => {
    const policy = {
      maxAttempts: 10,
      backoffStrategy: 'exponential' as const,
      backoffBaseMs: 1_000,
      maxBackoffMs: 10_000,
    };
    // attempts=4 → 1000 * 2^3 = 8000 (under cap)
    expect(computeBackoffMs(4, policy)).toBe(8_000);
    // attempts=5 → 1000 * 2^4 = 16000, capped at 10_000
    expect(computeBackoffMs(5, policy)).toBe(10_000);
    expect(computeBackoffMs(10, policy)).toBe(10_000);
  });

  it('normal backoff below the cap is unchanged', () => {
    const policy = { maxAttempts: 5, backoffStrategy: 'exponential' as const, backoffBaseMs: 1_000 };
    // Low attempt counts stay well under the 5-minute cap
    expect(computeBackoffMs(1, policy)).toBe(1_000);
    expect(computeBackoffMs(2, policy)).toBe(2_000);
    expect(computeBackoffMs(3, policy)).toBe(4_000);
    expect(computeBackoffMs(4, policy)).toBe(8_000);
  });

  it('fixed strategy is unaffected by cap when base is below cap', () => {
    const policy = { maxAttempts: 5, backoffStrategy: 'fixed' as const, backoffBaseMs: 5_000 };
    expect(computeBackoffMs(1, policy)).toBe(5_000);
    expect(computeBackoffMs(10, policy)).toBe(5_000);
  });
});
