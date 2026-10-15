/**
 * applyAutoDisable must survive (and report) an unreadable schedules.json:
 * the store now throws UnreadableSchedulesError rather than overwriting it,
 * and a scheduler tick must neither crash nor swallow that silently.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./schedule-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./schedule-store.js')>();
  return {
    ...actual,
    toggleScheduleEnabled: vi.fn(() => {
      throw new actual.UnreadableSchedulesError('/tmp/schedules.json', 'file is not valid JSON (x)');
    }),
  };
});

import { applyAutoDisable } from './scheduler.runat-gate.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyAutoDisable with an unreadable store', () => {
  it('does not throw, still unregisters, and logs the store error', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unregister = vi.fn();
    expect(() => applyAutoDisable('nightly', unregister)).not.toThrow();
    expect(unregister).toHaveBeenCalledWith('nightly');
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not auto-disable nightly: [schedule-store] refusing to modify /tmp/schedules.json'),
    );
  });
});
