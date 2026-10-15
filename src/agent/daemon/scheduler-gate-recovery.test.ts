import { describe, expect, it, vi } from 'vitest';
import { makeGateBlockTraceWriter, makeGateBlockTraceOwner, gateRecoveryNote, type GateBlockCounter } from './scheduler-gate-recovery.js';
import { InMemoryTraceWriter } from '../trace/index.js';
import { AgentSession } from '../session/agent-session.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import type { TraceEventInput } from '../trace/types.js';

const block: TraceEventInput = {
  kind: 'hook_decision',
  payload: { hookEvent: 'PreToolUse', decision: 'block', approvalOutcome: 'hard-block', blockedTool: 'bash' },
};
const call: TraceEventInput = {
  kind: 'tool_call', payload: { phase: 'started', toolUseId: 't1', name: 'read_file', inputBytes: 100 },
};

describe('gate recovery observations', () => {
  it('preserves top-level trace sealing and forwards owner operations', async () => {
    const inner = new InMemoryTraceWriter();
    const seal = vi.spyOn(inner, 'seal');
    const close = vi.spyOn(inner, 'close');
    const counter: GateBlockCounter = { count: 0 };
    const owner = makeGateBlockTraceOwner(inner, counter)!;
    const session = new AgentSession({
      model: 'sonnet', provider: createMockProvider(), traceWriter: owner,
    }, owner);
    await owner.write(block);
    await owner.write(call);
    await session.close();
    expect(seal).toHaveBeenCalledOnce();
    expect(counter.calls).toEqual([{ blockedTool: 'bash', followingTools: ['read_file'] }]);
    await owner.close();
    expect(close).toHaveBeenCalledOnce();
    expect(makeGateBlockTraceOwner(inner, undefined)).toBe(inner);
    expect(makeGateBlockTraceOwner(undefined, counter)).toBeUndefined();
  });
  it('captures only bounded tool names in order, preserving all trace writes', async () => {
    const inner = { getTracePath: () => 'trace', write: vi.fn().mockResolvedValue(undefined) };
    const counter: GateBlockCounter = { count: 0 };
    const writer = makeGateBlockTraceWriter(inner, counter)!;
    await writer.write(call); // Before the block: not a recovery step.
    await writer.write(block);
    await writer.write(call);
    await writer.write({ ...block, payload: { ...block.payload, blockedTool: 'write_file' } } as TraceEventInput);
    for (let i = 0; i < 10; i++) await writer.write(call);
    for (let i = 0; i < 10; i++) await writer.write(block);
    expect(counter.count).toBe(12);
    expect(counter.calls).toHaveLength(5);
    expect(counter.calls?.[0]).toEqual({ blockedTool: 'bash', followingTools: Array(5).fill('read_file') });
    expect(counter.calls?.[1]?.blockedTool).toBe('write_file');
    expect(inner.write).toHaveBeenCalledTimes(24);
    expect(writer.getTracePath()).toBe('trace');
    expect(gateRecoveryNote(counter)).toBe('Recovered after 12 AFK gate block(s) (declared Done; not verified).');
  });

  it('counts unknown-tool blocks and strips control characters from labels', async () => {
    const counter: GateBlockCounter = { count: 0 };
    const inner = { getTracePath: () => 'trace', write: vi.fn().mockResolvedValue(undefined) };
    const writer = makeGateBlockTraceWriter(inner, counter)!;
    await writer.write({ kind: 'hook_decision', payload: { hookEvent: 'Stop', approvalOutcome: 'hard-block' } });
    await writer.write({ kind: 'tool_call', payload: { ...call.payload, phase: 'started', toolUseId: 't', name: 'secret\nname', inputBytes: 0 } });
    expect(counter.calls).toEqual([{ blockedTool: 'unknown', followingTools: ['secret_name'] }]);
  });

  it('does not count operator denials or retain arguments/reasons', async () => {
    const counter: GateBlockCounter = { count: 0 };
    const inner = { getTracePath: () => 'trace', write: vi.fn().mockResolvedValue(undefined) };
    const writer = makeGateBlockTraceWriter(inner, counter)!;
    await writer.write({ kind: 'hook_decision', payload: { hookEvent: 'PreToolUse', approvalOutcome: 'denied' } });
    await writer.write({ kind: 'hook_decision', payload: { hookEvent: 'PreToolUse', approvalOutcome: 'hard-block', blockedTool: 'bash', reason: 'sensitive details' } });
    expect(counter.count).toBe(1);
    expect(JSON.stringify(counter)).not.toContain('sensitive details');
  });

  it('preserves the optional trace/counter behavior', () => {
    const inner = { getTracePath: () => 'trace', write: vi.fn() };
    expect(makeGateBlockTraceWriter(undefined, { count: 0 })).toBeUndefined();
    expect(makeGateBlockTraceWriter(inner, undefined)).toBe(inner);
  });
});
