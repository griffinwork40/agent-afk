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
  readLineQueue: [] as Array<{ text: string; attachments: unknown[] }>,
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
      return surfaceState.readLineQueue.shift() ?? { text: '/exit', attachments: [] };
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

function makeCtx(): InteractiveCtx {
  return {
    session: {
      current: {
        sessionId: 'mock',
        waitForInitialization: vi.fn(async () => ({})),
        takePendingPlanExitSeed: vi.fn(() => undefined),
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
