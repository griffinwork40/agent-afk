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
import { createHookRegistry } from '../../../agent/hooks.js';
import { HookBlockedError } from '../../../utils/errors.js';
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

describe('runReplLoop -- Stop hook fires after runTurn completes', () => {
  it('dispatches Stop event to ctx.hookRegistry after a completed turn', async () => {
    // One real text turn, then /exit.
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const registry = createHookRegistry();
    const stopHandler = vi.fn(async () => ({}));
    registry.register('Stop', stopHandler);

    const ctx = makeCtx();
    ctx.hookRegistry = registry;

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // runTurn fired once (the 'hello' turn).
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
    // Stop handler fired exactly once, after the turn.
    expect(stopHandler).toHaveBeenCalledTimes(1);
    const received = stopHandler.mock.calls[0]?.[0];
    expect(received).toMatchObject({ event: 'Stop' });
  });

  it('does not dispatch Stop when ctx.hookRegistry is absent', async () => {
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const ctx = makeCtx();
    // hookRegistry intentionally not set

    // Should not throw even with no registry.
    await expect(
      runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn()),
    ).resolves.toBeUndefined();
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
  });

  it('propagates sessionId in the Stop context', async () => {
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const registry = createHookRegistry();
    const stopHandler = vi.fn(async () => ({}));
    registry.register('Stop', stopHandler);

    const ctx = makeCtx();
    ctx.hookRegistry = registry;

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    const received = stopHandler.mock.calls[0]?.[0];
    expect(received).toMatchObject({ event: 'Stop', sessionId: 'mock' });
  });

  it('renders a blocked notice and continues when a Stop handler blocks', async () => {
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const registry = createHookRegistry();
    // A handler that returns decision: 'block' triggers HookBlockedError.
    registry.register('Stop', async () => ({ decision: 'block', reason: 'test block' }));

    const ctx = makeCtx();
    ctx.hookRegistry = registry;
    const writerFn = vi.fn();
    ctx.completionWriter = { fn: writerFn, idleFn: vi.fn() };

    // The loop should complete (not throw) -- block is non-fatal for Stop.
    await expect(
      runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn()),
    ).resolves.toBeUndefined();

    // completionWriter.fn should have been called with a blocked message.
    const writeCalls = writerFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(writeCalls.some((msg: unknown) => typeof msg === 'string' && msg.includes('blocked'))).toBe(true);
    // runTurn ran the 'hello' turn.
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
  });

  it('renders a timed-out notice and continues when a Stop handler times out', async () => {
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const registry = createHookRegistry();
    // Simulate a timed-out handler by throwing HookHandlerTimeoutError directly.
    // hook-registry.ts re-throws HookHandlerTimeoutError raw (not wrapped as
    // HookBlockedError), so throwing it from the handler replicates the real
    // timeout code path through dispatch().
    registry.register('Stop', async () => {
      throw new HookHandlerTimeoutError('Stop', 30000);
    });

    const ctx = makeCtx();
    ctx.hookRegistry = registry;
    const writerFn = vi.fn();
    ctx.completionWriter = { fn: writerFn, idleFn: vi.fn() };

    // The loop should complete (not throw) -- timeout is non-fatal for Stop.
    await expect(
      runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn()),
    ).resolves.toBeUndefined();

    // completionWriter.fn should have been called with a timed-out message.
    const writeCalls = writerFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(writeCalls.some((msg: unknown) => typeof msg === 'string' && msg.includes('timed out'))).toBe(true);
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(1);
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

    const registry = createHookRegistry();
    registry.register('Stop', async () => ({ decision: 'block', reason: maliciousReason }));

    const ctx = makeCtx();
    ctx.hookRegistry = registry;
    const writerFn = vi.fn();
    ctx.completionWriter = { fn: writerFn, idleFn: vi.fn() };

    await expect(
      runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn()),
    ).resolves.toBeUndefined();

    // The rendered string must contain 'blocked' (the user-visible notice still fires).
    const writeCalls = writerFn.mock.calls.map((c: unknown[]) => c[0] as string);
    const blockedMsg = writeCalls.find((msg) => msg.includes('blocked'));
    expect(blockedMsg).toBeDefined();

    // The raw ESC byte must have been stripped.
    expect(blockedMsg).not.toContain('\u001b');
    // The OSC payload text must not leak as visible output.
    expect(blockedMsg).not.toContain('evil-title');
    // The innocuous text content may or may not survive sanitisation depending
    // on implementation — what matters is the control-sequence removal above.
  });

  it('dispatches Stop with the explicit 5000ms per-handler timeout', async () => {
    // Perf-observability: Stop fires every REPL turn, so it uses
    // STOP_HOOK_HANDLER_TIMEOUT_MS (5s) rather than the registry default (30s).
    // Spy on dispatch (call-through) and verify the third positional arg.
    surfaceState.readLineQueue = [
      { text: 'hello', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const registry = createHookRegistry();
    const dispatchSpy = vi.spyOn(registry, 'dispatch');

    const ctx = makeCtx();
    ctx.hookRegistry = registry;

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    // Find the dispatch call whose first argument has event === 'Stop'.
    const stopCall = dispatchSpy.mock.calls.find(
      (args) => (args[0] as { event?: string }).event === 'Stop',
    );
    expect(stopCall).toBeDefined();
    // Third positional arg must be the explicit 5s timeout.
    expect(stopCall?.[2]).toBe(5000);
  });

  it('delivers a Stop handler injectContext into the NEXT turn\'s prompt', async () => {
    surfaceState.readLineQueue = [
      { text: 'first turn', attachments: [] },
      { text: 'second turn', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const registry = createHookRegistry();
    let stopCount = 0;
    // Return a correction only after the FIRST turn.
    registry.register('Stop', async () => {
      stopCount += 1;
      return stopCount === 1 ? { injectContext: 'CORRECTION: substantiate your Done' } : {};
    });

    const ctx = makeCtx();
    ctx.hookRegistry = registry;

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(2);
    const firstText = (vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string }).text;
    const secondText = (vi.mocked(runTurn).mock.calls[1]?.[0] as { text: string }).text;
    // First turn: no injection yet (Stop hasn't fired).
    expect(firstText).toBe('first turn');
    // Second turn: the correction was prepended, user text preserved at the tail.
    expect(secondText).toContain('CORRECTION: substantiate your Done');
    expect(secondText.trimEnd().endsWith('second turn')).toBe(true);
  });

  it('consumes a Stop injectContext exactly once (not re-delivered next turn)', async () => {
    surfaceState.readLineQueue = [
      { text: 'turn one', attachments: [] },
      { text: 'turn two', attachments: [] },
      { text: 'turn three', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const registry = createHookRegistry();
    let stopCount = 0;
    registry.register('Stop', async () => {
      stopCount += 1;
      return stopCount === 1 ? { injectContext: 'ONE-SHOT-CORRECTION' } : {};
    });

    const ctx = makeCtx();
    ctx.hookRegistry = registry;

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(3);
    const texts = vi.mocked(runTurn).mock.calls.map((c) => (c[0] as { text: string }).text);
    // Only the SECOND turn carries the correction; the third is clean.
    expect(texts[0]).toBe('turn one');
    expect(texts[1]).toContain('ONE-SHOT-CORRECTION');
    expect(texts[2]).toBe('turn three');
    expect(texts[2]).not.toContain('ONE-SHOT-CORRECTION');
  });

  it('ignores a whitespace-only Stop injectContext', async () => {
    surfaceState.readLineQueue = [
      { text: 'alpha', attachments: [] },
      { text: 'beta', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const registry = createHookRegistry();
    registry.register('Stop', async () => ({ injectContext: '   \n  ' }));

    const ctx = makeCtx();
    ctx.hookRegistry = registry;

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    const secondText = (vi.mocked(runTurn).mock.calls[1]?.[0] as { text: string }).text;
    expect(secondText).toBe('beta');
  });

  it('carries the parsed verdict + evidence onto StopContext (from onTerminalState)', async () => {
    surfaceState.readLineQueue = [
      { text: 'do the thing', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    // Make runTurn invoke the loop's onTerminalState callback, as the real
    // turn-handler does when it parses a Done verdict with no evidence.
    vi.mocked(runTurn).mockImplementationOnce(
      async (_input: unknown, _session: unknown, _stats: unknown, handlers: unknown) => {
        (handlers as { onTerminalState?: (s: unknown, m?: unknown) => void }).onTerminalState?.(
          { kind: 'done', rawBody: '' },
          { doneHasCorroboratingEvidence: false },
        );
      },
    );

    const registry = createHookRegistry();
    const stopHandler = vi.fn(async () => ({}));
    registry.register('Stop', stopHandler);

    const ctx = makeCtx();
    ctx.hookRegistry = registry;

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    const received = stopHandler.mock.calls[0]?.[0];
    expect(received).toMatchObject({
      event: 'Stop',
      terminalState: 'done',
      doneHasCorroboratingEvidence: false,
    });
  });

  it('omits verdict fields from StopContext when the turn parsed no terminal state', async () => {
    // runTurn does NOT call onTerminalState (verdict-less turn) → the loop must
    // not carry a stale kind onto the Stop context.
    surfaceState.readLineQueue = [
      { text: 'chatty turn', attachments: [] },
      { text: '/exit', attachments: [] },
    ];

    const registry = createHookRegistry();
    const stopHandler = vi.fn(async () => ({}));
    registry.register('Stop', stopHandler);

    const ctx = makeCtx();
    ctx.hookRegistry = registry;

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    const received = stopHandler.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(received.event).toBe('Stop');
    expect(received.terminalState).toBeUndefined();
    expect(received.doneHasCorroboratingEvidence).toBeUndefined();
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
describe('runReplLoop — terminal-state gate integration (#565)', () => {
  /**
   * Make a turn self-certify `Done` with no corroborating evidence, exactly as
   * the real turn-handler does when it parses an unbacked Done: it invokes the
   * loop's `onTerminalState` callback with a `done` verdict and
   * `doneHasCorroboratingEvidence: false`. The loop carries those onto the Stop
   * context the gate reads.
   */
  function mockUnbackedDoneTurn(): void {
    vi.mocked(runTurn).mockImplementationOnce(
      async (_input: unknown, _session: unknown, _stats: unknown, handlers: unknown) => {
        (handlers as { onTerminalState?: (s: unknown, m?: unknown) => void }).onTerminalState?.(
          { kind: 'done', rawBody: '' },
          { doneHasCorroboratingEvidence: false },
        );
      },
    );
  }

  it('the registered gate injects its correction into the next turn on an unbacked Done', async () => {
    // Turn 1 self-certifies an unbacked Done → the REAL gate fires and stashes
    // its correction; turn 2 must carry TERMINAL_STATE_GATE_CORRECTION as a
    // prepended framework note (user text preserved at the tail).
    surfaceState.readLineQueue = [
      { text: 'ship it', attachments: [] },
      { text: 'next turn', attachments: [] },
      { text: '/exit', attachments: [] },
    ];
    mockUnbackedDoneTurn();

    const registry = createHookRegistry();
    // The gate as it ships: enabled + autonomous, reading the live permission
    // mode off ctx.stats (matching bootstrap.ts's `() => stats.permissionMode`).
    const ctx = makeCtx();
    ctx.stats.permissionMode = 'autonomous';
    registry.register(
      'Stop',
      createTerminalStateGate({
        getPermissionMode: () => ctx.stats.permissionMode,
        isEnabled: () => true,
      }),
    );
    ctx.hookRegistry = registry;

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(2);
    const firstText = (vi.mocked(runTurn).mock.calls[0]?.[0] as { text: string }).text;
    const secondText = (vi.mocked(runTurn).mock.calls[1]?.[0] as { text: string }).text;
    // Turn 1 ran clean (the gate acts AFTER, on the Stop dispatch).
    expect(firstText).toBe('ship it');
    // Turn 2 carries the real gate's correction, user text preserved at the tail.
    expect(secondText).toContain(TERMINAL_STATE_GATE_CORRECTION);
    expect(secondText.trimEnd().endsWith('next turn')).toBe(true);
  });

  it('the registered gate stays silent outside autonomous mode (human watching)', async () => {
    // Same unbacked-Done shape, but the session is in 'default' mode — the gate
    // must NOT fire (it is autonomous-only), so the next turn is clean. This
    // proves the integration path honors the mode gate, not just the unit test.
    surfaceState.readLineQueue = [
      { text: 'ship it', attachments: [] },
      { text: 'next turn', attachments: [] },
      { text: '/exit', attachments: [] },
    ];
    mockUnbackedDoneTurn();

    const registry = createHookRegistry();
    const ctx = makeCtx();
    ctx.stats.permissionMode = 'default';
    registry.register(
      'Stop',
      createTerminalStateGate({
        getPermissionMode: () => ctx.stats.permissionMode,
        isEnabled: () => true,
      }),
    );
    ctx.hookRegistry = registry;

    await runReplLoop(ctx, makeTranscript() as never, makeTurnState(), vi.fn());

    const secondText = (vi.mocked(runTurn).mock.calls[1]?.[0] as { text: string }).text;
    expect(secondText).toBe('next turn');
    expect(secondText).not.toContain(TERMINAL_STATE_GATE_CORRECTION);
  });

  it('does NOT reset the gate injection budget across /clear (Item 1 decision pinned)', async () => {
    // Item 1 (#565): the gate's injection budget is PROCESS-LIFETIME scoped and
    // deliberately NOT reset by /clear. Pin that here through the real loop:
    //
    //   Turn 1 (unbacked Done) → gate returns injectContext, budget spent (cap=1).
    //   /clear                 → rotates transcript, resets the conversation-
    //                            scoped verdictLedger + pendingStopInjection,
    //                            but must NOT refund the gate's budget closure.
    //   Turn 2 (unbacked Done) → SAME gate instance, over budget → returns {}.
    //
    // We assert on the GATE'S RETURN VALUE per Stop dispatch (via a spy wrapping
    // the real gate), NOT on the delivered prompt: /clear intentionally wipes
    // `pendingStopInjection`, so turn 1's injection never reaches turn 2's prompt
    // regardless of the budget — the prompt cannot isolate the budget decision.
    // The gate's own return value can. If /clear reset the budget (deferred
    // option (b)), turn 2's gate call would return injectContext again and the
    // `secondCorrection` assertion below would fail — so this is a true guard.
    surfaceState.readLineQueue = [
      { text: 'first done', attachments: [] }, // turn 1 → gate injects
      { text: '/clear', attachments: [] }, // reset conversation state, not budget
      { text: 'second done', attachments: [] }, // turn 2 → over budget, gate silent
      { text: '/exit', attachments: [] },
    ];
    // Both real turns self-certify an unbacked Done.
    mockUnbackedDoneTurn();
    mockUnbackedDoneTurn();

    // /clear must reach the reset branch: dispatch returns handled + a non-submit
    // result so the loop rotates the transcript and continues (see loop-iteration
    // ~L386). '/exit' ends the loop; everything else falls through to the model.
    vi.mocked(slashMod.dispatch).mockImplementation(async (text: string) => {
      if (text === '/exit') return { handled: true, result: 'exit' as const };
      if (text === '/clear') return { handled: true, result: null };
      return { handled: false as const };
    });

    const ctx = makeCtx();
    ctx.stats.permissionMode = 'autonomous';
    // The real gate, cap=1. Wrap it in a spy so we can read what it RETURNS on
    // each Stop dispatch — the direct observable for the budget decision.
    const realGate = createTerminalStateGate({
      getPermissionMode: () => ctx.stats.permissionMode,
      isEnabled: () => true,
      maxInjectionsPerSession: 1, // single-slot budget: exhausted by turn 1
    });
    const gateReturns: Array<string | undefined> = [];
    const registry = createHookRegistry();
    registry.register('Stop', async (hookCtx) => {
      const decision = await realGate(hookCtx);
      // Record the gate's verdict only for the Stop dispatches that carry an
      // unbacked Done (the ones the gate acts on) — i.e. every turn here.
      if ((hookCtx as { terminalState?: string }).terminalState === 'done') {
        gateReturns.push(decision.injectContext);
      }
      return decision;
    });
    ctx.hookRegistry = registry;

    const transcript = makeTranscript();
    await runReplLoop(ctx, transcript as never, makeTurnState(), vi.fn());

    // Two model turns ran (the /clear iteration continues without a runTurn).
    expect(vi.mocked(runTurn)).toHaveBeenCalledTimes(2);
    // Sanity: /clear actually hit its reset branch (transcript rotated).
    expect(transcript.rotateOnClear).toHaveBeenCalledTimes(1);
    // Sanity: the gate was consulted for exactly the two unbacked-Done turns.
    expect(gateReturns).toHaveLength(2);

    // Turn 1's Stop: the gate spent its single-slot budget and returned the
    // correction.
    expect(gateReturns[0]).toBe(TERMINAL_STATE_GATE_CORRECTION);
    // Turn 2's Stop, AFTER /clear: the SAME gate instance was over budget and
    // returned no correction — the budget was NOT refunded by /clear. This is
    // the crux of the Item 1 decision (a budget reset would make this the
    // correction string again).
    expect(gateReturns[1]).toBeUndefined();

    // Secondary: turn 2's delivered prompt is clean (belt-and-suspenders — true
    // here both because the budget is spent AND because /clear wiped any pending
    // injection; the gate-return assertions above are what isolate the budget).
    const secondText = (vi.mocked(runTurn).mock.calls[1]?.[0] as { text: string }).text;
    expect(secondText).toBe('second done');
    expect(secondText).not.toContain(TERMINAL_STATE_GATE_CORRECTION);
  });
});
