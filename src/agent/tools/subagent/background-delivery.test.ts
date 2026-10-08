import { describe, expect, it } from 'vitest';
import {
  backgroundDeliveryNote,
  backgroundTarget,
  resolveBackgroundDelivery,
} from './background-delivery.js';
import { BackgroundAgentRegistry } from '../../background-registry.js';

describe('resolveBackgroundDelivery', () => {
  it('depth >= 1 always routes to the root session, even when the probe says wake', () => {
    expect(resolveBackgroundDelivery({ depth: 1, backgroundAutoWake: () => true })).toBe('root-session');
    expect(resolveBackgroundDelivery({ depth: 3 })).toBe('root-session');
  });

  it('depth 0 with a true probe is auto-wake', () => {
    expect(resolveBackgroundDelivery({ depth: 0, backgroundAutoWake: () => true })).toBe('auto-wake');
  });

  it('depth 0 without a probe, or with a false probe, is next-message', () => {
    expect(resolveBackgroundDelivery({ depth: 0 })).toBe('next-message');
    expect(resolveBackgroundDelivery({ depth: 0, backgroundAutoWake: () => false })).toBe('next-message');
  });

  it('depth 0 with AFK_BG_AUTO_DELIVER=0 (backgroundAutoDeliver returns false) is manual-join, not next-message', () => {
    // When auto-deliver is disabled, BgResultNotifier.onSettled returns early
    // without buffering. Classifying as next-message would falsely promise
    // automatic delivery. manual-join tells the model to use /bgsub:join.
    expect(
      resolveBackgroundDelivery({ depth: 0, backgroundAutoDeliver: () => false }),
    ).toBe('manual-join');
    // Same result even when the wake probe would otherwise fire — deliver check
    // takes precedence because a non-buffered result can never be auto-delivered.
    expect(
      resolveBackgroundDelivery({
        depth: 0,
        backgroundAutoWake: () => true,
        backgroundAutoDeliver: () => false,
      }),
    ).toBe('manual-join');
  });

  it('depth 0 with backgroundAutoDeliver explicitly true behaves like no probe (next-message or auto-wake)', () => {
    expect(
      resolveBackgroundDelivery({ depth: 0, backgroundAutoDeliver: () => true }),
    ).toBe('next-message');
    expect(
      resolveBackgroundDelivery({ depth: 0, backgroundAutoWake: () => true, backgroundAutoDeliver: () => true }),
    ).toBe('auto-wake');
  });

  it('reads the probe live at each call', () => {
    let on = false;
    const ctx = { depth: 0, backgroundAutoWake: () => on };
    expect(resolveBackgroundDelivery(ctx)).toBe('next-message');
    on = true;
    expect(resolveBackgroundDelivery(ctx)).toBe('auto-wake');
  });
});

describe('backgroundTarget', () => {
  it('carries the registry through unchanged alongside the delivery mode', () => {
    const registry = new BackgroundAgentRegistry();
    expect(backgroundTarget({ depth: 0, backgroundRegistry: registry })).toEqual({
      registry,
      delivery: 'next-message',
    });
    expect(backgroundTarget({ depth: 0 })).toEqual({ registry: undefined, delivery: 'next-message' });
  });
});

describe('backgroundDeliveryNote', () => {
  it('every mode forbids polling', () => {
    for (const mode of ['auto-wake', 'next-message', 'manual-join', 'root-session', undefined] as const) {
      expect(backgroundDeliveryNote(mode, 'bg-1')).toMatch(/Do not poll/);
    }
  });

  it('auto-wake tells the model to end its turn and promises a wake', () => {
    const note = backgroundDeliveryNote('auto-wake', 'bg-1');
    expect(note).toMatch(/End your turn/);
    expect(note).toMatch(/woken automatically/);
  });

  it('next-message makes no wake promise but does promise automatic delivery', () => {
    const note = backgroundDeliveryNote('next-message', 'bg-1');
    expect(note).toMatch(/next user message/);
    expect(note).not.toMatch(/woken/);
    // Must promise delivery so the model knows it will arrive without polling.
    expect(note).toMatch(/delivered/);
  });

  it('manual-join does NOT promise automatic delivery and names /bgsub:join', () => {
    // Invariant: when AFK_BG_AUTO_DELIVER=0, BgResultNotifier.onSettled
    // returns early — no buffering, no injection. The note must not claim
    // delivery will happen automatically.
    const note = backgroundDeliveryNote('manual-join', 'bg-42');
    expect(note).not.toMatch(/delivered.*automatically/i);
    expect(note).not.toMatch(/woken/);
    expect(note).toMatch(/bgsub:join bg-42/);
    expect(note).toMatch(/get_background_job_health/);
    // Must still forbid polling (covered by the shared test above).
  });

  it('root-session says the result never reaches this context and names the job to cancel', () => {
    const note = backgroundDeliveryNote('root-session', 'bg-7');
    expect(note).toMatch(/top-level session, NOT to this context/);
    expect(note).toMatch(/cancel_background_job bg-7/);
    expect(note).toMatch(/mode="foreground"/);
    expect(note).not.toMatch(/woken/);
  });

  it('undefined delivery falls back to the neutral next-message wording', () => {
    expect(backgroundDeliveryNote(undefined, 'bg-1')).toBe(backgroundDeliveryNote('next-message', 'bg-1'));
  });
});
