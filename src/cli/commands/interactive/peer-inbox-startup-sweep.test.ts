/**
 * Tests for the peer-inbox startup sweep helper.
 *
 * Verifies that schedulePeerInboxSweep:
 *   - is deferred (does not run synchronously)
 *   - never throws even when sweepPeerInboxes rejects
 *   - uses readLivePresenceFiles to build the live-sessions set
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the dependencies so no real disk I/O occurs
// ---------------------------------------------------------------------------

vi.mock('../../../agent/peer/inbox-store.js', () => ({
  sweepPeerInboxes: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../../agent/awareness/presence.js', () => ({
  readLivePresenceFiles: vi.fn().mockResolvedValue([]),
}));

import { schedulePeerInboxSweep } from './peer-inbox-startup-sweep.js';
import { sweepPeerInboxes } from '../../../agent/peer/inbox-store.js';
import { readLivePresenceFiles } from '../../../agent/awareness/presence.js';

const mockSweep = sweepPeerInboxes as ReturnType<typeof vi.fn>;
const mockRead = readLivePresenceFiles as ReturnType<typeof vi.fn>;

afterEach(() => {
  vi.clearAllMocks();
});

describe('schedulePeerInboxSweep', () => {
  it('does not call sweepPeerInboxes synchronously (deferred)', () => {
    schedulePeerInboxSweep(50);
    // sweepPeerInboxes must NOT have been called yet — the setTimeout is pending.
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it('calls sweepPeerInboxes after the delay with live session ids', async () => {
    mockRead.mockResolvedValueOnce([
      { sessionId: 'sess-aaa' },
      { sessionId: 'sess-bbb' },
    ]);
    schedulePeerInboxSweep(0);
    // Flush all microtasks and the zero-ms timer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockRead).toHaveBeenCalled();
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

  it('never throws even when readLivePresenceFiles rejects', async () => {
    mockRead.mockRejectedValueOnce(new Error('presence read fail'));
    await expect(
      (async () => {
        schedulePeerInboxSweep(0);
        await new Promise((resolve) => setTimeout(resolve, 10));
      })(),
    ).resolves.toBeUndefined();
  });
});
