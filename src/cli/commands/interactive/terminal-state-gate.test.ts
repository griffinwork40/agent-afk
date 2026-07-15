import { describe, it, expect, vi, afterEach } from 'vitest';
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

// Item 3 (#565): the gate emits a debug log on BOTH injection and
// cap-exhaustion, via the shared `debugLog` facility (console.log gated on
// AFK_DEBUG/DEBUG). These pin that observability — inert unless debug is on,
// tagged with the gate's `[terminal-state gate]` prefix and carrying the
// sessionId — without changing the gate's decision behavior.
describe('createTerminalStateGate — firing observability (#565)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['AFK_DEBUG'];
  });

  it('logs a debug line naming the budget position on each injection', async () => {
    process.env['AFK_DEBUG'] = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gate = armedGate({ maxInjectionsPerSession: 3 });

    await gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: false }));
    await gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: false }));

    // One log per injection, tagged + carrying the sessionId; the budget
    // position (n/cap) advances across calls so an operator can see the count.
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[terminal-state gate] injecting Done-evidence correction (1/3)'),
      expect.objectContaining({ sessionId: 's' }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[terminal-state gate] injecting Done-evidence correction (2/3)'),
      expect.objectContaining({ sessionId: 's' }),
    );
  });

  it('logs a distinct debug line when the budget is exhausted (fail open)', async () => {
    process.env['AFK_DEBUG'] = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gate = armedGate({ maxInjectionsPerSession: 1 });
    const unbacked = () => gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: false }));

    await unbacked(); // spends the single-slot budget (logs the injection)
    log.mockClear();
    const decision = await unbacked(); // over budget now

    // The Done stands (fail open) AND the exhaustion is observable.
    expect(decision.injectContext).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[terminal-state gate] injection budget exhausted (cap=1)'),
      expect.objectContaining({ sessionId: 's' }),
    );
  });

  it('emits NO log when AFK_DEBUG is unset (debugLog is inert)', async () => {
    delete process.env['AFK_DEBUG'];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gate = armedGate({ maxInjectionsPerSession: 1 });
    const unbacked = () => gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: false }));

    await unbacked(); // injection
    await unbacked(); // exhaustion
    expect(log).not.toHaveBeenCalled();
  });

  it('does not log for a no-op decision (disabled gate never touches the budget)', async () => {
    process.env['AFK_DEBUG'] = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const gate = createTerminalStateGate({
      getPermissionMode: () => AUTONOMOUS,
      isEnabled: () => false,
    });
    await gate(stop({ terminalState: 'done', doneHasCorroboratingEvidence: false }));
    expect(log).not.toHaveBeenCalled();
  });
});
