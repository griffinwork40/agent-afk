import { describe, expect, it } from 'vitest';
import { createHookRegistry } from '../hook-registry.js';
import type { HookContext, HookDecision, HookRegistry } from '../hooks.js';
import { HookBlockedError } from '../../utils/errors.js';
import { dispatchSessionEnd, dispatchSessionStart, dispatchStopHook } from '../session/hooks-dispatch.js';
import {
  dispatchPostToolUse, dispatchPostToolUseFailure, dispatchPreToolUse,
  dispatchSubagentStart, dispatchSubagentStop,
} from '../subagent-hooks.js';
import { createBashRestrictionHook } from '../tools/hooks/bash-restriction-hook.js';
import { HookDecisionPayloadSchema } from './events.js';
import { InMemoryTraceWriter } from './writer.js';

type DispatchCase = {
  context: HookContext;
  blocking: boolean;
  dispatch: (registry: HookRegistry, writer: InMemoryTraceWriter) => Promise<unknown>;
};
const cases: DispatchCase[] = [
  {
    context: { event: 'SessionStart' }, blocking: true,
    dispatch: (r, w) => dispatchSessionStart(r, { event: 'SessionStart' }, { traceWriter: w }),
  },
  {
    context: { event: 'SessionEnd' }, blocking: false,
    dispatch: (r, w) => dispatchSessionEnd(r, { event: 'SessionEnd' }, { traceWriter: w }),
  },
  {
    context: { event: 'Stop' }, blocking: false,
    dispatch: (r, w) => dispatchStopHook(r, { event: 'Stop' }, { traceWriter: w, hasNextTurn: true }),
  },
  {
    context: { event: 'SubagentStart', subagentId: 'child' }, blocking: true,
    dispatch: (r, w) => dispatchSubagentStart(r, { event: 'SubagentStart', subagentId: 'child' }, { traceWriter: w }),
  },
  {
    context: { event: 'SubagentStop', subagentId: 'child', status: 'succeeded' }, blocking: false,
    dispatch: (r, w) => dispatchSubagentStop(r, { event: 'SubagentStop', subagentId: 'child', status: 'succeeded' }, { traceWriter: w }),
  },
  {
    context: { event: 'PreToolUse', toolName: 'bash' }, blocking: true,
    dispatch: (r, w) => dispatchPreToolUse(r, { event: 'PreToolUse', toolName: 'bash' }, { traceWriter: w }),
  },
  {
    context: { event: 'PostToolUse', toolName: 'bash' }, blocking: false,
    dispatch: (r, w) => dispatchPostToolUse(r, { event: 'PostToolUse', toolName: 'bash' }, { traceWriter: w }),
  },
  {
    context: { event: 'PostToolUseFailure', toolName: 'bash', error: 'failed' }, blocking: false,
    dispatch: (r, w) => dispatchPostToolUseFailure(r, { event: 'PostToolUseFailure', toolName: 'bash', error: 'failed' }, { traceWriter: w }),
  },
];

function payloads(writer: InMemoryTraceWriter) {
  return writer.events.flatMap(e => e.kind === 'hook_decision' ? [e.payload] : []);
}

