/**
 * Characterization tests for the REPL loop body (loop-iteration.ts), driven
 * end-to-end through the real `runReplLoop` orchestrator.
 *
 * Issue #104 noted that the loop body had near-zero coverage: the existing
 * wiring tests exit on the FIRST iteration (mocked `/exit` slash dispatch), so
 * branches that only fire across multiple iterations — the seed-buffer
 * auto-submit fast-path and the `!cmd` shell-passthrough dispatch — were
 * exercised by no integration test. These tests script `surface.readLine` to
 * return a multi-step sequence so the loop runs ≥2 iterations, locking those
 * branches against regressions from the phase-module extraction.
 *
 * Strategy mirrors repl-loop-wiring.test.ts: mock the heavy collaborators
 * (InputSurface, turn-handler, slash registry, background subsystems) and
 * assert on the loop's observable side-effects (runTurn dispatch, shell
 * dispatch, readLine call count).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mutable state shared with the mock factories below (vi.mock is
// hoisted above imports, so any closure it references must be hoisted too).
const surfaceState = vi.hoisted(() => ({
  // `beforeReturn` (optional) runs just before the entry is returned — used
  // to fire mid-loop side effects (e.g. settling a background job) at a
  // point where the loop's subsystems are already constructed.
  readLineQueue: [] as Array<{ text: string; attachments: unknown[]; beforeReturn?: () => void }>,
  readLineCalls: 0,
}));
const shellState = vi.hoisted(() => ({
  dispatch: vi.fn(async (_input: string) => true),
}));

// Hoisted state for the wireStopHook mock: captures the callbacks the REPL
// supplies so tests can invoke them to simulate the session-layer Stop dispatch.
const wireStopHookState = vi.hoisted(() => ({
  opts: null as null | {
    getHasNextTurn: () => boolean;
    onStopInjectContext?: (text: string) => void;
    onStopBlocked?: (reason: string | undefined) => void;
    onStopTimeout?: () => void;
  },
  callCount: 0,
  reset() { this.opts = null; this.callCount = 0; },
}));

vi.mock('../../input/history.js', () => ({
  loadHistory: vi.fn(async () => ({ push: vi.fn(), cursor: 0, entries: [] })),
}));
vi.mock('./turn-handler.js', () => ({
  runTurn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../slash/registry.js', () => ({
  dispatch: vi.fn(),
  parse: vi.fn(() => null),
}));
vi.mock('../../slash/plugin-skills.js', () => ({
  autoRegisterPluginPassthroughs: vi.fn(async () => {}),
  getPluginShadowingNoticeLines: vi.fn(() => []),
}));

vi.mock('../../background-status-bar.js', () => ({
  BackgroundStatusBar: class {
    setRowCountChangeHandler() {}
    start() {}
    stop() {}
    redraw() {}
    formatJobLine() { return ''; }
  },
}));
vi.mock('./context-pane.js', () => ({
  createContextPane: vi.fn(() => ({ renderIfChanged: () => [], dispose: () => {} })),
}));
vi.mock('./verdict-ledger.js', () => ({
  createVerdictLedger: vi.fn(() => ({
    render: () => null,
    push: () => {},
    reset: () => {},
    entries: () => [],
    setRowCountChangeHandler: () => {},
    start: () => {},
    stop: () => {},
    repaint: () => {},
  })),
}));
vi.mock('../../slash/commands/sh.js', () => ({ setShellPassthrough: vi.fn() }));
vi.mock('../../debug-banner.js', () => ({ renderDebugBanner: () => '' }));
vi.mock('../../../utils/debug.js', () => ({ isDebugEnabled: () => false, debugLog: () => {} }));
vi.mock('../../permission-mode-cycle.js', () => ({ cyclePermissionMode: vi.fn(async () => {}) }));

// Shell-passthrough mock — `dispatch` routes to the hoisted spy so the
// shell-branch test can assert it was invoked; drain methods are inert.
vi.mock('./shell-passthrough.js', () => ({
  ShellPassthrough: class {
    constructor(_opts: unknown) {}
    async dispatch(input: string): Promise<boolean> { return shellState.dispatch(input); }
    drainNotifications(): unknown[] { return []; }
    drainInjections(): string { return ''; }
    drainOnExit(): void {}
    abortActiveForeground(): boolean { return false; }
  },
}));

// FakeInputSurface — non-TTY (getCompositor() === null), so the loop uses the
// readWithAutocomplete fallback path and `readLine` is the sole input source.
// `readLine` returns the scripted queue so we can drive multiple iterations.
vi.mock('../../input/input-surface.js', () => {
  class FakeInputSurface {
    history = { getEntries: () => [] };
    autocompleteState = { candidates: [] };
    constructor(_opts: unknown) {}
    async armCompositor(_opts: unknown): Promise<void> {}
    getCompositor(): null { return null; }
    setSoftStopHandler(_handler: (() => void) | null): void {}
    setBackgroundHandler(_handler: unknown): void {}
    async readLine(_opts: unknown): Promise<{ text: string; attachments: unknown[] }> {
      surfaceState.readLineCalls += 1;
      const entry = surfaceState.readLineQueue.shift() ?? { text: '/exit', attachments: [] };
      entry.beforeReturn?.();
      return { text: entry.text, attachments: entry.attachments };
    }
    toRunTurnRefs(_prompt: string): Record<string, unknown> { return {}; }
    async dispose(): Promise<void> {}
  }
  return { InputSurface: FakeInputSurface };
});

import { runReplLoop, type TurnState } from './repl-loop.js';
import type { InteractiveCtx } from './shared.js';
import { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
import { runTurn } from './turn-handler.js';
import * as slashMod from '../../slash/registry.js';
import * as pluginSkillsMod from '../../slash/plugin-skills.js';
import { createHookRegistry } from '../../../agent/hooks.js';
import { HookHandlerTimeoutError } from '../../../agent/hook-registry.js';
import {
  createTerminalStateGate,
  TERMINAL_STATE_GATE_CORRECTION,
} from './terminal-state-gate.js';

function makeCtx(overrides?: Partial<InteractiveCtx>): InteractiveCtx {
  return {
    session: {
      current: {
        sessionId: 'mock',
        waitForInitialization: vi.fn(async () => ({})),
        takePendingPlanExitSeed: vi.fn(async () => undefined),
        // Simulate AgentSession.wireStopHook: capture the callbacks the REPL
        // supplies so individual tests can invoke them to simulate the
        // session layer dispatching Stop (the actual dispatch moved from the
        // REPL to turn-stream-runner.ts in this PR).
        wireStopHook: vi.fn((opts: typeof wireStopHookState.opts) => {
          wireStopHookState.opts = opts;
          wireStopHookState.callCount += 1;
        }),
      },
    },
    stats: {
      totalTurns: 0,
      model: 'sonnet',
      permissionMode: 'default',
      sessionId: 'mock',
    },
    statusLine: {
      rearm: vi.fn(),
      setExtraRows: vi.fn(),
      getExtraRows: vi.fn(() => 0),
      setAfterScrollRestore: vi.fn(),
      repaint: vi.fn(),
    },
    contextSampler: { onTurn: vi.fn(async () => {}), getRatio: () => undefined, refresh: vi.fn(async () => {}) },
    gitStatusSampler: { refresh: vi.fn(async () => {}), setOnUpdate: vi.fn(), getBranch: () => undefined, getPr: () => undefined },
    completionWriter: { fn: vi.fn(), idleFn: vi.fn() },
    replRenderer: { writeLine: vi.fn(), setCompositor: vi.fn() },
    slashCtx: { stats: { permissionMode: 'default' } },
    rl: { close: vi.fn() },
    options: { thinkingUi: undefined },
    inputSurfaceRef: { current: null },
    backgroundRegistry: new BackgroundAgentRegistry({}),
    // Required on InteractiveCtx (#745). This fixture feeds runReplLoop
    // directly and never reaches the drain site, so its absence was a
    // type-fidelity gap rather than a runtime throw — kept in sync anyway so
    // the cast cannot hide a future required field.
    bootWarnings: [],
    ...overrides,
  } as unknown as InteractiveCtx;
}

function makeTranscript() {
  return {
    path: () => '/tmp/mock',
    appendUser: vi.fn(async () => {}),
    appendTurn: vi.fn(async () => {}),
    rotateOnClear: vi.fn(async () => {}),
    appendEnded: vi.fn(async () => {}),
  };
}

function makeTurnState(): TurnState {
  return { turnInFlight: false, lastSigintAt: 0, activeCompositor: null } as TurnState;
}

beforeEach(() => {
  surfaceState.readLineQueue = [];
  surfaceState.readLineCalls = 0;
  shellState.dispatch.mockClear();
  shellState.dispatch.mockImplementation(async () => true);
  wireStopHookState.reset();
  vi.mocked(runTurn).mockClear();
  vi.mocked(slashMod.dispatch).mockReset();
  // Default dispatch behavior: '/seed' chains a user-text submit; '/exit'
  // ends the loop; anything else falls through to the agent (handled:false).
  vi.mocked(slashMod.dispatch).mockImplementation(async (text: string) => {
    if (text === '/exit') return { handled: true, result: 'exit' as const };
    if (text === '/seed') {
      return { handled: true, result: { kind: 'submit' as const, message: 'auto-submitted text' } };
    }
    return { handled: false as const };
  });
  delete process.env.AFK_SHELL_PASSTHROUGH;
});

describe('runReplLoop — plugin shadowing notices are debug-gated', () => {
  it('suppresses collision notices on a default (non-debug) run', async () => {
    // With 100+ plugin skills all shadowed by vendored equivalents, the
    // per-skill listing is pure noise on a default run. Notices are gated
    // behind isDebugEnabled() (AFK_DEBUG=1) and suppressed here because the
    // module-scope mock returns false.
    vi.mocked(pluginSkillsMod.getPluginShadowingNoticeLines).mockReturnValue([
      '  /mint: vendored or user skill wins; plugin form /example-plugin:mint stays reachable.',
    ]);
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    const lines = vi.mocked(ctx.replRenderer.writeLine).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('/example-plugin:mint'))).toBe(false);
  });

  it('stays silent when nothing collided', async () => {
    // The no-collision path is the common one — an empty array must not emit a
    // blank line or a header. Guards against "fix the gate, add noise instead".
    vi.mocked(pluginSkillsMod.getPluginShadowingNoticeLines).mockReturnValue([]);
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    const lines = vi.mocked(ctx.replRenderer.writeLine).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('stays reachable'))).toBe(false);
  });
});

describe('runReplLoop — seed-buffer auto-submit fast-path (multi-iteration)', () => {
  it('a slash submit result auto-submits on the NEXT iteration without a readLine', async () => {
    // Iteration 1: readLine → '/seed' → dispatch returns { kind: 'submit' } → seedBuffer set, continue.
    // Iteration 2: seedBuffer fast-path → echo + runTurn('auto-submitted text'), NO readLine.
    // Iteration 3: readLine → '/exit' → loop exits.
    surfaceState.readLineQueue = [
      { text: '/seed', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // readLine fired only twice — iteration 2 used the seed buffer, proving the
    // fast-path skipped the input read.
    expect(surfaceState.readLineCalls).toBe(2);
    // runTurn ran exactly once, with the seeded text (not the '/seed' command).
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
    const firstArg = vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string };
    expect(firstArg.text).toBe('auto-submitted text');
    // The fast-path echoed the auto-submitted buffer to the renderer.
    const echoes = vi.mocked(ctx.replRenderer.writeLine).mock.calls.map((c) => String(c[0]));
    expect(echoes.some((line) => line.includes('auto-submitted text'))).toBe(true);
  });
});

describe('runReplLoop — launch-argument seed (afk "prompt" / afk /command)', () => {
  it('auto-submits a plain-text launch arg as the opening turn without a readLine', async () => {
    // ctx.initialInput simulates `afk "what does this project do"`. The loop
    // pre-seeds seedBuffer from it, so iteration 1 takes the fast-path (echo +
    // runTurn) with NO readLine; iteration 2 reads the (empty) queue → '/exit'.
    const ctx = makeCtx({ initialInput: 'what does this project do' });
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // The turn ran once with the launch prompt (not a readLine value).
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
    const firstArg = vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string };
    expect(firstArg.text).toBe('what does this project do');
    // Plain text is NOT routed through the slash dispatcher — only the later
    // '/exit' read reaches it, never the seed.
    const dispatchInputs = vi.mocked(slashMod.dispatch).mock.calls.map((c) => c[0]);
    expect(dispatchInputs).not.toContain('what does this project do');
    // Only ONE readLine — the exit read; iteration 1 consumed the pre-seed.
    expect(surfaceState.readLineCalls).toBe(1);
    // The launch prompt was echoed to the renderer (auto-submit affordance).
    const echoes = vi.mocked(ctx.replRenderer.writeLine).mock.calls.map((c) => String(c[0]));
    expect(echoes.some((line) => line.includes('what does this project do'))).toBe(true);
  });

  it('routes a /slash launch arg through the slash dispatcher on the opening turn', async () => {
    // ctx.initialInput simulates `afk /review`. The pre-seed fast-path echoes
    // it and, because it starts with '/', hands it to the slash dispatcher —
    // exactly as if the user typed `/review` as their first line.
    const ctx = makeCtx({ initialInput: '/review' });
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // The launch arg reached the slash dispatcher first, before any readLine.
    const dispatchInputs = vi.mocked(slashMod.dispatch).mock.calls.map((c) => c[0]);
    expect(dispatchInputs[0]).toBe('/review');
    // No readLine was needed to dispatch the seed; readLine #1 is the exit read.
    expect(surfaceState.readLineCalls).toBe(1);
  });

  it('a bare launch (no initialInput) reads the first turn from input as before', async () => {
    // Regression guard: absent initialInput, the loop must NOT auto-submit —
    // iteration 1 reads from the surface exactly as a plain `afk` launch does.
    surfaceState.readLineQueue = [
      { text: 'typed first turn', attachments: [] },
      { text: '/exit', attachments: [] },
    ];
    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
    const firstArg = vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string };
    expect(firstArg.text).toBe('typed first turn');
    // Both lines were read — nothing was pre-seeded.
    expect(surfaceState.readLineCalls).toBe(2);
  });
});

describe('runReplLoop — exit_plan_mode drain mirrors the applied mode onto stats (#495)', () => {
  it('after draining an approved plan-exit seed, stats.permissionMode reflects the flipped mode', async () => {
    // Regression for #495. takePendingPlanExitSeed applies the deferred flip to
    // the SESSION's mode internally, but the plan-mode gate and the REPL prompt
    // read ctx.stats.permissionMode (bootstrap wires the gate to
    // `() => stats.permissionMode`). The drain MUST mirror the returned mode onto
    // stats — otherwise the gate stays plan-locked and the operator's prompt
    // never flips, even though exit_plan_mode reported success.
    const ctx = makeCtx();
    ctx.stats.permissionMode = 'plan';
    // Single-shot seed: first drain yields the approved seed + mode, then undefined.
    let drained = false;
    (
      ctx.session.current as unknown as {
        takePendingPlanExitSeed: () => Promise<{ message: string; mode: string } | undefined>;
      }
    ).takePendingPlanExitSeed = vi.fn(async () => {
      if (drained) return undefined;
      drained = true;
      return { message: 'IMPLEMENT-SEED', mode: 'bypassPermissions' };
    });
    // Iteration 1 drains the seed + auto-submits (no readLine); iteration 2 reads '/exit'.
    surfaceState.readLineQueue = [{ text: '/exit', attachments: [] }];

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // The applied mode is mirrored onto stats — the gate + prompt now see bypass.
    expect(ctx.stats.permissionMode).toBe('bypassPermissions');
    // The seed's message was auto-submitted as the implement turn.
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
    const firstArg = vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string };
    expect(firstArg.text).toBe('IMPLEMENT-SEED');
  });
});

describe('runReplLoop — shell-passthrough dispatch branch', () => {
  it('routes a `!cmd` line to ShellPassthrough.dispatch and does not run a model turn', async () => {
    // Iteration 1: readLine → '!echo hi' → shell dispatch handles it, continue.
    // Iteration 2: readLine → '/exit' → loop exits.
    surfaceState.readLineQueue = [
      { text: '!echo hi', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // The `!` line was routed to the shell passthrough, not the model.
    expect(shellState.dispatch).toHaveBeenCalledTimes(1);
    expect(shellState.dispatch).toHaveBeenCalledWith('!echo hi');
    expect(vi.mocked(runTurn)).not.toHaveBeenCalled();
    // First-use notice printed once on the first `!cmd` dispatch.
    const lines = vi.mocked(ctx.replRenderer.writeLine).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('shells out'))).toBe(true);
    // Both lines were read (the shell branch continued rather than exiting).
    expect(surfaceState.readLineCalls).toBe(2);
  });

  it('honors AFK_SHELL_PASSTHROUGH=0 — `!cmd` is NOT shelled out, falls through to the model', async () => {
    process.env.AFK_SHELL_PASSTHROUGH = '0';
    // '!echo hi' with passthrough disabled → literal text goes to the model.
    surfaceState.readLineQueue = [
      { text: '!echo hi', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // Shell dispatch must NOT have been invoked (env opt-out).
    expect(shellState.dispatch).not.toHaveBeenCalled();
    // The literal `!echo hi` was sent to the model as a normal turn.
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
    const firstArg = vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string };
    expect(firstArg.text).toBe('!echo hi');
  });
});

describe('runReplLoop — background-subagent result auto-delivery', () => {
  /** Stub a SubagentHandle whose runInBackground callback we control. */
  function makeBgHandle(id: string): {
    handle: import('../../../agent/subagent.js').SubagentHandle;
    fireTerminal: (r: import('../../../agent/subagent.js').SubagentResult) => void;
  } {
    let captured: ((r: import('../../../agent/subagent.js').SubagentResult) => void) | undefined;
    return {
      handle: {
        id,
        status: 'idle',
        runInBackground: vi.fn((_p: string, on?: (r: never) => void) => { captured = on as never; }),
        cancel: vi.fn().mockResolvedValue(undefined),
        teardown: vi.fn().mockResolvedValue(undefined),
        run: vi.fn(),
        runToResult: vi.fn(),
      } as unknown as import('../../../agent/subagent.js').SubagentHandle,
      fireTerminal: (r) => captured?.(r),
    };
  }

  it('prepends a settled background job result to the next model turn', async () => {
    const ctx = makeCtx();
    const registry = ctx.backgroundRegistry;
    const { handle, fireTerminal } = makeBgHandle('sub-loop-1');

    // Settle the job in the beforeReturn hook of the SECOND readLine call —
    // by then the loop's footer subsystems (incl. BgResultNotifier) are
    // constructed and subscribed, matching the real timing (job settles
    // while the user sits at the prompt).
    surfaceState.readLineQueue = [
      { text: 'first turn', attachments: [] },
      {
        text: 'second turn',
        attachments: [],
        beforeReturn: () => {
          const job = registry.register({ handle, prompt: 'bg investigation', model: 'sonnet' });
          void job;
          fireTerminal({
            id: 'sub-loop-1',
            status: 'succeeded',
            message: { content: 'bg finding: cache is stale', role: 'assistant' },
          } as never);
        },
      },
      { text: '/exit', attachments: [] },
    ];

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(2);
    const firstText = (vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string }).text;
    const secondText = (vi.mocked(runTurn).mock.calls[1]?.[0] as { text: string }).text;
    // First turn: no injection (nothing settled yet).
    expect(firstText).toBe('first turn');
    // Second turn: envelope prepended, user text preserved at the tail.
    expect(secondText).toContain('<background-subagent-result');
    expect(secondText).toContain('bg finding: cache is stale');
    expect(secondText.trimEnd().endsWith('second turn')).toBe(true);
    // Human notice rendered at the top of the iteration.
    const lines = vi.mocked(ctx.replRenderer.writeLine).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('subagent completed'))).toBe(true);
  });
});

