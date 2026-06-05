/**
 * Tests for IdleDetector — pure in-memory concurrency counter.
 * @module agent/daemon/idle-detector.test
 */

import { describe, it, expect } from 'vitest';
import { IdleDetector } from './idle-detector.js';

describe('IdleDetector', () => {
  it('starts idle', () => {
    const d = new IdleDetector();
    expect(d.isIdle()).toBe(true);
    expect(d.count()).toBe(0);
  });

  it('isIdle false after increment', () => {
    const d = new IdleDetector();
    d.increment();
    expect(d.isIdle()).toBe(false);
    expect(d.count()).toBe(1);
  });

  it('isIdle true after increment then decrement', () => {
    const d = new IdleDetector();
    d.increment();
    d.decrement();
    expect(d.isIdle()).toBe(true);
    expect(d.count()).toBe(0);
  });

  it('count floors at 0 on over-decrement (no-op below zero)', () => {
    const d = new IdleDetector();
    d.decrement();
    expect(d.count()).toBe(0);
    expect(d.isIdle()).toBe(true);
    // Two decrements from 0 still floor at 0
    d.decrement();
    expect(d.count()).toBe(0);
  });

  it('tracks two concurrent in-flight tasks', () => {
    const d = new IdleDetector();
    d.increment();
    d.increment();
    expect(d.count()).toBe(2);
    expect(d.isIdle()).toBe(false);
    d.decrement();
    expect(d.count()).toBe(1);
    expect(d.isIdle()).toBe(false);
    d.decrement();
    expect(d.count()).toBe(0);
    expect(d.isIdle()).toBe(true);
  });
});
