/**
 * Regression tests for HandoffMaintenanceHandle.stop() — slow startup recovery
 * (#3948).
 *
 * These tests live in a dedicated file so the `vi.mock('./handoff-wiring.js')`
 * hoisting applies at module scope without interfering with the broader
 * scheduler.test.ts mock setup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Control whether recoverPendingHandoffs blocks or resolves immediately.
const recoveryState = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  settled: false,
}));

vi.mock('./handoff-wiring.js', () => ({
  recoverPendingHandoffs: async () => {
    if (recoveryState.gate) await recoveryState.gate;
    recoveryState.settled = true;
    return { renotified: 0, expired: 0 };
  },
}));

// These modules depend on handoff-wiring indirectly; mock them to avoid
// filesystem side-effects in the lease / expiry paths.
vi.mock('./lease-store.js', () => ({
  recoverExpiredLeases: () => [],
}));

vi.mock('./handoff-expiry.js', () => ({
  sweepExpiredHandoffs: () => {},
  RESUME_QUEUE_SUBDIR: 'handoff-resume',
}));

import { startHandoffMaintenance } from './handoff-maintenance.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'afk-handoff-stop-'));
  recoveryState.gate = null;
  recoveryState.settled = false;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('HandoffMaintenanceHandle.stop() — slow startup recovery (#3948)', () => {
  it('stop() does not resolve until startup recovery completes', async () => {
    let releaseRecovery!: () => void;
    recoveryState.gate = new Promise<void>((r) => { releaseRecovery = r; });

    const handle = startHandoffMaintenance({
      queueDir: dir,
      drainResumeQueue: async () => {},
    });

    // stop() is called while recovery is still pending.
    let stopResolved = false;
    const stopPromise = handle.stop().then(() => { stopResolved = true; });

    // Yield several microtask turns — stop() must NOT have resolved yet because
    // the recovery gate is still open.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(recoveryState.settled).toBe(false);

    // Release recovery — stop() must now settle.
    releaseRecovery();
    await stopPromise;

    expect(recoveryState.settled).toBe(true);
    expect(stopResolved).toBe(true);
  });

  it('stop() is idempotent: subsequent calls re-await the already-settled promise', async () => {
    // No gate — recovery resolves immediately.
    const handle = startHandoffMaintenance({
      queueDir: dir,
      drainResumeQueue: async () => {},
    });

    await handle.stop();
    expect(recoveryState.settled).toBe(true);

    // A second stop() must not throw and must resolve quickly.
    await handle.stop();
  });
});
