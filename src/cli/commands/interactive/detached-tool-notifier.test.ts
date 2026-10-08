/**
 * Tests for DetachedToolNotifier (#2932, registry wiring item).
 *
 * Verifies:
 *  - settled events are injected and forwarded to the wake hook
 *  - drainInjections/drainNotices clear buffers
 *  - partial metadata (incomplete, incompleteReason, partialNodeCount) is patched
 *    back onto the original ToolEvent when the settled result carries them
 *  - observe() ignores non-bash/compose tools
 *  - settlements for untracked toolUseIds (outgoing-session after /resume) are dropped
 *  - reset() clears tracked entries, injections, and notices
 *  - dispose() unsubscribes from the registry
 *  - settle-before-observe race: result buffered and applied when observe() arrives
 *
 * @module cli/commands/interactive/detached-tool-notifier.test
 */

import { describe, it, expect, vi } from 'vitest';
import { DetachableToolRegistry } from '../../../agent/tools/detach-registry.js';
import { DetachedToolNotifier, buildDetachedToolInjection } from './detached-tool-notifier.js';
import type { DetachedToolResult } from '../../../agent/tools/detach-registry.js';
import type { ToolEvent } from '../../slash/types.js';

function makeResult(overrides: Partial<DetachedToolResult> = {}): DetachedToolResult {
  return {
    toolUseId: 'call-1',
    label: 'echo hi',
    status: 'completed',
    output: 'hello',
    durationMs: 100,
    ...overrides,
  };
}

function makeEvent(toolName: string = 'bash', toolUseId: string = 'call-1'): ToolEvent {
  return { toolName, toolUseId };
}

