/**
 * Tests for the peer-inbox startup sweep helper.
 *
 * Verifies that schedulePeerInboxSweep:
 *   - is deferred (does not run synchronously)
 *   - never throws even when sweepPeerInboxes rejects
 *   - builds the protected set from RAW readPresenceFiles minus proven-dead
 *     records (never the display filter readLivePresenceFiles)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the dependencies so no real disk I/O occurs
// ---------------------------------------------------------------------------

vi.mock('../../../agent/peer/inbox-store.js', () => ({
  sweepPeerInboxes: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../../agent/awareness/presence.js', () => ({
  readPresenceFiles: vi.fn().mockResolvedValue([]),
  readLivePresenceFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../agent/awareness/presence.reaper.js', () => ({
  sweepDeadPresence: vi.fn().mockResolvedValue(0),
}));

import { schedulePeerInboxSweep } from './peer-inbox-startup-sweep.js';
import { sweepDeadPresence } from '../../../agent/awareness/presence.reaper.js';
import { sweepPeerInboxes } from '../../../agent/peer/inbox-store.js';
import { readPresenceFiles, readLivePresenceFiles } from '../../../agent/awareness/presence.js';

const mockSweep = sweepPeerInboxes as ReturnType<typeof vi.fn>;
const mockRead = readPresenceFiles as ReturnType<typeof vi.fn>;
const mockReadLive = readLivePresenceFiles as ReturnType<typeof vi.fn>;
const mockReap = sweepDeadPresence as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.clearAllMocks();
});

describe('schedulePeerInboxSweep', () => {
  it('does not call sweepPeerInboxes synchronously (deferred)', () => {
    // Fake timers so the pending timer cannot leak into, and fire during, a
    // later test in this file.
    vi.useFakeTimers();
    try {
      schedulePeerInboxSweep(50);
      // sweepPeerInboxes must NOT have been called yet — the setTimeout is pending.
      expect(mockSweep).not.toHaveBeenCalled();
      expect(mockReap).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('calls sweepPeerInboxes after the delay with live session ids', async () => {
    mockRead.mockResolvedValueOnce([
      { sessionId: 'sess-aaa', liveness: 'alive' },
      { sessionId: 'sess-bbb', liveness: 'unknown' },
      { sessionId: 'sess-dead', liveness: 'dead' },
    ]);
    schedulePeerInboxSweep(0);
    // Flush all microtasks and the zero-ms timer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockRead).toHaveBeenCalled();
    // The display filter must never feed a destructive sweep.
    expect(mockReadLive).not.toHaveBeenCalled();
    expect(mockSweep).toHaveBeenCalledWith({
      liveSessionIds: new Set(['sess-aaa', 'sess-bbb']),
    });
  });

  it('never throws even when sweepPeerInboxes rejects', async () => {
    mockSweep.mockRejectedValueOnce(new Error('disk error'));
    // Must not throw or reject.
    await expect(
      (async () => {
        schedulePeerInboxSweep(0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      })(),
    ).resolves.toBeUndefined();
  });

  it('never throws even when readPresenceFiles rejects', async () => {
    mockRead.mockRejectedValueOnce(new Error('presence read fail'));
    await expect(
      (async () => {
        schedulePeerInboxSweep(0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      })(),
    ).resolves.toBeUndefined();
  });

  it('fires the dead-presence reaper after the delay and swallows its rejection', async () => {
    mockReap.mockRejectedValueOnce(new Error('reap fail'));
    vi.useFakeTimers();
    try {
      schedulePeerInboxSweep(1000);
      expect(mockReap).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockReap).toHaveBeenCalledTimes(1);
      expect(mockSweep).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