describe.each(cases)('ruleId handler → registry → trace ($context.event)', ({ context, dispatch, blocking }) => {
  it.each(['block', 'continue-false', 'approve', 'metadata-only', 'legacy'] as const)('%s preserves metadata without changing control flow', async mode => {
    const registry = createHookRegistry();
    const writer = new InMemoryTraceWriter();
    const decision: HookDecision = {
      ...(mode === 'block' || mode === 'legacy' ? { decision: 'block' as const } : {}),
      ...(mode === 'continue-false' ? { continue: false } : {}),
      ...(mode === 'approve' ? { decision: 'approve' as const } : {}),
      ...(mode !== 'legacy' ? { ruleId: 'test.stable-rule' } : {}),
    };
    registry.register(context.event, () => decision);
    const isBlock = mode === 'block' || mode === 'continue-false' || mode === 'legacy';
    const pending = dispatch(registry, writer);
    if (isBlock && blocking) {
      await expect(pending).rejects.toMatchObject({ event: context.event, ruleId: decision.ruleId });
    } else {
      await expect(pending).resolves.not.toThrow();
    }
    const rows = payloads(writer);
    // metadata-only (ruleId with no decision) is non-informative and suppressed
    if (mode === 'metadata-only') {
      expect(rows).toHaveLength(0);
      return;
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe(isBlock ? 'block' : decision.decision);
    if (mode === 'legacy') expect(rows[0]).not.toHaveProperty('ruleId');
    else expect(rows[0]?.ruleId).toBe('test.stable-rule');
    expect(HookDecisionPayloadSchema.parse(JSON.parse(JSON.stringify(rows[0])))).toEqual(rows[0]);
  });
});

describe('ruleId registry contract', () => {
  it('ruleId is informative when accompanied by a decision (approve)', async () => {
    const registry = createHookRegistry();
    const writer = new InMemoryTraceWriter();
    registry.register('SessionStart', () => ({ decision: 'approve' as const, ruleId: 'my-rule' }));
    await dispatchSessionStart(registry, { event: 'SessionStart' }, { traceWriter: writer });
    const rows = payloads(writer);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ruleId).toBe('my-rule');
    expect(rows[0]?.decision).toBe('approve');
  });

  it('uses only the blocking handler ID, not an earlier approving ID', async () => {
    const registry = createHookRegistry();
    registry.register('PreToolUse', () => ({ decision: 'approve', ruleId: 'earlier' }));
    registry.register('PreToolUse', () => ({ decision: 'block' }));
    await expect(registry.dispatch({ event: 'PreToolUse', toolName: 'bash' })).rejects.toMatchObject({ ruleId: undefined });
  });

  it('retains last-handler-wins merge semantics for non-blocking IDs', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', () => ({ ruleId: 'first', injectContext: 'one' }));
    registry.register('SessionStart', () => ({ ruleId: 'last', injectContext: 'two' }));
    expect(await registry.dispatch({ event: 'SessionStart' })).toEqual({ ruleId: 'last', injectContext: 'one\ntwo' });
  });

  it('preserves an explicitly thrown HookBlockedError ID through fail-safe wrapping', async () => {
    const registry = createHookRegistry();
    const cause = new HookBlockedError('blocked', 'SessionStart', 'policy', { ruleId: 'thrown.rule' });
    registry.register('SessionStart', () => { throw cause; });
    const writer = new InMemoryTraceWriter();
    await expect(dispatchSessionStart(registry, { event: 'SessionStart' }, { traceWriter: writer }))
      .rejects.toMatchObject({ cause, ruleId: 'thrown.rule' });
    expect(payloads(writer)[0]?.ruleId).toBe('thrown.rule');
  });

  it('does not infer an ID from arbitrary thrown objects', async () => {
    const registry = createHookRegistry();
    registry.register('SessionStart', () => { throw { ruleId: 'not-a-hook-error' }; });
    const writer = new InMemoryTraceWriter();
    await expect(dispatchSessionStart(registry, { event: 'SessionStart' }, { traceWriter: writer })).rejects.toBeInstanceOf(HookBlockedError);
    expect(payloads(writer)[0]).not.toHaveProperty('ruleId');
  });
});

describe('real bash restriction hook → trace', () => {
  it('tags the sensitive-interpreter branch without altering its block', async () => {
    const registry = createHookRegistry();
    registry.register('PreToolUse', createBashRestrictionHook({ forceInterpreterGuard: true }));
    const writer = new InMemoryTraceWriter();
    await expect(dispatchPreToolUse(registry, {
      event: 'PreToolUse', toolName: 'bash', input: { command: 'python -c "open(\'~/.ssh/id_rsa\')"' },
    }, { traceWriter: writer })).rejects.toMatchObject({ ruleId: 'bash-restriction.sensitive-interpreter' });
    expect(payloads(writer)[0]).toMatchObject({ decision: 'block', ruleId: 'bash-restriction.sensitive-interpreter' });
  });

  it('tags restricted-path blocks and leaves a benign command allowed', async () => {
    const registry = createHookRegistry();
    registry.register('PreToolUse', createBashRestrictionHook({}));
    const writer = new InMemoryTraceWriter();
    await expect(dispatchPreToolUse(registry, {
      event: 'PreToolUse', toolName: 'bash', input: { command: 'cat ~/.ssh/id_rsa' },
    }, { traceWriter: writer })).rejects.toMatchObject({ ruleId: 'bash-restriction.restricted-path' });
    expect(payloads(writer)[0]).toMatchObject({ decision: 'block', blockedTool: 'bash', ruleId: 'bash-restriction.restricted-path' });
    await expect(dispatchPreToolUse(registry, {
      event: 'PreToolUse', toolName: 'bash', input: { command: 'echo hello' },
    }, { traceWriter: writer })).resolves.toEqual({});
    expect(payloads(writer)).toHaveLength(1);
  });
});
