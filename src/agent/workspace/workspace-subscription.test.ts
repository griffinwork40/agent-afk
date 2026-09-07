/**
 * Tests for workspace subscription filter logic and XML delivery formatting.
 */

import { describe, it, expect, vi } from 'vitest';
import { notifySubscribers, formatWorkspaceDeliveryEnvelope, generateSubscriptionId } from './workspace-subscription.js';
import type { WorkspaceSubscription } from './workspace-subscription.js';
import type { WorkspaceEntry } from './workspace-store.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<WorkspaceEntry> = {}): WorkspaceEntry {
  return {
    id: 1,
    sessionId: 'sess-1',
    type: 'finding',
    subject: 'auth invariant',
    content: 'The auth module uses JWT.',
    evidence: null,
    confidence: 1.0,
    agentId: 'agent-a',
    relatesTo: null,
    relationType: null,
    createdAt: '2026-09-07T00:00:00Z',
    seq: 1,
    ...overrides,
  };
}

function makeSub(overrides: Partial<WorkspaceSubscription> = {}): WorkspaceSubscription {
  return {
    id: 'sub_test1234',
    agentId: 'agent-b',
    subject: undefined,
    type: undefined,
    lastDeliveredSeq: 0,
    deliveryFn: vi.fn(),
    ...overrides,
  };
}

// ── notifySubscribers ───────────────────────────────────────────────────────

describe('notifySubscribers', () => {
  it('delivers an entry matching an unfiltered subscription', () => {
    const sub = makeSub();
    const subs = new Map([['s1', sub]]);
    const entry = makeEntry();
    notifySubscribers(subs, entry);
    expect(sub.deliveryFn).toHaveBeenCalledWith(entry);
    expect(sub.lastDeliveredSeq).toBe(1);
  });

  it('skips entry when seq <= lastDeliveredSeq (watermark guard)', () => {
    const sub = makeSub({ lastDeliveredSeq: 5 });
    const subs = new Map([['s1', sub]]);
    notifySubscribers(subs, makeEntry({ seq: 5 }));
    notifySubscribers(subs, makeEntry({ seq: 3 }));
    expect(sub.deliveryFn).not.toHaveBeenCalled();
  });

  it('filters by type when type is set', () => {
    const sub = makeSub({ type: 'decision' });
    const subs = new Map([['s1', sub]]);
    notifySubscribers(subs, makeEntry({ type: 'finding', seq: 1 }));
    expect(sub.deliveryFn).not.toHaveBeenCalled();
    notifySubscribers(subs, makeEntry({ type: 'decision', seq: 2 }));
    expect(sub.deliveryFn).toHaveBeenCalledTimes(1);
  });

  it('filters by subject substring (case-insensitive)', () => {
    const sub = makeSub({ subject: 'AUTH' });
    const subs = new Map([['s1', sub]]);
    notifySubscribers(subs, makeEntry({ subject: 'auth invariant', seq: 1 }));
    expect(sub.deliveryFn).toHaveBeenCalledTimes(1);
    notifySubscribers(subs, makeEntry({ subject: 'database schema', seq: 2 }));
    expect(sub.deliveryFn).toHaveBeenCalledTimes(1); // still 1
  });

  it('skips when entry subject is null and sub.subject is set', () => {
    const sub = makeSub({ subject: 'auth' });
    const subs = new Map([['s1', sub]]);
    notifySubscribers(subs, makeEntry({ subject: null, seq: 1 }));
    expect(sub.deliveryFn).not.toHaveBeenCalled();
  });

  it('delivers to multiple matching subscriptions', () => {
    const sub1 = makeSub({ id: 'sub_1' });
    const sub2 = makeSub({ id: 'sub_2', type: 'finding' });
    const sub3 = makeSub({ id: 'sub_3', type: 'decision' });
    const subs = new Map([['s1', sub1], ['s2', sub2], ['s3', sub3]]);
    const entry = makeEntry({ type: 'finding', seq: 1 });
    notifySubscribers(subs, entry);
    expect(sub1.deliveryFn).toHaveBeenCalled();
    expect(sub2.deliveryFn).toHaveBeenCalled();
    expect(sub3.deliveryFn).not.toHaveBeenCalled();
  });

  it('combines type and subject filters (both must match)', () => {
    const sub = makeSub({ type: 'finding', subject: 'auth' });
    const subs = new Map([['s1', sub]]);
    // Wrong type
    notifySubscribers(subs, makeEntry({ type: 'decision', subject: 'auth flow', seq: 1 }));
    expect(sub.deliveryFn).not.toHaveBeenCalled();
    // Wrong subject
    notifySubscribers(subs, makeEntry({ type: 'finding', subject: 'database', seq: 2 }));
    expect(sub.deliveryFn).not.toHaveBeenCalled();
    // Both match
    notifySubscribers(subs, makeEntry({ type: 'finding', subject: 'auth check', seq: 3 }));
    expect(sub.deliveryFn).toHaveBeenCalledTimes(1);
  });
});

