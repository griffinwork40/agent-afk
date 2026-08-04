// Contract: live-apply runs AFTER a successful persist. The load-bearing rule is
// that it can never turn a saved write into a reported failure — so every
// non-applied path must resolve (not throw) and must be distinguishable from a
// write error by the caller.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applyConfigLive,
  isLiveAppliable,
  liveAppliableKeys,
  type LiveApplyHandle,
} from './live-apply.js';
import { getActiveTheme, applyTheme } from '../theme.js';

function fakeHandle(overrides: Partial<LiveApplyHandle> = {}): LiveApplyHandle & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    setModel: async (id: string) => {
      calls.push(`setModel:${id}`);
    },
    noteModel: (id: string) => {
      calls.push(`noteModel:${id}`);
    },
    repaint: () => {
      calls.push('repaint');
    },
    ...overrides,
  };
}

const themeBefore = getActiveTheme();
afterEach(() => {
  applyTheme(themeBefore);
  vi.restoreAllMocks();
});

describe('isLiveAppliable', () => {
  it('covers exactly the keys with a proven mid-session mutator', () => {
    expect(liveAppliableKeys().sort()).toEqual(['model', 'theme']);
    expect(isLiveAppliable('model')).toBe(true);
    expect(isLiveAppliable('theme')).toBe(true);
    expect(isLiveAppliable('temperature')).toBe(false);
  });

  it('is not fooled by inherited Object properties', () => {
    expect(isLiveAppliable('toString')).toBe(false);
    expect(isLiveAppliable('constructor')).toBe(false);
  });
});

describe('applyConfigLive — model', () => {
  it('swaps the running model and repaints', async () => {
    const h = fakeHandle();
    const r = await applyConfigLive('model', 'opus', h);
    expect(r.applied).toBe(true);
    expect(r.applied === true && r.note).toBe('applied to this session');
    expect(h.calls).toEqual(['setModel:opus', 'noteModel:opus', 'repaint']);
  });

  it('reports a rejected setModel as not-applied, never throwing', async () => {
    const h = fakeHandle({
      setModel: async () => {
        throw new Error('provider unreachable');
      },
    });
    const r = await applyConfigLive('model', 'opus', h);
    expect(r).toEqual({ applied: false, reason: 'provider unreachable' });
  });
});

describe('applyConfigLive — theme', () => {
  it('applies a concrete theme to the process', async () => {
    const h = fakeHandle();
    const r = await applyConfigLive('theme', 'light', h);
    expect(r.applied).toBe(true);
    expect(getActiveTheme()).toBe('light');
    expect(h.calls).toContain('repaint');
  });

  it('resolves `auto` and says what it resolved to', async () => {
    const r = await applyConfigLive('theme', 'auto', fakeHandle());
    expect(r.applied).toBe(true);
    expect(r.applied === true && r.note).toMatch(/auto → (dark|light)/);
  });

  it('refuses an unparseable theme without throwing', async () => {
    const r = await applyConfigLive('theme', 'chartreuse', fakeHandle());
    expect(r).toEqual({ applied: false, reason: 'unrecognised theme "chartreuse"' });
    expect(getActiveTheme()).toBe(themeBefore);
  });
});

describe('applyConfigLive — non-live paths', () => {
  it('returns a bare not-applied for a key with no handler (no spurious warning)', async () => {
    // `reason` stays undefined so the caller prints the plain restart note
    // rather than a "saved, but not applied live" warning on a key that was
    // never expected to apply live.
    const r = await applyConfigLive('temperature', '0.5', fakeHandle());
    expect(r).toEqual({ applied: false });
  });

  it('explains itself when the surface has no live session', async () => {
    const r = await applyConfigLive('model', 'opus', undefined);
    expect(r).toEqual({ applied: false, reason: 'no live session on this surface' });
  });

  it('tolerates a handle without the optional hooks', async () => {
    const r = await applyConfigLive('model', 'opus', { setModel: async () => {} });
    expect(r.applied).toBe(true);
  });
});
