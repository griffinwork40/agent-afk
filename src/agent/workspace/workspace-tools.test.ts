/**
 * Tests for createWorkspaceHandlers (workspace-tools.ts).
 *
 * @module agent/workspace/workspace-tools.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkspaceStore } from './workspace-store.js';
import { createWorkspaceHandlers } from './workspace-tools.js';

const DUMMY_SIGNAL = new AbortController().signal;

describe('createWorkspaceHandlers', () => {
  let store: WorkspaceStore;
  const sessionId = 'test-session-1';
  const agentId = 'agent-alpha';

  beforeEach(() => {
    store = new WorkspaceStore();
  });

  it('returns a map with workspace_publish and workspace_query entries', () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    expect(handlers.has('workspace_publish')).toBe(true);
    expect(handlers.has('workspace_query')).toBe(true);
    expect(handlers.size).toBe(2);
  });

  it('publish valid entry returns { published: true, id: <number> }', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const handler = handlers.get('workspace_publish')!;

    const result = await handler(
      { type: 'finding', content: 'The auth module uses JWT.' },
      DUMMY_SIGNAL,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as { published: boolean; id: number };
    expect(parsed.published).toBe(true);
    expect(typeof parsed.id).toBe('number');
    expect(parsed.id).toBeGreaterThan(0);
  });

  it('publish with all optional fields succeeds', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const handler = handlers.get('workspace_publish')!;

    const result = await handler(
      {
        type: 'evidence',
        content: 'Line 42 sets the timeout.',
        subject: 'auth timeout',
        evidence: ['src/auth.ts:42'],
        confidence: 0.9,
        relates_to: [1],
        relation_type: 'supports',
      },
      DUMMY_SIGNAL,
    );

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as { published: boolean; id: number };
    expect(parsed.published).toBe(true);
  });

  it('publish with missing type returns isError', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const handler = handlers.get('workspace_publish')!;

    const result = await handler(
      { content: 'No type provided.' },
      DUMMY_SIGNAL,
    );

    expect(result.isError).toBe(true);
  });

  it('publish with invalid type value returns isError', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const handler = handlers.get('workspace_publish')!;

    const result = await handler(
      { type: 'invalid_type', content: 'Something.' },
      DUMMY_SIGNAL,
    );

    expect(result.isError).toBe(true);
  });

  it('publish with missing content returns isError', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const handler = handlers.get('workspace_publish')!;

    const result = await handler(
      { type: 'finding' },
      DUMMY_SIGNAL,
    );

    expect(result.isError).toBe(true);
  });

  it('publish with empty content returns isError', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const handler = handlers.get('workspace_publish')!;

    const result = await handler(
      { type: 'finding', content: '' },
      DUMMY_SIGNAL,
    );

    expect(result.isError).toBe(true);
  });

  it('auto-fills agent_id from constructor arg', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const handler = handlers.get('workspace_publish')!;

    await handler(
      { type: 'status', content: 'Working on it.' },
      DUMMY_SIGNAL,
    );

    const entries = store.queryAll(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agent_id).toBe(agentId);
  });

  it('works without agentId (agent_id is null)', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId);
    const handler = handlers.get('workspace_publish')!;

    await handler(
      { type: 'finding', content: 'No agent id.' },
      DUMMY_SIGNAL,
    );

    const entries = store.queryAll(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.agent_id).toBeNull();
  });

  it('published entry is retrievable from the store', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const handler = handlers.get('workspace_publish')!;

    const result = await handler(
      { type: 'decision', content: 'Use Redis for caching.', subject: 'caching' },
      DUMMY_SIGNAL,
    );

    const parsed = JSON.parse(result.content as string) as { published: boolean; id: number };
    const entries = store.queryAll(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(parsed.id);
    expect(entries[0]!.content).toBe('Use Redis for caching.');
    expect(entries[0]!.type).toBe('decision');
  });

  // ── workspace_query handler ─────────────────────────────────────────────

  it('query on empty store returns zero entries', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const handler = handlers.get('workspace_query')!;

    const result = await handler({ query: 'auth' }, DUMMY_SIGNAL);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as { entries: unknown[]; count: number };
    expect(parsed.count).toBe(0);
    expect(parsed.entries).toHaveLength(0);
  });

  it('query returns published entries matching keywords', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const publish = handlers.get('workspace_publish')!;
    const query = handlers.get('workspace_query')!;

    await publish({ type: 'finding', content: 'Auth uses JWT tokens.', subject: 'auth' }, DUMMY_SIGNAL);
    await publish({ type: 'finding', content: 'DB uses PostgreSQL.', subject: 'database' }, DUMMY_SIGNAL);

    const result = await query({ query: 'auth tokens' }, DUMMY_SIGNAL);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as { entries: { subject: string }[]; count: number };
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.entries.some((e) => e.subject === 'auth')).toBe(true);
  });

  it('query with type filter returns only matching types', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const publish = handlers.get('workspace_publish')!;
    const query = handlers.get('workspace_query')!;

    await publish({ type: 'finding', content: 'Found auth bug.', subject: 'auth' }, DUMMY_SIGNAL);
    await publish({ type: 'decision', content: 'Fix auth with OAuth.', subject: 'auth' }, DUMMY_SIGNAL);

    const result = await query({ query: 'auth', type: 'decision' }, DUMMY_SIGNAL);
    const parsed = JSON.parse(result.content as string) as { entries: { type: string }[]; count: number };
    expect(parsed.entries.every((e) => e.type === 'decision')).toBe(true);
  });

  it('query respects limit parameter', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const publish = handlers.get('workspace_publish')!;
    const query = handlers.get('workspace_query')!;

    for (let i = 0; i < 5; i++) {
      await publish({ type: 'finding', content: `Finding ${i}`, subject: 'test' }, DUMMY_SIGNAL);
    }

    const result = await query({ query: 'test', limit: 2 }, DUMMY_SIGNAL);
    const parsed = JSON.parse(result.content as string) as { entries: unknown[]; count: number };
    expect(parsed.count).toBeLessThanOrEqual(2);
  });

  it('query with missing query string returns isError', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const handler = handlers.get('workspace_query')!;

    const result = await handler({}, DUMMY_SIGNAL);
    expect(result.isError).toBe(true);
  });

  it('query with empty query string returns isError', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const handler = handlers.get('workspace_query')!;

    const result = await handler({ query: '' }, DUMMY_SIGNAL);
    expect(result.isError).toBe(true);
  });

  it('query returns entries from sibling agents (cross-session)', async () => {
    // Simulate two siblings publishing under different session IDs
    const handlers1 = createWorkspaceHandlers(store, 'session-alpha', 'agent-1');
    const handlers2 = createWorkspaceHandlers(store, 'session-beta', 'agent-2');
    const queryFromAgent2 = handlers2.get('workspace_query')!;

    await handlers1.get('workspace_publish')!(
      { type: 'finding', content: 'Provider uses streaming.', subject: 'provider' },
      DUMMY_SIGNAL,
    );

    // Agent 2 should see agent 1's entry via query (null sessionId scan)
    const result = await queryFromAgent2({ query: 'provider' }, DUMMY_SIGNAL);
    const parsed = JSON.parse(result.content as string) as { entries: { agent_id: string }[]; count: number };
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.entries.some((e) => e.agent_id === 'agent-1')).toBe(true);
  });

  // ── artifact_id round-trip (#1415 item 3) ──────────────────────────────────

  it('publish with valid artifact_id stores and returns the id', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const publish = handlers.get('workspace_publish')!;
    const validArtifactId = 'art_' + 'b'.repeat(32);

    const result = await publish(
      { type: 'artifact', content: 'Generated report.', artifact_id: validArtifactId },
      DUMMY_SIGNAL,
    );
    expect(result.isError).toBeFalsy();

    const entries = store.queryAll(sessionId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.artifact_id).toBe(validArtifactId);
  });

  it('publish artifact_id survives query serialization', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const publish = handlers.get('workspace_publish')!;
    const query = handlers.get('workspace_query')!;
    const validArtifactId = 'art_' + 'c'.repeat(32);

    await publish(
      { type: 'artifact', content: 'Some artifact entry.', subject: 'artifact test', artifact_id: validArtifactId },
      DUMMY_SIGNAL,
    );

    const result = await query({ query: 'artifact test' }, DUMMY_SIGNAL);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as {
      entries: { artifact_id: string | null }[];
    };
    expect(parsed.entries[0]!.artifact_id).toBe(validArtifactId);
  });

  it('malformed artifact_id (bad hex chars) returns isError', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const publish = handlers.get('workspace_publish')!;

    // Invalid: uppercase letters not allowed in art_<32hex>
    const result = await publish(
      { type: 'finding', content: 'Has bad id.', artifact_id: 'art_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ' },
      DUMMY_SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/artifact_id must match/);

    // No entry should have been stored
    const entries = store.queryAll(sessionId);
    expect(entries).toHaveLength(0);
  });

  it('malformed artifact_id (wrong prefix) returns isError', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const publish = handlers.get('workspace_publish')!;

    const result = await publish(
      { type: 'finding', content: 'Bad prefix.', artifact_id: 'artifact_' + 'a'.repeat(32) },
      DUMMY_SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/artifact_id must match/);

    const entries = store.queryAll(sessionId);
    expect(entries).toHaveLength(0);
  });

  it('publish without artifact_id stores null', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const publish = handlers.get('workspace_publish')!;
    const query = handlers.get('workspace_query')!;

    await publish({ type: 'finding', content: 'No artifact here.', subject: 'no artifact' }, DUMMY_SIGNAL);

    const result = await query({ query: 'no artifact' }, DUMMY_SIGNAL);
    const parsed = JSON.parse(result.content as string) as {
      entries: { artifact_id: string | null }[];
    };
    expect(parsed.entries[0]!.artifact_id).toBeNull();
  });

  it('query parses evidence JSON back to arrays', async () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    const publish = handlers.get('workspace_publish')!;
    const query = handlers.get('workspace_query')!;

    await publish(
      { type: 'evidence', content: 'Found it.', subject: 'test', evidence: ['src/foo.ts:42'] },
      DUMMY_SIGNAL,
    );

    const result = await query({ query: 'test' }, DUMMY_SIGNAL);
    const parsed = JSON.parse(result.content as string) as { entries: { evidence: string[] | null }[] };
    expect(parsed.entries[0]!.evidence).toEqual(['src/foo.ts:42']);
  });
});
