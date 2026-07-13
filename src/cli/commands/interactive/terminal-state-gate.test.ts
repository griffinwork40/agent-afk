import { describe, it, expect } from 'vitest';
import {
  createTerminalStateGate,
  TERMINAL_STATE_GATE_CORRECTION,
  DEFAULT_MAX_TERMINAL_STATE_INJECTIONS,
} from './terminal-state-gate.js';
import type { StopContext } from '../../../agent/hooks.js';
import type { PermissionMode } from '../../../agent/types/sdk-types.js';

const AUTONOMOUS: PermissionMode = 'autonomous';
const DEFAULT: PermissionMode = 'default';

function stop(over: Partial<StopContext> = {}): StopContext {
  return { event: 'Stop', sessionId: 's', ...over };
}

/** Enabled + autonomous factory: the "armed" configuration. */
function armedGate(over: Partial<Parameters<typeof createTerminalStateGate>[0]> = {}) {
  return createTerminalStateGate({
    getPermissionMode: () => AUTONOMOUS,
    isEnabled: () => true,
    ...over,
  });
}

describe('createTerminalStateGate', () => {
  it('injects a correction on an unbacked Done (autonomous + enabled)', async () => {
    const gate = armedGate();
    const decision = await gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: false }));
    expect(decision.injectContext).toBe(TERMINAL_STATE_GATE_CORRECTION);
  });

  it('stays silent when the feature is disabled', async () => {
    const gate = createTerminalStateGate({
      getPermissionMode: () => AUTONOMOUS,
      isEnabled: () => false,
    });
    const decision = await gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: false }));
    expect(decision.injectContext).toBeUndefined();
  });

  it('stays silent outside autonomous mode (human is watching)', async () => {
    const gate = createTerminalStateGate({
      getPermissionMode: () => DEFAULT,
      isEnabled: () => true,
    });
    const decision = await gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: false }));
    expect(decision.injectContext).toBeUndefined();
  });

  it('stays silent when Done HAS corroborating evidence', async () => {
    const gate = armedGate();
    const decision = await gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: true }));
    expect(decision.injectContext).toBeUndefined();
  });

  it('stays silent when evidence was not computed (undefined, not false)', async () => {
    const gate = armedGate();
    // undefined must NOT be treated as "no evidence" — only an explicit false fires.
    const decision = await gate(stop({ terminalState: 'done' }));
    expect(decision.injectContext).toBeUndefined();
  });

  it('stays silent for non-Done terminal states', async () => {
    const gate = armedGate();
    for (const kind of ['blocked', 'asking', 'interrupted'] as const) {
      const decision = await gate(stop({ terminalState: kind, doneHasCorroboratingEvidence: false }));
      expect(decision.injectContext).toBeUndefined();
    }
  });

  it('ignores non-Stop events', async () => {
    const gate = armedGate();
    const decision = await gate({ event: 'SessionEnd', sessionId: 's' });
    expect(decision.injectContext).toBeUndefined();
  });

  it('loop-guard: stops injecting after the per-session cap', async () => {
    const cap = 2;
    const gate = armedGate({ maxInjectionsPerSession: cap });
    const unbacked = () => gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: false }));

    for (let i = 0; i < cap; i++) {
      expect((await unbacked()).injectContext).toBe(TERMINAL_STATE_GATE_CORRECTION);
    }
    // Budget exhausted — the Done now stands (fail open).
    expect((await unbacked()).injectContext).toBeUndefined();
    expect((await unbacked()).injectContext).toBeUndefined();
  });

  it('defaults the cap to DEFAULT_MAX_TERMINAL_STATE_INJECTIONS', async () => {
    const gate = armedGate();
    const unbacked = () => gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: false }));
    for (let i = 0; i < DEFAULT_MAX_TERMINAL_STATE_INJECTIONS; i++) {
      expect((await unbacked()).injectContext).toBe(TERMINAL_STATE_GATE_CORRECTION);
    }
    expect((await unbacked()).injectContext).toBeUndefined();
  });

  it('reads isEnabled / getPermissionMode live on every call', async () => {
    let enabled = false;
    let mode: PermissionMode = DEFAULT;
    const gate = createTerminalStateGate({
      getPermissionMode: () => mode,
      isEnabled: () => enabled,
    });
    const unbacked = () => gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: false }));

    expect((await unbacked()).injectContext).toBeUndefined();
    enabled = true;
    mode = AUTONOMOUS;
    expect((await unbacked()).injectContext).toBe(TERMINAL_STATE_GATE_CORRECTION);
  });
});