describe('DetachedToolNotifier', () => {
  it('delivers injection and notice when a tracked tool settles', () => {
    const registry = new DetachableToolRegistry();
    const notifier = new DetachedToolNotifier(registry);

    const woke = vi.fn();
    notifier.onInjectable = woke;

    const event = makeEvent();
    notifier.observe(event);

    const token = registry.register('call-1');
    token.notifyDetached();
    token.deliver(makeResult());

    expect(woke).toHaveBeenCalledOnce();
    expect(notifier.hasPendingInjections()).toBe(true);
    const injected = notifier.drainInjections();
    expect(injected).toContain('call-1');
    expect(injected).toContain('completed');
    expect(notifier.hasPendingInjections()).toBe(false);

    const notices = notifier.drainNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('call-1');
  });

  it('patches incomplete/incompleteReason/partialNodeCount back onto the ToolEvent', () => {
    const registry = new DetachableToolRegistry();
    const notifier = new DetachedToolNotifier(registry);

    const event = makeEvent('compose');
    notifier.observe(event);

    const token = registry.register('call-1');
    token.notifyDetached();
    token.deliver(makeResult({
      toolUseId: 'call-1',
      status: 'completed',
      incomplete: true,
      incompleteReason: 'compose_partial_nodes',
      partialNodeCount: 2,
    }));

    expect(event.incomplete).toBe(true);
    expect(event.incompleteReason).toBe('compose_partial_nodes');
    expect(event.partialNodeCount).toBe(2);
  });

  it('drops settled results for untracked toolUseIds (post-/resume isolation)', () => {
    const registry = new DetachableToolRegistry();
    const notifier = new DetachedToolNotifier(registry);

    const token = registry.register('call-unknown');
    token.notifyDetached();
    // NOT observed — simulates an outgoing-session call
    token.deliver(makeResult({ toolUseId: 'call-unknown' }));

    // After reset() (which dispose() also calls), earlySettled is cleared
    // and the result must not leak.
    notifier.reset();

    expect(notifier.hasPendingInjections()).toBe(false);
    expect(notifier.drainNotices()).toHaveLength(0);
  });

  it('ignores non-bash/compose tools', () => {
    const registry = new DetachableToolRegistry();
    const notifier = new DetachedToolNotifier(registry);

    // These should be ignored by observe()
    const ev = makeEvent('read_file', 'call-rf');
    notifier.observe(ev);

    const token = registry.register('call-rf');
    token.notifyDetached();
    token.deliver(makeResult({ toolUseId: 'call-rf' }));

    // observe() bailed early → id is in earlySettled but not tracked.
    // reset() to verify nothing leaked into injections.
    notifier.reset();
    expect(notifier.hasPendingInjections()).toBe(false);
  });

  it('observe() after settlement: patches event and queues injection (normal path)', () => {
    // observe() is called first (normal ordering), then settled fires.
    const registry = new DetachableToolRegistry();
    const notifier = new DetachedToolNotifier(registry);

    const event = makeEvent();
    notifier.observe(event); // track first
    const token = registry.register('call-1');
    token.notifyDetached();
    token.deliver(makeResult({ status: 'failed', output: 'err' }));

    expect(event.result).toBe('err');
    expect(event.isError).toBe(true);
  });

  it('settle before observe(): result buffered and applied when observe() arrives', () => {
    // This is the REAL race: settled fires before observe() is called.
    // Prior to the fix, the !entry guard in onSettled silently dropped the result.
    // Now earlySettled buffers it so observe() can pick it up.
    const registry = new DetachableToolRegistry();
    const notifier = new DetachedToolNotifier(registry);

    const woke = vi.fn();
    notifier.onInjectable = woke;

    // Settle BEFORE observe() is called — simulates a very fast bash command
    // whose settled event fires before the turn handler processes the tool_use_start.
    const token = registry.register('call-1');
    token.notifyDetached();
    token.deliver(makeResult({ status: 'completed', output: 'fast' }));

    // At this point observe() has NOT been called yet.
    // The old code would have dropped the result here with `if (!entry) return`.
    // Injection should NOT be queued yet (we don't have the event to patch).
    expect(notifier.hasPendingInjections()).toBe(false);

    // Now observe() arrives with the tool_use_start event (no result yet).
    const event = makeEvent();
    notifier.observe(event);

    // The early-settled result should now be applied and the injection queued.
    expect(event.result).toBe('fast');
    expect(event.isError).toBe(false);
    expect(notifier.hasPendingInjections()).toBe(true);
    expect(woke).toHaveBeenCalledOnce();

    const injected = notifier.drainInjections();
    expect(injected).toContain('call-1');
    expect(injected).toContain('completed');

    // Notice queuing on the early-settle path must also fire (previously unasserted).
    expect(notifier.drainNotices()).toHaveLength(1);
  });

  it('earlySettled cap: does not grow beyond MAX_TRACKED unseen ids', () => {
    // Fill earlySettled to capacity without ever calling observe().
    // Each delivered result for an untracked id goes into earlySettled.
    // After MAX_TRACKED (1000) entries the cap kicks in and subsequent results
    // are silently discarded rather than growing the map without bound.
    const registry = new DetachableToolRegistry();
    const notifier = new DetachedToolNotifier(registry);

    const MAX_TRACKED = 1000;
    // Fill to the cap.
    for (let i = 0; i < MAX_TRACKED; i++) {
      const id = `cap-test-${i}`;
      const token = registry.register(id);
      token.notifyDetached();
      token.deliver(makeResult({ toolUseId: id }));
    }

    // The next result should be silently dropped (cap enforced).
    const overflowId = 'cap-overflow';
    const overflowToken = registry.register(overflowId);
    overflowToken.notifyDetached();
    overflowToken.deliver(makeResult({ toolUseId: overflowId }));

    // Calling observe() for the overflow id should NOT produce an injection
    // because the result was dropped.
    const ev = makeEvent('bash', overflowId);
    ev.result = JSON.stringify({ status: 'detached' });
    notifier.observe(ev);

    // No injection should have been queued for the overflow id.
    const injected = notifier.drainInjections();
    expect(injected).not.toContain(overflowId);
  });

  it('reset() clears all state', () => {
    const registry = new DetachableToolRegistry();
    const notifier = new DetachedToolNotifier(registry);

    notifier.observe(makeEvent());
    const token = registry.register('call-1');
    token.notifyDetached();
    token.deliver(makeResult());

    expect(notifier.hasPendingInjections()).toBe(true);
    notifier.reset();
    expect(notifier.hasPendingInjections()).toBe(false);
    expect(notifier.drainNotices()).toHaveLength(0);
  });

  it('dispose() unsubscribes from the registry', () => {
    const registry = new DetachableToolRegistry();
    const notifier = new DetachedToolNotifier(registry);

    notifier.observe(makeEvent());
    notifier.dispose();

    const token = registry.register('call-1');
    token.notifyDetached();
    token.deliver(makeResult());

    // After dispose, settled events must not land
    expect(notifier.hasPendingInjections()).toBe(false);
  });
});