// Architecture note (this PR): Stop is now dispatched by the session layer
// (turn-stream-runner.ts) via callbacks the REPL wires through wireStopHook().
// The REPL no longer calls registry.dispatch() for Stop directly. These tests
// verify the REPL's wiring and callback handling rather than the Stop dispatch
// itself — the dispatch-correctness tests live in turn-stream-runner tests.
describe('runReplLoop -- Stop hook wiring (session-layer dispatch)', () => {
  it('wires Stop at loop start and re-wires before each turn with getHasNextTurn: () => true', async () => {
    // Re-wiring before every turn covers /resume, which swaps
    // ctx.session.current for a new, un-wired AgentSession.
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // Once at loop start + once before the single 'hello' turn.
    expect(wireStopHookState.callCount).toBe(2);
    // REPL always has a next turn, so the getter must return true.
    expect(wireStopHookState.opts?.getHasNextTurn()).toBe(true);
  });

  it('does not dispatch Stop from the REPL loop itself (no double-fire)', async () => {
    // Prove the REPL no longer calls registry.dispatch() for Stop. The only
    // Stop dispatch happens via the session layer (wireStopHook callbacks).
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const registry = createHookRegistry();
    const stopHandler = vi.fn(async () => ({}));
    registry.register('Stop', stopHandler);
    const dispatchSpy = vi.spyOn(registry, 'dispatch');

    const ctx = makeCtx();
    ctx.hookRegistry = registry;
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // The REPL must NOT call dispatch with a Stop event — that would double-fire.
    const replStopCall = dispatchSpy.mock.calls.find(
      (args) => (args[0] as { event?: string }).event === 'Stop',
    );
    expect(replStopCall).toBeUndefined();
    // The REPL loop ran the 'hello' turn.
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
  });

  it('delivers onStopInjectContext into the NEXT turn\'s prompt', async () => {
    // Simulate the session layer calling onStopInjectContext after turn 1.
    surfaceState.readLineQueue = [
      { text: 'first turn', attachments: [] },
      { text: 'second turn', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    let callCount = 0;
    vi.mocked(runTurn).mockImplementation(async () => {
      callCount += 1;
      // After turn 1: simulate the session layer calling back with injectContext.
      if (callCount === 1) {
        wireStopHookState.opts?.onStopInjectContext?.('CORRECTION: substantiate your Done');
      }
    });

    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(2);
    const texts = vi.mocked(runTurn).mock.calls.map((c) => (c[0] as { text: string }).text);
    // First turn: no injection yet (session hasn't called back).
    expect(texts[0]).toBe('first turn');
    // Second turn: the correction was prepended, user text preserved at the tail.
    expect(texts[1]).toContain('CORRECTION: substantiate your Done');
    expect(texts[1]?.trimEnd().endsWith('second turn')).toBe(true);
  });

  it('consumes onStopInjectContext exactly once (not re-delivered on the third turn)', async () => {
    surfaceState.readLineQueue = [
      { text: 'turn one', attachments: [] },
      { text: 'turn two', attachments: [] },
      { text: 'turn three', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    let callCount = 0;
    vi.mocked(runTurn).mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        wireStopHookState.opts?.onStopInjectContext?.('ONE-SHOT-CORRECTION');
      }
    });

    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(3);
    const texts = vi.mocked(runTurn).mock.calls.map((c) => (c[0] as { text: string }).text);
    // Only the SECOND turn carries the correction; the third is clean.
    expect(texts[0]).toBe('turn one');
    expect(texts[1]).toContain('ONE-SHOT-CORRECTION');
    expect(texts[2]).toBe('turn three');
    expect(texts[2]).not.toContain('ONE-SHOT-CORRECTION');
  });

  it('second turn is clean when session does not call onStopInjectContext', async () => {
    // `dispatchStopHook` strips whitespace-only injectContext before calling
    // onStopInjectContext, so the callback is never invoked for a blank result.
    // This test verifies the REPL does not prepend anything when the session
    // does not call onStopInjectContext (simulates a handler returning {}).
    surfaceState.readLineQueue = [
      { text: 'alpha', attachments: [] },
      { text: 'beta', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    // Default runTurn mock does not call onStopInjectContext.
    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    const secondText = (vi.mocked(runTurn).mock.calls[1]?.[0] as { text: string }).text;
    expect(secondText).toBe('beta');
  });

  it('renders a blocked notice when onStopBlocked is called by the session layer', async () => {
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    vi.mocked(runTurn).mockImplementationOnce(async () => {
      // Simulate the session layer calling back with a block result.
      wireStopHookState.opts?.onStopBlocked?.('test block reason');
    });

    const ctx = makeCtx();
    const writerFn = vi.fn();
    ctx.completionWriter = { fn: writerFn, idleFn: vi.fn() };

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // completionWriter.fn should have been called with a blocked message.
    const writeCalls = writerFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(writeCalls.some((msg: unknown) => typeof msg === 'string' && msg.includes('blocked'))).toBe(true);
  });

  it('sanitises escape sequences in a blocked Stop reason before rendering', async () => {
    // SEC-1: a malicious hook reason containing ANSI escape sequences and OSC
    // payloads must not reach the terminal unescaped — sanitizeForDisplay must
    // strip all control sequences before the string is passed to palette.dim().
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const maliciousReason = '\u001b[31mhacked\u001b[0m\u001b]0;evil-title\u0007';

    vi.mocked(runTurn).mockImplementationOnce(async () => {
      wireStopHookState.opts?.onStopBlocked?.(maliciousReason);
    });

    const ctx = makeCtx();
    const writerFn = vi.fn();
    ctx.completionWriter = { fn: writerFn, idleFn: vi.fn() };

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // The rendered string must contain 'blocked'.
    const writeCalls = writerFn.mock.calls.map((c: unknown[]) => c[0] as string);
    const blockedMsg = writeCalls.find((msg) => msg.includes('blocked'));
    expect(blockedMsg).toBeDefined();
    // The raw ESC byte must have been stripped.
    expect(blockedMsg).not.toContain('\u001b');
    // The OSC payload text must not leak as visible output.
    expect(blockedMsg).not.toContain('evil-title');
  });

  it('renders a timed-out notice when onStopTimeout is called by the session layer', async () => {
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    vi.mocked(runTurn).mockImplementationOnce(async () => {
      wireStopHookState.opts?.onStopTimeout?.();
    });

    const ctx = makeCtx();
    const writerFn = vi.fn();
    ctx.completionWriter = { fn: writerFn, idleFn: vi.fn() };

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // completionWriter.fn should have been called with a timed-out message.
    const writeCalls = writerFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(writeCalls.some((msg: unknown) => typeof msg === 'string' && msg.includes('timed out'))).toBe(true);
  });

  it('loop completes normally when no wireStopHook is present on session', async () => {
    // Regression: if the session does not have wireStopHook (optional chaining),
    // the loop must not throw.
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx();
    // Remove wireStopHook from the session mock.
    (ctx.session.current as Record<string, unknown>)['wireStopHook'] = undefined;

    await expect(
      runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn()),
    ).resolves.toBeUndefined();
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
  });
});

describe('runReplLoop — UserPromptSubmit hook integration', () => {
  it('UserPromptSubmit block hook causes loop to continue without calling runTurn', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({
      decision: 'block' as const,
      reason: 'test block',
    }));

    surfaceState.readLineQueue = [
      { text: 'blocked prompt', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx({ hookRegistry: registry });
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // runTurn must NOT have been called — block hook short-circuits the turn.
    expect(vi.mocked(runTurn)).not.toHaveBeenCalled();
    // The warning message should have been written to the renderer.
    const lines = vi.mocked(ctx.replRenderer.writeLine).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('blocked by hook'))).toBe(true);
  });

  it('UserPromptSubmit injectContext hook prepends context to runText before runTurn', async () => {
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => ({
      injectContext: '[PREFIX] ',
    }));

    surfaceState.readLineQueue = [
      { text: 'base prompt', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx({ hookRegistry: registry });
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
    const firstArg = vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string };
    expect(firstArg.text).toBe('[PREFIX] base prompt');
  });

  it('UserPromptSubmit allow (no return) hook fires and passes through to runTurn unchanged', async () => {
    const registry = createHookRegistry();
    const handler = vi.fn(async () => ({}));
    registry.register('UserPromptSubmit', handler);

    surfaceState.readLineQueue = [
      { text: 'plain prompt', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx({ hookRegistry: registry });
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    expect(handler).toHaveBeenCalledOnce();
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
    const firstArg = vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string };
    expect(firstArg.text).toBe('plain prompt');
  });

  it('UserPromptSubmit handler timeout fails closed — loop writes a notice and continues, does not crash', async () => {
    // Regression (PR #280 review, finding #1): the registry re-throws
    // HookHandlerTimeoutError raw (so dispatchSubagentStop can distinguish a
    // timeout from a deliberate block). The REPL loop must treat it as a
    // fail-closed block — drop the turn, write a notice, continue — rather
    // than letting it unwind and crash the loop.
    const registry = createHookRegistry();
    registry.register('UserPromptSubmit', async () => {
      throw new HookHandlerTimeoutError('UserPromptSubmit', 30_000);
    });

    surfaceState.readLineQueue = [
      { text: 'slow prompt', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx({ hookRegistry: registry });
    // Must RESOLVE, not reject: before the fix the timeout propagated past the
    // catch and this await would throw, failing the test.
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // Turn dropped — runTurn not called for the timed-out prompt.
    expect(vi.mocked(runTurn)).not.toHaveBeenCalled();
    // A notice naming the timeout was written to the renderer.
    const lines = vi.mocked(ctx.replRenderer.writeLine).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('blocked by hook') && l.includes('timed out'))).toBe(true);
  });

  it('existing tests are unaffected when no hookRegistry is set on ctx', async () => {
    // No hookRegistry on ctx — dispatch path is skipped entirely.
    surfaceState.readLineQueue = [
      { text: 'normal prompt', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx(); // no hookRegistry
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
    const firstArg = vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string };
    expect(firstArg.text).toBe('normal prompt');
  });
});

// Item 2 (#565): integration coverage for the REAL terminal-state gate driven
// through the registered Stop path (runReplLoop → runInputLoop → hookRegistry
// dispatch), not the stub Stop handler the tests above use. This exercises the
// actual `createTerminalStateGate` closure — the gate whose behavior ships —
// through the loop's onTerminalState → StopContext → injectContext wiring, and
// pins the /clear-budget decision chosen in Item 1 (the process-lifetime budget
// is NOT reset by /clear).
// Item 2 (#565): terminal-state gate wiring via the REPL's wireStopHook path.
// The gate is registered with the session's hookRegistry; the session layer
// dispatches Stop → if the gate returns injectContext, it calls the REPL's
// onStopInjectContext callback → the REPL prepends it to the next turn.
// These tests simulate that session-layer dispatch by invoking the callbacks
// captured in wireStopHookState, verifying the REPL's injectContext drain.
describe('runReplLoop — terminal-state gate integration (#565)', () => {
  it('injectContext from session Stop dispatch is prepended to the next turn', async () => {
    // The session layer calls onStopInjectContext after turn 1 (simulates the
    // real gate returning TERMINAL_STATE_GATE_CORRECTION for an unbacked Done).
    surfaceState.readLineQueue = [
      { text: 'ship it', attachments: [] },
      { text: 'next turn', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    let callCount = 0;
    vi.mocked(runTurn).mockImplementation(async () => {
      callCount += 1;
      // Simulate the session's Stop dispatch returning injectContext after turn 1.
      if (callCount === 1) {
        wireStopHookState.opts?.onStopInjectContext?.(TERMINAL_STATE_GATE_CORRECTION);
      }
    });

    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(2);
    const firstText = (vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string }).text;
    const secondText = (vi.mocked(runTurn).mock.calls[1]?.[0] as { text: string }).text;
    // Turn 1 ran with the original user text.
    expect(firstText).toBe('ship it');
    // Turn 2 carries the gate's correction prepended.
    expect(secondText).toContain(TERMINAL_STATE_GATE_CORRECTION);
    expect(secondText.trimEnd().endsWith('next turn')).toBe(true);
  });

  it('no injectContext means next turn is clean (gate silent outside autonomous mode)', async () => {
    // Session does NOT call onStopInjectContext — the gate was silent.
    surfaceState.readLineQueue = [
      { text: 'ship it', attachments: [] },
      { text: 'next turn', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    // runTurn mock does NOT call onStopInjectContext — simulates gate silence.
    const ctx = makeCtx();
    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    const secondText = (vi.mocked(runTurn).mock.calls[1]?.[0] as { text: string }).text;
    expect(secondText).toBe('next turn');
    expect(secondText).not.toContain(TERMINAL_STATE_GATE_CORRECTION);
  });

  it('does NOT reset the pending injection across /clear (Item 1 decision pinned)', async () => {
    // Item 1 (#565): a pending injectContext is wiped by /clear (correct — the
    // conversation context resets). But the gate's BUDGET closure in the session
    // hookRegistry is NOT reset. This test verifies the REPL wipes the pending
    // injection on /clear (the budget decision itself is tested via the gate's
    // unit tests and turn-stream-runner tests).
    surfaceState.readLineQueue = [
      { text: 'first done', attachments: [] }, // turn 1 → session injects
      { text: '/clear', attachments: [] },      // REPL wipes pendingStopInjection
      { text: 'second done', attachments: [] }, // turn 2 → no injection (wiped by /clear)
      { text: '/exit', attachments: [] },
    ];

    vi.mocked(slashMod.dispatch).mockImplementation(async (text: string) => {
      if (text === '/exit') return { handled: true, result: 'exit' as const };
      if (text === '/clear') return { handled: true, result: null };
      return { handled: false as const };
    });

    let callCount = 0;
    vi.mocked(runTurn).mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        // After turn 1 the session injects a correction.
        wireStopHookState.opts?.onStopInjectContext?.(TERMINAL_STATE_GATE_CORRECTION);
      }
    });

    const ctx = makeCtx();
    const transcript = makeTranscript();
    await runReplLoop(ctx, transcript as never, makeTurnState(), vi.fn());

    // Two model turns ran (the /clear iteration continues without a runTurn).
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(2);
    // /clear actually hit its reset branch.
    expect(transcript.rotateOnClear).toHaveBeenCalledTimes(1);

    // Turn 2's prompt is clean — /clear wiped the pending injection.
    const secondText = (vi.mocked(runTurn).mock.calls[1]?.[0] as { text: string }).text;
    expect(secondText).toBe('second done');
    expect(secondText).not.toContain(TERMINAL_STATE_GATE_CORRECTION);
  });
});


