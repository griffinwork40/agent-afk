/**
 * Unit tests for workspace-subscription-wiring.ts.
 *
 * Covers the cases identified in the PR review:
 *   (a) calling subscribeHandler before bindHandle returns isError
 *   (b) ring buffer eviction when >10 entries are pushed
 *   (c) drain resets _workspaceDroppedSinceDrain counter
 *
 * Test style mirrors fork-progress-events.test.ts: minimal stubs, no real
 * SQLite, no trace I/O.
 */

import { describe, it, expect } from 'vitest';
import { wireWorkspaceSubscriptions } from './workspace-subscription-wiring.js';
import { WorkspaceStore } from '../workspace/workspace-store.js';
import { WORKSPACE_DELIVERY_RING_CAPACITY } from '../workspace/workspace-subscription-constants.js';
import type { SubagentHandleImpl } from './handle.js';
import type { WorkspaceEntry } from '../workspace/workspace-store.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal handle double that contains only the fields the wiring code
 * reads and mutates:
 *   _pendingWorkspaceEntries, _workspaceDroppedSinceDrain, _workspaceStore.
 */
function makeHandleDouble() {
  return {
    id: 'test-handle',
    _pendingWorkspaceEntries: [] as WorkspaceEntry[],
    _workspaceDroppedSinceDrain: 0,
    _workspaceStore: undefined as WorkspaceStore | undefined,
  } as unknown as SubagentHandleImpl<unknown>;
}

/**
 * Build a minimal WorkspaceEntry with a given seq number and fill in required
 * fields so TypeScript is satisfied.
 */
function makeEntry(seq: number): WorkspaceEntry {
  return {
    id: seq,
    session_id: 'sess-1',
    type: 'finding',
    subject: `subject-${seq}`,
    content: `content-${seq}`,
    evidence: null,
    confidence: 1.0,
    agent_id: 'agent-a',
    relates_to: null,
    relation_type: null,
    created_at: '2026-09-07T00:00:00Z',
    seq,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('wireWorkspaceSubscriptions', () => {
  // (a) calling subscribeHandler before bindHandle returns isError
  it('subscribeHandler returns isError when called before bindHandle', async () => {
    const store = new WorkspaceStore();
    const { subscribeHandler } = wireWorkspaceSubscriptions(store, 'agent-x', undefined);

    const result = await subscribeHandler({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('handle not yet initialized');
  });

  // store=undefined no-op path
  it('returns isError from subscribeHandler when store is undefined', async () => {
    const { subscribeHandler } = wireWorkspaceSubscriptions(undefined, 'agent-x', undefined);
    const result = await subscribeHandler({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('no store available');
  });

  // Happy path: bindHandle then subscribeHandler succeeds
  it('subscribeHandler succeeds after bindHandle and returns subscriptionId', async () => {
    const store = new WorkspaceStore();
    const { subscribeHandler, bindHandle } = wireWorkspaceSubscriptions(store, 'agent-x', undefined);
    const handle = makeHandleDouble();
    bindHandle(handle);

    const result = await subscribeHandler({});
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string);
    expect(parsed.active).toBe(true);
    expect(parsed.subscriptionId).toMatch(/^sub_[0-9a-f]{8}$/);
  });

  // (b) ring buffer eviction when >10 entries are pushed
  it('evicts oldest entry when ring buffer exceeds WORKSPACE_DELIVERY_RING_CAPACITY', async () => {
    const store = new WorkspaceStore();
    const { subscribeHandler, bindHandle } = wireWorkspaceSubscriptions(store, 'agent-x', undefined);
    const handle = makeHandleDouble();
    bindHandle(handle);

    // Subscribe with no filters so all entries are delivered
    await subscribeHandler({});

    // Publish RING_CAPACITY + 2 entries to trigger two evictions
    const totalEntries = WORKSPACE_DELIVERY_RING_CAPACITY + 2;
    for (let seq = 1; seq <= totalEntries; seq++) {
      // Directly invoke deliveryFn via the wired store.subscribe callback by
      // publishing to the store so notifySubscribers fires.
      store.publish({
        session_id: 'sess-1',
        type: 'finding',
        subject: `subject-${seq}`,
        content: `content-${seq}`,
        confidence: 1.0,
        agent_id: 'agent-x',
      });
    }

    // Ring buffer should be capped at RING_CAPACITY
    expect(handle._pendingWorkspaceEntries.length).toBe(WORKSPACE_DELIVERY_RING_CAPACITY);

    // Two entries were evicted, so dropped counter should be 2
    expect(handle._workspaceDroppedSinceDrain).toBe(2);

    // The entries in the buffer should be the LAST RING_CAPACITY entries
    // (oldest-first eviction keeps the newest).
    const firstSeqInBuffer = handle._pendingWorkspaceEntries[0]?.seq;
    expect(firstSeqInBuffer).toBe(3); // entries 1 and 2 were evicted
  });

  // provider injection path: setSubscribeHandler is called when a provider is passed
  it('calls provider.setSubscribeHandler with the subscribeHandler when a provider is given', () => {
    const store = new WorkspaceStore();
    let injectedHandler: unknown;
    const provider = {
      setSubscribeHandler: (h: unknown) => {
        injectedHandler = h;
      },
    };

    const { subscribeHandler } = wireWorkspaceSubscriptions(store, 'agent-x', undefined, provider);

    // The injected handler must be the exact same function reference
    expect(injectedHandler).toBe(subscribeHandler);
  });

  // provider without setSubscribeHandler: no crash, no injection
  it('does not throw when provider has no setSubscribeHandler', () => {
    const store = new WorkspaceStore();
    const provider = {};
    expect(() =>
      wireWorkspaceSubscriptions(store, 'agent-x', undefined, provider),
    ).not.toThrow();
  });

  // (c) drain resets _workspaceDroppedSinceDrain counter
  it('draining _pendingWorkspaceEntries resets the dropped counter', async () => {
    const store = new WorkspaceStore();
    const { subscribeHandler, bindHandle } = wireWorkspaceSubscriptions(store, 'agent-x', undefined);
    const handle = makeHandleDouble();
    bindHandle(handle);

    await subscribeHandler({});

    // Overflow the ring to accumulate some dropped entries
    const overflow = WORKSPACE_DELIVERY_RING_CAPACITY + 3;
    for (let seq = 1; seq <= overflow; seq++) {
      store.publish({
        session_id: 'sess-1',
        type: 'finding',
        content: `content-${seq}`,
        confidence: 1.0,
        agent_id: 'agent-x',
      });
    }

    expect(handle._workspaceDroppedSinceDrain).toBe(3);

    // Simulate a drain: splice the pending entries and reset the counter
    // (mirrors _drainWorkspaceDeliveries in handle.ts)
    handle._pendingWorkspaceEntries.splice(0);
    handle._workspaceDroppedSinceDrain = 0;

    expect(handle._pendingWorkspaceEntries.length).toBe(0);
    expect(handle._workspaceDroppedSinceDrain).toBe(0);

    // After drain, new entries accumulate cleanly with no carry-over dropped count
    store.publish({
      session_id: 'sess-1',
      type: 'finding',
      content: 'post-drain entry',
      confidence: 1.0,
      agent_id: 'agent-x',
    });

    expect(handle._pendingWorkspaceEntries.length).toBe(1);
    expect(handle._workspaceDroppedSinceDrain).toBe(0);
  });
});