// ── formatWorkspaceDeliveryEnvelope ─────────────────────────────────────────

describe('formatWorkspaceDeliveryEnvelope', () => {
  it('returns undefined for empty array', () => {
    expect(formatWorkspaceDeliveryEnvelope([])).toBeUndefined();
  });

  it('wraps a single entry in workspace-delivery XML', () => {
    const result = formatWorkspaceDeliveryEnvelope([makeEntry()]);
    expect(result).toContain('<workspace-delivery');
    expect(result).toContain('count="1"');
    expect(result).toContain('<entry id="1" type="finding"');
    expect(result).toContain('subject="auth invariant"');
    expect(result).toContain('confidence="1.00"');
    expect(result).toContain('</workspace-delivery>');
  });

  it('batches multiple entries into one envelope', () => {
    const entries = [makeEntry({ id: 1, seq: 1 }), makeEntry({ id: 2, seq: 2, type: 'decision' })];
    const result = formatWorkspaceDeliveryEnvelope(entries);
    expect(result).toContain('count="2"');
    expect(result).toContain('id="1"');
    expect(result).toContain('id="2"');
  });

  it('XML-escapes content with special characters', () => {
    const entry = makeEntry({ content: 'a < b && c > d "quoted"' });
    const result = formatWorkspaceDeliveryEnvelope([entry])!;
    expect(result).toContain('a &lt; b &amp;&amp; c &gt; d');
  });

  it('omits subject attribute when subject is null', () => {
    const entry = makeEntry({ subject: null });
    const result = formatWorkspaceDeliveryEnvelope([entry])!;
    expect(result).not.toContain('subject=');
  });

  it('omits dropped attribute when droppedCount is 0 (default)', () => {
    const result = formatWorkspaceDeliveryEnvelope([makeEntry()])!;
    expect(result).not.toContain('dropped=');
  });

  it('includes dropped="N" attribute when droppedCount > 0', () => {
    const result = formatWorkspaceDeliveryEnvelope([makeEntry()], 3)!;
    expect(result).toContain('dropped="3"');
    // Attribute must appear in the opening envelope tag
    const envelopeOpenTag = result.split('>')[0] + '>';
    expect(envelopeOpenTag).toContain('dropped="3"');
  });

  it('escapes single-quotes and angle brackets in subject attribute', () => {
    const entry = makeEntry({ subject: "it's a <test> & 'value'" });
    const result = formatWorkspaceDeliveryEnvelope([entry])!;
    expect(result).toContain('subject="it&apos;s a &lt;test&gt; &amp; &apos;value&apos;"');
  });
});

// ── generateSubscriptionId ──────────────────────────────────────────────────

describe('generateSubscriptionId', () => {
  it('produces sub_ prefix with 8 hex chars', () => {
    const id = generateSubscriptionId();
    expect(id).toMatch(/^sub_[0-9a-f]{8}$/);
  });

  it('produces unique IDs', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateSubscriptionId()));
    expect(ids.size).toBe(50);
  });
});
