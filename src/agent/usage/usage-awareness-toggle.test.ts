import { describe, it, expect, afterEach } from 'vitest';
import {
  isUsageAwarenessEnabled,
  setUsageAwareness,
  resetUsageAwarenessForTests,
} from './usage-awareness-toggle.js';

describe('usage-awareness-toggle', () => {
  afterEach(() => resetUsageAwarenessForTests());

  it('defaults to enabled', () => {
    expect(isUsageAwarenessEnabled()).toBe(true);
  });

  it('can be disabled', () => {
    setUsageAwareness(false);
    expect(isUsageAwarenessEnabled()).toBe(false);
  });

  it('can be re-enabled', () => {
    setUsageAwareness(false);
    setUsageAwareness(true);
    expect(isUsageAwarenessEnabled()).toBe(true);
  });

  it('resetForTests restores default', () => {
    setUsageAwareness(false);
    resetUsageAwarenessForTests();
    expect(isUsageAwarenessEnabled()).toBe(true);
  });
});
