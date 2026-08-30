/**
 * Tests for WorkspaceStore: publish, queryRelevant (FTS5), queryAll, buildFtsQuery.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceStore, buildFtsQuery } from './workspace-store.js';

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

  // ── queryRelevant (FTS5) ──────────────────────────────────────────────────

  describe('queryRelevant', () => {
    it('matches entries by subject keywords', () => {
      store.publish({ session_id: 's', type: 'finding', subject: 'auth refresh', content: 'A' });
      store.publish({ session_id: 's', type: 'finding', subject: 'database schema', content: 'B' });
      store.publish({ session_id: 's', type: 'finding', subject: 'auth token', content: 'C' });

      const results = store.queryRelevant('s', 'check the auth flow');
      const contents = results.map((e) => e.content);
      expect(contents).toContain('A');
      expect(contents).toContain('C');
      expect(contents).not.toContain('B');
    });

    it('matches entries by content when subject has no overlap', () => {
      store.publish({
        session_id: 's',
        type: 'finding',
        subject: 'module overview',
        content: 'The SwiftUI observable pattern handles state propagation',
      });
      store.publish({
        session_id: 's',
        type: 'finding',
        subject: 'unrelated topic',
        content: 'Nothing relevant here at all',
      });

      const results = store.queryRelevant('s', 'SwiftUI observable state');
      expect(results).toHaveLength(1);
      expect(results[0]?.subject).toBe('module overview');
    });

    it('ranks subject matches above content matches', () => {
      store.publish({
        session_id: 's',
        type: 'finding',
        subject: 'performance optimization',
        content: 'General tips for speed',
      });
      store.publish({
        session_id: 's',
        type: 'finding',
        subject: 'unrelated module',
        content: 'This mentions performance in passing',
      });

      const results = store.queryRelevant('s', 'performance tuning');
      // Subject-matched entry should rank first (bm25 weights subject 10x)
      expect(results[0]?.subject).toBe('performance optimization');
    });

    it('falls back to all session entries when no FTS match', () => {
      store.publish({ session_id: 's', type: 'finding', subject: 'payments', content: 'P' });
      store.publish({ session_id: 's', type: 'status', content: 'S' });

      // taskPrompt has no overlapping keywords with any subject or content
      const results = store.queryRelevant('s', 'xyzqrsmno aaabbb');
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
      const results = store.queryRelevant('s', 'xyzxyz-no-match');
      expect(results.length).toBe(50);
    });

    it('handles null sessionId (cross-sibling query)', () => {
      store.publish({ session_id: 'child-1', type: 'finding', subject: 'auth', content: 'From child 1' });
      store.publish({ session_id: 'child-2', type: 'finding', subject: 'auth', content: 'From child 2' });

      const results = store.queryRelevant(null, 'auth module');
      expect(results).toHaveLength(2);
    });

    it('uses porter stemming (searching finds searched)', () => {
      store.publish({
        session_id: 's',
        type: 'finding',
        subject: 'connection pooling',
        content: 'Database connections are pooled',
      });

      // "connecting" should stem-match "connection" and "connections"
      const results = store.queryRelevant('s', 'connecting to databases');
      expect(results).toHaveLength(1);
    });

    it('gracefully handles queries with FTS5 operator characters', () => {
      store.publish({ session_id: 's', type: 'finding', content: 'some data' });

      // These would break raw FTS5 — buildFtsQuery double-quotes them
      expect(() => store.queryRelevant('s', 'NOT this AND that')).not.toThrow();
      expect(() => store.queryRelevant('s', 'prefix* wildcard')).not.toThrow();
      expect(() => store.queryRelevant('s', 'term -excluded')).not.toThrow();
    });
  });

  // ── buildFtsQuery ─────────────────────────────────────────────────────────

  describe('buildFtsQuery', () => {
    it('joins tokens with OR and double-quotes each', () => {
      expect(buildFtsQuery('auth refresh token')).toBe('"auth" OR "refresh" OR "token"');
    });

    it('drops words shorter than 3 chars', () => {
      expect(buildFtsQuery('a to the auth in')).toBe('"the" OR "auth"');
    });

    it('deduplicates tokens', () => {
      expect(buildFtsQuery('auth auth auth token')).toBe('"auth" OR "token"');
    });

    it('lowercases all tokens', () => {
      expect(buildFtsQuery('SwiftUI Observable')).toBe('"swiftui" OR "observable"');
    });

    it('returns empty string for no usable tokens', () => {
      expect(buildFtsQuery('a b c')).toBe('');
      expect(buildFtsQuery('')).toBe('');
      expect(buildFtsQuery('  ')).toBe('');
    });

    it('caps at 25 tokens', () => {
      const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
      const tokens = buildFtsQuery(long).split(' OR ');
      expect(tokens).toHaveLength(25);
    });

    it('neutralizes FTS5 operators via quoting', () => {
      const q = buildFtsQuery('NOT something AND another');
      // NOT, AND are quoted as regular tokens, not interpreted as operators
      expect(q).toBe('"not" OR "something" OR "and" OR "another"');
    });
  });

  // ── close ──────────────────────────────────────────────────────────────────

  describe('close', () => {
    it('closes without error', () => {
      expect(() => store.close()).not.toThrow();
    });
  });
});
