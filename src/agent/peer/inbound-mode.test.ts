/**
 * Tests for `resolvePeerInboundMode` (inbound-mode.ts).
 *
 * Uses `vi.stubEnv` (Vitest-native env isolation) so no direct process.env
 * mutations appear in this file. `vi.resetModules()` is called in afterEach
 * to clear the module cache and reset the per-process `warnedValue` sentinel,
 * which otherwise prevents the debugLog warning from firing more than once.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { RAW_VALUE_CAP } from './inbound-mode.js';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function freshMode() {
  return import('./inbound-mode.js');
}

describe('resolvePeerInboundMode', () => {
  it('returns accept when AFK_PEER_INBOUND is unset', async () => {
    vi.stubEnv('AFK_PEER_INBOUND', undefined as unknown as string);
    const { resolvePeerInboundMode } = await freshMode();
    expect(resolvePeerInboundMode()).toBe('accept');
  });

  it('returns accept when AFK_PEER_INBOUND=accept', async () => {
    vi.stubEnv('AFK_PEER_INBOUND', 'accept');
    const { resolvePeerInboundMode } = await freshMode();
    expect(resolvePeerInboundMode()).toBe('accept');
  });

  it('returns hold when AFK_PEER_INBOUND=hold', async () => {
    vi.stubEnv('AFK_PEER_INBOUND', 'hold');
    const { resolvePeerInboundMode } = await freshMode();
    expect(resolvePeerInboundMode()).toBe('hold');
  });

  it('returns off when AFK_PEER_INBOUND=off', async () => {
    vi.stubEnv('AFK_PEER_INBOUND', 'off');
    const { resolvePeerInboundMode } = await freshMode();
    expect(resolvePeerInboundMode()).toBe('off');
  });

  it('returns accept (fail-open) for an invalid value like "hol"', async () => {
    vi.stubEnv('AFK_PEER_INBOUND', 'hol');
    const { resolvePeerInboundMode } = await freshMode();
    expect(resolvePeerInboundMode()).toBe('accept');
  });

  it('emits a debugLog warning for an invalid value (visible under AFK_DEBUG=1)', async () => {
    vi.stubEnv('AFK_PEER_INBOUND', 'hol');
    vi.stubEnv('AFK_DEBUG', '1');
    // Import debug module AFTER resetModules + stubEnv to get the fresh instance.
    const debugModule = await import('../../utils/debug.js');
    const spy = vi.spyOn(debugModule, 'debugLog');
    const { resolvePeerInboundMode } = await freshMode();
    resolvePeerInboundMode();

    const called = spy.mock.calls.some((args) =>
      String(args[0]).includes('AFK_PEER_INBOUND'),
    );
    expect(called).toBe(true);
  });
});

describe('getPeerInboundModeConfig', () => {
  it('returns mode=accept, invalid=false when AFK_PEER_INBOUND is unset', async () => {
    vi.stubEnv('AFK_PEER_INBOUND', undefined as unknown as string);
    const { getPeerInboundModeConfig } = await freshMode();
    const cfg = getPeerInboundModeConfig();
    expect(cfg.mode).toBe('accept');
    expect(cfg.invalid).toBe(false);
    expect(cfg.rawTruncated).toBeUndefined();
  });

  it('returns mode=hold, invalid=false when AFK_PEER_INBOUND=hold', async () => {
    vi.stubEnv('AFK_PEER_INBOUND', 'hold');
    const { getPeerInboundModeConfig } = await freshMode();
    const cfg = getPeerInboundModeConfig();
    expect(cfg.mode).toBe('hold');
    expect(cfg.invalid).toBe(false);
    expect(cfg.rawTruncated).toBeUndefined();
  });

  it('returns mode=accept, invalid=true and rawTruncated for a typo like "hol"', async () => {
    vi.stubEnv('AFK_PEER_INBOUND', 'hol');
    const { getPeerInboundModeConfig } = await freshMode();
    const cfg = getPeerInboundModeConfig();
    expect(cfg.mode).toBe('accept');
    expect(cfg.invalid).toBe(true);
    expect(cfg.rawTruncated).toBe('hol');
  });

  it('does NOT truncate rawTruncated when the invalid value is exactly RAW_VALUE_CAP chars (boundary)', async () => {
    const atCap = 'x'.repeat(RAW_VALUE_CAP);
    vi.stubEnv('AFK_PEER_INBOUND', atCap);
    const { getPeerInboundModeConfig } = await freshMode();
    const cfg = getPeerInboundModeConfig();
    expect(cfg.mode).toBe('accept');
    expect(cfg.invalid).toBe(true);
    expect(cfg.rawTruncated).toBe(atCap); // no "…" appended
  });

  it('truncates rawTruncated when the invalid value is RAW_VALUE_CAP + 1 chars (one over cap)', async () => {
    const overCap = 'x'.repeat(RAW_VALUE_CAP + 1);
    vi.stubEnv('AFK_PEER_INBOUND', overCap);
    const { getPeerInboundModeConfig } = await freshMode();
    const cfg = getPeerInboundModeConfig();
    expect(cfg.mode).toBe('accept');
    expect(cfg.invalid).toBe(true);
    expect(cfg.rawTruncated).toBe('x'.repeat(RAW_VALUE_CAP) + '…');
  });
});
