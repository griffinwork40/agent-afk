/**
 * Integration tests: WorkspaceStore.subscribe / unsubscribeAll / publish notification.
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkspaceStore } from './workspace-store.js';
import type { WorkspaceSubscription } from './workspace-subscription.js';

function makeSub(overrides: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription {
  return {
    id: 'sub_test0001',
    agentId: 'child-1',
    subject: undefined,
    type: undefined,
    lastDeliveredSeq: 0,
    deliveryFn: vi.fn(),
    ...overrides,
  };
}

describe('WorkspaceStore subscriptions', () => {
  it('notifies a subscriber when a matching entry is published', () => {
    const store = new WorkspaceStore();
    const sub = makeSub();
    store.subscribe(sub);

    store.publish({
      session_id: 'sess',
      type: 'finding',
      subject: 'auth',
      content: 'JWT verified.',
    });

    expect(sub.deliveryFn).toHaveBeenCalledTimes(1);
    const delivered = (sub.deliveryFn as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(delivered.type).toBe('finding');
    expect(delivered.content).toBe('JWT verified.');
  });

  it('does not notify after unsubscribeAll removes the subscription', () => {
    const store = new WorkspaceStore();
    const sub = makeSub();
    store.subscribe(sub);
    store.unsubscribeAll('child-1');

    store.publish({
      session_id: 'sess',
      type: 'finding',
      subject: 'auth',
      content: 'Should not arrive.',
    });

    expect(sub.deliveryFn).not.toHaveBeenCalled();
  });

  it('unsubscribeAll only removes subs for the specified agentId', () => {
    const store = new WorkspaceStore();
    const sub1 = makeSub({ id: 'sub_1', agentId: 'child-1' });
    const sub2 = makeSub({ id: 'sub_2', agentId: 'child-2' });
    store.subscribe(sub1);
    store.subscribe(sub2);
    store.unsubscribeAll('child-1');

    store.publish({
      session_id: 'sess',
      type: 'finding',
      subject: 'test',
      content: 'Only child-2 should see this.',
    });

    expect(sub1.deliveryFn).not.toHaveBeenCalled();
    expect(sub2.deliveryFn).toHaveBeenCalledTimes(1);
  });

  it('respects type filter on subscription', () => {
    const store = new WorkspaceStore();
    const sub = makeSub({ type: 'decision' });
    store.subscribe(sub);

    store.publish({ session_id: 's', type: 'finding', subject: 'x', content: 'skip' });
    expect(sub.deliveryFn).not.toHaveBeenCalled();

    store.publish({ session_id: 's', type: 'decision', subject: 'x', content: 'deliver' });
    expect(sub.deliveryFn).toHaveBeenCalledTimes(1);
  });

  it('respects subject filter (case-insensitive substring)', () => {
    const store = new WorkspaceStore();
    const sub = makeSub({ subject: 'auth' });
    store.subscribe(sub);

    store.publish({ session_id: 's', type: 'finding', subject: 'database', content: 'skip' });
    expect(sub.deliveryFn).not.toHaveBeenCalled();

    store.publish({ session_id: 's', type: 'finding', subject: 'AUTH flow', content: 'deliver' });
    expect(sub.deliveryFn).toHaveBeenCalledTimes(1);
  });

  it('watermark prevents duplicate delivery', () => {
    const store = new WorkspaceStore();
    const sub = makeSub();
    store.subscribe(sub);

    store.publish({ session_id: 's', type: 'finding', subject: 'a', content: 'first' });
    store.publish({ session_id: 's', type: 'finding', subject: 'b', content: 'second' });

    expect(sub.deliveryFn).toHaveBeenCalledTimes(2);
    // Each call should have a different seq
    const seq1 = (sub.deliveryFn as ReturnType<typeof vi.fn>).mock.calls[0]![0].seq;
    const seq2 = (sub.deliveryFn as ReturnType<typeof vi.fn>).mock.calls[1]![0].seq;
    expect(seq2).toBeGreaterThan(seq1);
  });
});
