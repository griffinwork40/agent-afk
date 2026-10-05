/**
 * Unit tests for AdmissionQueue — the session-level typed bounded queue that
 * aggregates human queued-user-messages and peer messages for inter-round
 * boundary delivery.
 */

import { describe, it, expect } from 'vitest';
import { AdmissionQueue } from './admission-queue.js';

describe('AdmissionQueue', () => {
  describe('basic admission', () => {
    it('starts empty', () => {
      const q = new AdmissionQueue();
      expect(q.size).toBe(0);
      expect(q.pending).toBe(false);
    });

    it('admits human and peer entries', () => {
      const q = new AdmissionQueue();
      expect(q.submitHuman('hello from user')).toBe(true);
      expect(q.submitPeer('sender-1', 'hello from peer')).toBe(true);
      expect(q.size).toBe(2);
      expect(q.pending).toBe(true);
    });

    it('rejects human when count cap hit', () => {
      const q = new AdmissionQueue({ maxCount: 2 });
      q.submitHuman('a');
      q.submitHuman('b');
      expect(q.submitHuman('c')).toBe(false);
      expect(q.size).toBe(2);
    });

    it('rejects peer when count cap hit', () => {
      const q = new AdmissionQueue({ maxCount: 1 });
      q.submitPeer('s1', 'first');
      expect(q.submitPeer('s1', 'second')).toBe(false);
    });

    it('rejects when byte cap would be exceeded', () => {
      const q = new AdmissionQueue({ maxBytes: 10 });
      expect(q.submitPeer('s1', 'twelve chars')).toBe(false);
      expect(q.submitHuman('short')).toBe(true); // 5 bytes — fits
    });

    it('rejects peer when per-sender cap hit', () => {
      const q = new AdmissionQueue({ maxPerSender: 2 });
      q.submitPeer('s1', 'a');
      q.submitPeer('s1', 'b');
      expect(q.submitPeer('s1', 'c')).toBe(false);
      // Different sender is not affected.
      expect(q.submitPeer('s2', 'x')).toBe(true);
    });

    it('per-sender cap does not apply to human', () => {
      const q = new AdmissionQueue({ maxPerSender: 1, maxCount: 20 });
      expect(q.submitHuman('first')).toBe(true);
      expect(q.submitHuman('second')).toBe(true);
    });
  });

  describe('snapshot: human-first barrier', () => {
    it('returns only human entries when both human and peer are present', () => {
      const q = new AdmissionQueue();
      q.submitHuman('user text');
      q.submitPeer('s1', 'peer text');
      const snap = q.snapshot();
      expect(snap.entries).toHaveLength(1);
      expect(snap.entries[0]!.kind).toBe('human');
      expect(snap.entries[0]!.text).toBe('user text');
    });

    it('returns peer entries when no human entries present', () => {
      const q = new AdmissionQueue();
      q.submitPeer('s1', 'peer a');
      q.submitPeer('s2', 'peer b');
      const snap = q.snapshot();
      expect(snap.entries).toHaveLength(2);
      expect(snap.entries.every((e) => e.kind === 'peer')).toBe(true);
    });

    it('returns empty entries on empty queue', () => {
      const q = new AdmissionQueue();
      const snap = q.snapshot();
      expect(snap.entries).toHaveLength(0);
      expect(snap.cutoff).toBe(0);
    });
  });

  describe('FIFO ordering within kind', () => {
    it('peer entries are returned in insertion order', () => {
      const q = new AdmissionQueue();
      q.submitPeer('s1', 'first');
      q.submitPeer('s2', 'second');
      q.submitPeer('s1', 'third');
      const snap = q.snapshot();
      expect(snap.entries.map((e) => e.text)).toEqual(['first', 'second', 'third']);
    });

    it('human entries appear before peer in mixed snapshot after barrier clears', () => {
      const q = new AdmissionQueue();
      q.submitPeer('s1', 'peer 1');
      q.submitHuman('user 1');
      q.submitPeer('s1', 'peer 2');
      q.submitHuman('user 2');
      // Barrier: only human returned.
      const snap1 = q.snapshot();
      expect(snap1.entries.map((e) => e.text)).toEqual(['user 1', 'user 2']);
      // Drain humans.
      q.drain(snap1);
      // Now peers are returned.
      const snap2 = q.snapshot();
      expect(snap2.entries.map((e) => e.text)).toEqual(['peer 1', 'peer 2']);
    });
  });

  describe('drain', () => {
    it('removes snapshotted entries and returns joined text', () => {
      const q = new AdmissionQueue();
      q.submitPeer('s1', 'alpha');
      q.submitPeer('s2', 'beta');
      const snap = q.snapshot();
      const text = q.drain(snap);
      expect(text).toBe('alpha\n\nbeta');
      expect(q.size).toBe(0);
      expect(q.pending).toBe(false);
    });

    it('returns empty string for empty snapshot', () => {
      const q = new AdmissionQueue();
      const snap = q.snapshot();
      expect(q.drain(snap)).toBe('');
    });

    it('is idempotent — second drain on same snapshot is a no-op', () => {
      const q = new AdmissionQueue();
      q.submitHuman('hi');
      const snap = q.snapshot();
      q.drain(snap);
      // Second drain — seq no longer in queue.
      const text2 = q.drain(snap);
      expect(text2).toBe('hi'); // text still returned from snapshot entries
      expect(q.size).toBe(0);
    });

    it('snapshot cutoff tracks next seq', () => {
      const q = new AdmissionQueue();
      q.submitHuman('a');
      const snap = q.snapshot();
      expect(snap.cutoff).toBe(1); // next seq will be 1
      q.submitHuman('b');
      // New entry has seq=1 which is >= cutoff — belongs to next snapshot.
      const snap2 = q.snapshot();
      expect(snap2.entries).toHaveLength(2); // both human; original still in queue
    });

    it('does not drain entries that arrived after snapshot', () => {
      const q = new AdmissionQueue();
      q.submitHuman('first');
      const snap = q.snapshot();
      q.submitHuman('second'); // arrives after snapshot
      q.drain(snap);
      // 'second' survives.
      expect(q.size).toBe(1);
      expect(q.snapshot().entries[0]!.text).toBe('second');
    });

    it('byte accounting decrements on drain', () => {
      const q = new AdmissionQueue({ maxBytes: 20 });
      q.submitPeer('s1', 'hello'); // 5 bytes
      const snap = q.snapshot();
      q.drain(snap);
      // Should be able to admit another 5-byte entry after draining.
      expect(q.submitPeer('s2', 'world')).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all entries and resets byte count', () => {
      const q = new AdmissionQueue({ maxBytes: 10 });
      q.submitHuman('12345'); // 5 bytes
      q.submitPeer('s1', 'abcde'); // 5 bytes
      q.clear();
      expect(q.size).toBe(0);
      expect(q.pending).toBe(false);
      // Byte budget restored.
      expect(q.submitHuman('12345678901')).toBe(false); // 11 bytes > 10 cap
      expect(q.submitHuman('123456789')).toBe(true); // 9 bytes, fits
    });
  });
});
