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

  it('returns a map with a workspace_publish entry', () => {
    const handlers = createWorkspaceHandlers(store, sessionId, agentId);
    expect(handlers.has('workspace_publish')).toBe(true);
    expect(handlers.size).toBe(1);
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
});
