/**
 * Tests for WorkspaceStore: publish, queryRelevant, queryAll.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceStore } from './workspace-store.js';

describe('WorkspaceStore', () => {
  let store: WorkspaceStore;

  beforeEach(() => {
    store = new WorkspaceStore(':memory:');
  });

  // ── publish ────────────────────────────────────────────────────────────────

  describe('publish', () => {
    it('returns incrementing ids', () => {
      const id1 = store.publish({ session_id: 'sess-1', type: 'finding', content: 'A' });
      const id2 = store.publish({ session_id: 'sess-1', type: 'evidence', content: 'B' });
      expect(id1).toBeGreaterThan(0);
      expect(id2).toBeGreaterThan(id1);
    });

    it('auto-increments seq per session', () => {
      store.publish({ session_id: 'sess-1', type: 'finding', content: 'A' });
      store.publish({ session_id: 'sess-1', type: 'finding', content: 'B' });
      store.publish({ session_id: 'sess-2', type: 'finding', content: 'C' });

      const sess1 = store.queryAll('sess-1');
      const sess2 = store.queryAll('sess-2');

      expect(sess1[0]?.seq).toBe(1);
      expect(sess1[1]?.seq).toBe(2);
      expect(sess2[0]?.seq).toBe(1); // seq restarts for a new session
    });

    it('stores all fields correctly', () => {
      const id = store.publish({
        session_id: 'sess-1',
        type: 'hypothesis',
        subject: 'auth race',
        content: 'Auth refresh may race',
        evidence: ['src/auth.ts:141'],
        confidence: 0.8,
        agent_id: 'researcher-A',
        relates_to: [1, 2],
        relation_type: 'supports',
      });

      const entries = store.queryAll('sess-1');
      const entry = entries.find((e) => e.id === id);
      expect(entry).toBeDefined();
      expect(entry?.type).toBe('hypothesis');
      expect(entry?.subject).toBe('auth race');
      expect(entry?.content).toBe('Auth refresh may race');
      expect(entry?.evidence).toBe('["src/auth.ts:141"]');
      expect(entry?.confidence).toBe(0.8);
      expect(entry?.agent_id).toBe('researcher-A');
      expect(entry?.relates_to).toBe('[1,2]');
      expect(entry?.relation_type).toBe('supports');
    });

    it('defaults confidence to 1.0', () => {
      const id = store.publish({ session_id: 'sess-1', type: 'status', content: 'OK' });
      const entries = store.queryAll('sess-1');
      const entry = entries.find((e) => e.id === id);
      expect(entry?.confidence).toBe(1.0);
    });
  });

  // ── queryAll ───────────────────────────────────────────────────────────────

  describe('queryAll', () => {
    it('returns entries in seq ascending order', () => {
      store.publish({ session_id: 'sess-1', type: 'finding', content: 'First' });
      store.publish({ session_id: 'sess-1', type: 'finding', content: 'Second' });
      store.publish({ session_id: 'sess-1', type: 'finding', content: 'Third' });

      const entries = store.queryAll('sess-1');
      expect(entries.map((e) => e.content)).toEqual(['First', 'Second', 'Third']);
    });

    it('returns empty array for unknown session', () => {
      expect(store.queryAll('no-such-session')).toEqual([]);
    });

    it('isolates entries by session', () => {
      store.publish({ session_id: 'sess-1', type: 'finding', content: 'For sess-1' });
      store.publish({ session_id: 'sess-2', type: 'finding', content: 'For sess-2' });

      const sess1 = store.queryAll('sess-1');
      expect(sess1).toHaveLength(1);
      expect(sess1[0]?.content).toBe('For sess-1');
    });
  });

  // ── queryRelevant ──────────────────────────────────────────────────────────

  describe('queryRelevant', () => {
    it('returns subject-matched entries when keywords overlap', () => {
      store.publish({ session_id: 's', type: 'finding', subject: 'auth refresh', content: 'A' });
      store.publish({ session_id: 's', type: 'finding', subject: 'database schema', content: 'B' });
      store.publish({ session_id: 's', type: 'finding', subject: 'auth token', content: 'C' });

      const results = store.queryRelevant('s', 'check the auth flow');
      // Should match 'auth refresh' and 'auth token' but not 'database schema'
      const contents = results.map((e) => e.content);
      expect(contents).toContain('A');
      expect(contents).toContain('C');
      expect(contents).not.toContain('B');
    });

    it('falls back to all session entries when no subject matches', () => {
      store.publish({ session_id: 's', type: 'finding', subject: 'payments', content: 'P' });
      store.publish({ session_id: 's', type: 'status', content: 'S' });

      // taskPrompt has no overlapping keywords with any subject
      const results = store.queryRelevant('s', 'xyz-qrs-mno');
      expect(results.length).toBeGreaterThan(0);
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        store.publish({ session_id: 's', type: 'finding', content: `Entry ${i}` });
      }
      const results = store.queryRelevant('s', 'any query xyz', 3);
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('defaults limit to 50', () => {
      for (let i = 0; i < 60; i++) {
        store.publish({ session_id: 's', type: 'finding', content: `Entry ${i}` });
      }
      const results = store.queryRelevant('s', 'xyz-no-match');
      expect(results.length).toBe(50);
    });

    it('returns entries ordered by seq descending (most recent first)', () => {
      store.publish({ session_id: 's', type: 'finding', subject: 'auth', content: 'Older' });
      store.publish({ session_id: 's', type: 'finding', subject: 'auth', content: 'Newer' });

      const results = store.queryRelevant('s', 'auth session check');
      expect(results[0]?.content).toBe('Newer');
      expect(results[1]?.content).toBe('Older');
    });
  });

  // ── close ──────────────────────────────────────────────────────────────────

  describe('close', () => {
    it('closes without error', () => {
      expect(() => store.close()).not.toThrow();
    });
  });
});
