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
