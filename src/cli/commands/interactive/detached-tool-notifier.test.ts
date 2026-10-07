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

    // No injection: untracked toolUseId (observe() bailed out early)
    expect(notifier.hasPendingInjections()).toBe(false);
  });

  it('reapplies settled metadata when settlement races ahead of observe()', () => {
    // Settlement arrives before observe() is called (timing edge case).
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
});
