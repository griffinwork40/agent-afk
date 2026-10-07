import { describe, it, expect, vi } from 'vitest';
import { DetachableToolRegistry, type DetachedToolResult } from '../../../agent/tools/detach-registry.js';
import { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
import { BgResultNotifier } from './bg-result-notifier.js';
import { buildDetachedToolInjection } from './detached-tool-notifier.js';
import { runTurn } from './turn-handler.js';
import type { AgentSession } from '../../../agent/session.js';
import type { OutputEvent } from '../../../agent/types.js';
import type { SessionStats, ToolEvent } from '../../slash/types.js';
import { saveSession, loadSession } from '../../session-store.js';

const result = (id: string, extra: Partial<DetachedToolResult> = {}): DetachedToolResult => ({
  toolUseId: id, label: 'command', status: 'completed', output: 'done', durationMs: 40, ...extra,
});
function setup() {
  const registry = new DetachableToolRegistry();
  const notifier = new BgResultNotifier(new BackgroundAgentRegistry({}), registry);
  return { registry, notifier };
}
function track(notifier: BgResultNotifier, id: string, toolName = 'bash'): ToolEvent {
  const event: ToolEvent = { toolUseId: id, toolName, input: 'run' };
  notifier.observeToolEvent(event);
  event.result = JSON.stringify({ status: 'detached' });
  notifier.observeToolEvent(event);
  return event;
}

describe('detached tool REPL delivery', () => {
  it('delivers independently once per id, after buffering, then drains once', () => {
    const { registry, notifier } = setup();
    const a = track(notifier, 'a');
    const b = track(notifier, 'b');
    const wake = vi.fn(() => expect(notifier.hasPendingInjections()).toBe(true));
    notifier.onInjectable = wake;
    const ta = registry.register('a');
    const tb = registry.register('b');
    tb.deliver(result('b', { status: 'failed', exitCode: 1 }));
    ta.deliver(result('a', { exitCode: 0 }));
    ta.deliver(result('a'));
    expect(wake).toHaveBeenCalledTimes(2);
    expect(a.isError).toBe(false);
    expect(b.isError).toBe(true);
    const injection = notifier.drainInjections();
    expect(injection).toContain('toolUseId="b" status="failed"');
    expect(injection).toContain('toolUseId="a" status="completed"');
    expect(notifier.drainInjections()).toBe('');
    expect(notifier.drainToolNotices()).toHaveLength(2);
    expect(notifier.drainToolNotices()).toHaveLength(0);
    notifier.dispose();
    expect(registry.listenerCount('settled')).toBe(0);
  });

  it('reset drops queued and late outgoing-session results; teardown unsubscribes', () => {
    const { registry, notifier } = setup();
    const old = track(notifier, 'old');
    track(notifier, 'queued');
    const late = registry.register('old');
    registry.register('queued').deliver(result('queued'));
    notifier.reset();
    late.deliver(result('old', { incomplete: true }));
    expect(old.incomplete).toBeUndefined();
    expect(notifier.hasPendingInjections()).toBe(false);
    expect(notifier.drainToolNotices()).toEqual([]);
    track(notifier, 'cancelled');
    const cancelled = registry.register('cancelled');
    registry.cancelAll();
    cancelled.deliver(result('cancelled'));
    expect(notifier.drainInjections()).toBe('');
    notifier.dispose();
  });

  it('caps bursts to 25 envelopes and bounds escaped UTF-8 output', () => {
    const { registry, notifier } = setup();
    for (let i = 0; i < 30; i++) {
      const id = `job-${i}`;
      track(notifier, id);
      registry.register(id).deliver(result(id));
    }
    const out = notifier.drainInjections();
    expect(out.match(/<detached-tool-result /g)).toHaveLength(25);
    expect(out).not.toContain('toolUseId="job-0"');
    expect(notifier.drainToolNotices()).toHaveLength(25);
    const escaped = buildDetachedToolInjection(result('id"/><evil>', { output: '</output><evil>' + '<'.repeat(20000) }));
    expect(escaped).not.toContain('<evil>');
    expect(escaped).toContain('&quot;');
    expect(escaped).toContain('detached output truncated');
    expect(Buffer.byteLength(escaped)).toBeLessThan(17000);
    notifier.dispose();
  });

  it.each(['before-placeholder', 'after-turn'] as const)('forwards partial compose into original recorded turn: %s', async (when) => {
    const { registry, notifier } = setup();
    const token = registry.register('compose-id');
    const partial = result('compose-id', { output: 'partial nodes', incomplete: true,
      incompleteReason: 'compose_partial_nodes', partialNodeCount: 2 });
    const events: OutputEvent[] = [
      { type: 'chunk', chunk: { type: 'tool_use_detail', toolName: 'compose', toolUseId: 'compose-id', toolInput: '{}' } },
      { type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'compose-id', content: JSON.stringify({ status: 'detached' }) } },
      { type: 'done', metadata: { durationMs: 1 } },
    ];
    const session = { sessionId: 'test', interrupt: vi.fn(), sendMessageStream: async function* () {
      yield events[0]!;
      if (when === 'before-placeholder') token.deliver(partial);
      yield events[1]!;
      yield events[2]!;
    } } as unknown as AgentSession;
    const stats = { totalTurns: 0, totalCostUsd: 0, unpricedTurns: 0, totalTokens: 0,
      totalDurationMs: 0, sessionStartTime: Date.now(), turnCosts: [], turnTokens: [], turns: [],
      model: 'sonnet', permissionMode: 'default' } as SessionStats;
    await runTurn({ text: 'compose', attachments: [] }, session, stats, {
      setInFlight: vi.fn(), onToolEvent: (e) => notifier.observeToolEvent(e),
    }, 'off', { fn: vi.fn(), idleFn: vi.fn() });
    if (when === 'after-turn') token.deliver(partial);
    expect(stats.turns).toHaveLength(1);
    const saved = saveSession(stats, `detached-${when}`);
    const persisted = loadSession(saved)!.turns[0]!.toolEvents!;
    expect(persisted[0]).toMatchObject({ toolUseId: 'compose-id', result: 'partial nodes', isError: false,
      incomplete: true, incompleteReason: 'compose_partial_nodes', partialNodeCount: 2 });
    const injection = notifier.drainInjections();
    expect(injection).toContain('incomplete="true"');
    expect(injection).toContain('incompleteReason="compose_partial_nodes"');
    expect(injection).toContain('partialNodeCount="2"');
    notifier.dispose();
  });
});