describe('buildDetachedToolInjection', () => {
  it('includes toolUseId, status, and output in the envelope', () => {
    const result = makeResult({ output: 'hello world' });
    const xml = buildDetachedToolInjection(result);
    expect(xml).toContain('call-1');
    expect(xml).toContain('completed');
    expect(xml).toContain('hello world');
  });

  it('includes incomplete/incompleteReason/partialNodeCount attributes when present', () => {
    const result = makeResult({
      incomplete: true,
      incompleteReason: 'compose_partial_nodes',
      partialNodeCount: 3,
    });
    const xml = buildDetachedToolInjection(result);
    expect(xml).toContain('incomplete="true"');
    expect(xml).toContain('incompleteReason="compose_partial_nodes"');
    expect(xml).toContain('partialNodeCount="3"');
  });

  it('caps output at MAX_OUTPUT_BYTES with a truncation marker', () => {
    const big = 'x'.repeat(20 * 1024); // 20KB
    const xml = buildDetachedToolInjection(makeResult({ output: big }));
    expect(xml).toContain('[detached output truncated]');
  });

  it('escapes XML special chars in output', () => {
    const result = makeResult({ output: '<script>alert("xss")</script>' });
    const xml = buildDetachedToolInjection(result);
    expect(xml).not.toContain('<script>');
    expect(xml).toContain('&lt;script&gt;');
  });

  it('strips control chars from toolUseId before inserting into XML attributes', () => {
    // A toolUseId with embedded control characters must not reach the XML envelope.
    const result = makeResult({ toolUseId: 'call\x00-\x1f-bad\x7f' });
    const xml = buildDetachedToolInjection(result);
    // Extract only the opening tag (attribute line) — the body may have newlines.
    const openingTag = xml.slice(0, xml.indexOf('>') + 1);
    // Control bytes must not appear in the attribute values.
    // eslint-disable-next-line no-control-regex
    expect(openingTag).not.toMatch(/[\x00-\x1f\x7f]/);
    // The printable portion of the id must still be present.
    expect(openingTag).toContain('call--bad');
  });

  it('does not leave a partial XML entity after truncation', () => {
    // Build a string that when escaped and truncated ends mid-entity.
    // 16KB of 'a', then some '<' chars so escaping produces '&lt;' sequences.
    // Position the '<' so the escaped form is cut mid-entity at the byte cap.
    const safe = 'a'.repeat(16 * 1024 - 4); // leave 4 bytes for '&lt;'
    const tricky = safe + '<<<<'; // each '<' → '&lt;' (4 bytes)
    const xml = buildDetachedToolInjection(makeResult({ output: tricky }));
    // Must not end with an orphaned '&' or '&l' or '&lt' fragment before the marker
    const outputContent = xml.split('<output>')[1]?.split('\n… [detached output truncated]')[0] ?? '';
    expect(outputContent).not.toMatch(/&[^;]*$/);
  });
});
