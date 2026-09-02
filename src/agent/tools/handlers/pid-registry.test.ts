/**
 * Unit tests for SpawnedPidRegistry.
 *
 * @module agent/tools/handlers/pid-registry.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SpawnedPidRegistry } from './pid-registry.js';

describe('SpawnedPidRegistry', () => {
  let registry: SpawnedPidRegistry;

  beforeEach(() => {
    registry = new SpawnedPidRegistry();
  });

  it('starts empty', () => {
    expect(registry.size).toBe(0);
  });

  it('registers a PID and reports has() as true', () => {
    registry.register(12345);
    expect(registry.has(12345)).toBe(true);
    expect(registry.size).toBe(1);
  });

  it('returns false for unregistered PIDs', () => {
    registry.register(12345);
    expect(registry.has(99999)).toBe(false);
  });

  it('silently ignores PID 0 (guard inside register)', () => {
    registry.register(0);
    expect(registry.has(0)).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('silently ignores PID 1 (special system process)', () => {
    registry.register(1);
    expect(registry.has(1)).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('silently ignores negative PIDs', () => {
    registry.register(-1);
    expect(registry.has(-1)).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('silently ignores non-integer values', () => {
    registry.register(1.5);
    expect(registry.has(1.5)).toBe(false);
    expect(registry.size).toBe(0);
  });

  it('accepts multiple distinct PIDs', () => {
    registry.register(100);
    registry.register(200);
    registry.register(300);
    expect(registry.has(100)).toBe(true);
    expect(registry.has(200)).toBe(true);
    expect(registry.has(300)).toBe(true);
    expect(registry.size).toBe(3);
  });

  it('is idempotent: registering the same PID twice keeps size at 1', () => {
    registry.register(12345);
    registry.register(12345);
    expect(registry.size).toBe(1);
  });

  it('clear() removes all PIDs', () => {
    registry.register(100);
    registry.register(200);
    expect(registry.size).toBe(2);
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.has(100)).toBe(false);
    expect(registry.has(200)).toBe(false);
  });

  it('has() returns false after clear()', () => {
    registry.register(42);
    registry.clear();
    expect(registry.has(42)).toBe(false);
  });
});
