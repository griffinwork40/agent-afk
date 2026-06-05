/**
 * C-1 regression test — setTasksRegistry wired in REPL bootstrap.
 *
 * Before this fix, `repl-loop.ts` called `setTasksManager()` and
 * `setAttachManager()` during bootstrap but never called `setTasksRegistry()`.
 * Subagent job rows in `/tasks` were therefore always empty in a live REPL —
 * they only appeared in tests that called `setTasksRegistry` directly.
 *
 * This test exercises the real `runReplLoop` bootstrap path with enough
 * mocking to let the function reach the wiring block, then asserts that
 * `setTasksRegistry` was called with the same `BackgroundAgentRegistry`
 * instance that lives in `ctx.backgroundRegistry`.
 *
 * It would have caught C-1: under the broken code, `setTasksRegistry` is not
 * imported by repl-loop.ts → the spy is never called → the assertion fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../input-box.js', () => ({
  readWithAutocomplete: vi.fn(),
}));
vi.mock('../../input/history.js', () => ({
  loadHistory: vi.fn(async () => ({
    push: vi.fn(),
    cursor: 0,
    entries: [],
  })),
}));
vi.mock('./turn-handler.js', () => ({
  runTurn: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../slash/registry.js', () => ({
  dispatch: vi.fn(async () => ({ handled: true, result: 'exit' as const })),
  parse: vi.fn(() => null),
}));
vi.mock('../../slash/plugin-skills.js', () => ({
  autoRegisterPluginPassthroughs: vi.fn(async () => {}),
  getPluginShadowingNoticeLines: vi.fn(() => []),
}));
vi.mock('./background.js', async () => {
  const { EventEmitter } = await import('node:events');
  // runReplLoop's finally block drains bgManager.running() with .cancel(id)
  // (Phase 1.5 zombie-state hardening). The fake needs both methods so the
  // teardown path doesn't throw in wiring tests that don't exercise tasks.
  class FakeBackgroundTaskManager extends EventEmitter {
    running(): unknown[] { return []; }
    cancel(_id: string): void {}
  }
  return { BackgroundTaskManager: FakeBackgroundTaskManager };
});
vi.mock('../../background-status-bar.js', () => ({
  BackgroundStatusBar: class {
    setRowCountChangeHandler() {}
    start() {}
    stop() {}
  },
}));
vi.mock('./context-pane.js', () => ({
  createContextPane: vi.fn(() => ({
    renderIfChanged: () => [],
    dispose: () => {},
  })),
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
vi.mock('../../slash/commands/bg.js', () => ({ setBgManager: vi.fn() }));
// C-1 subject: use vi.fn() inside the factory so hoisting works.
// We retrieve the spy via the module import below.
vi.mock('../../slash/commands/tasks.js', () => ({
  setTasksManager: vi.fn(),
  setTasksRegistry: vi.fn(),
}));
vi.mock('../../slash/commands/attach.js', () => ({ setAttachManager: vi.fn() }));
vi.mock('../../debug-banner.js', () => ({ renderDebugBanner: () => '' }));
vi.mock('../../../utils/debug.js', () => ({ isDebugEnabled: () => false }));
vi.mock('../../plan-mode-toggle.js', () => ({
  togglePlanMode: vi.fn(async () => {}),
  flushPendingPlanExit: vi.fn(async () => {}),
}));

// Fake TerminalCompositor for the completionWriter idle-wiring test.
// `commitAbove` is a vi.fn so the test can assert routing.
//
// vi.hoisted so the factory inside vi.mock() can reference it (vi.mock
// is hoisted above import statements, so closures must be hoisted too).
const fakeCompositorState = vi.hoisted(() => ({
  commitAbove: undefined as ((line: string) => void) | undefined,
  // Capture the armCompositor opts so wiring tests can inspect the suggest
  // config (e.g. the llmEnabled boolean-parse closure) without a real TTY.
  lastArmOpts: undefined as unknown,
}));

vi.mock('../../input/input-surface.js', () => {
  class FakeInputSurface {
    private compositor: { commitAbove: (line: string) => void } | null = null;
    constructor(_opts: unknown) {}
    async armCompositor(opts: unknown): Promise<void> {
      fakeCompositorState.lastArmOpts = opts;
      this.compositor = {
        commitAbove: (line: string) => {
          fakeCompositorState.commitAbove?.(line);
        },
      };
    }
    getCompositor(): { commitAbove: (line: string) => void } | null {
      return this.compositor;
    }
    setSoftStopHandler(_handler: (() => void) | null): void {}
    async readLine(_opts: unknown): Promise<{ text: string; attachments: unknown[] }> {
      return { text: '/exit', attachments: [] };
    }
    async dispose(): Promise<void> { this.compositor = null; }
  }
  return { InputSurface: FakeInputSurface };
});

import { runReplLoop, type TurnState } from './repl-loop.js';
import type { InteractiveCtx } from './shared.js';
import { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
// Import the mocked module so we can inspect the spy.
import * as tasksMod from '../../slash/commands/tasks.js';
import { readWithAutocomplete } from '../../input-box.js';

const readMock = readWithAutocomplete as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(tasksMod.setTasksRegistry).mockClear();
  fakeCompositorState.lastArmOpts = undefined;
  // Default: return '/exit' text so the slash dispatch mock's 'exit' result
  // triggers `ctx.rl.close(); return` in the first loop iteration.
  readMock.mockResolvedValue({ text: '/exit', attachments: [] });
});

function makeMinimalCtx(backgroundRegistry: BackgroundAgentRegistry): InteractiveCtx {
  return {
    session: {
      current: {
        sessionId: 'mock',
        waitForInitialization: vi.fn(async () => ({})),
      },
    },
    memoryStore: {} as never,
    stats: {
      totalTurns: 0,
      totalCostUsd: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      sessionStartTime: Date.now(),
      turnCosts: [],
      turnTokens: [],
      turns: [],
      model: 'sonnet',
      planMode: false,
      sessionId: 'mock',
    },
    statusLine: {
      rearm: vi.fn(),
      setExtraRows: vi.fn(),
      getExtraRows: vi.fn(() => 0),
      setAfterScrollRestore: vi.fn(),
    },
    contextSampler: { onTurn: vi.fn(async () => {}), getRatio: () => undefined },
    completionWriter: { fn: () => {}, idleFn: () => {} },
    replRenderer: { writeLine: vi.fn(), setCompositor: vi.fn() },
    slashCtx: { stats: { planMode: false, pendingPlanExit: false } },
    rl: { close: vi.fn() },
    options: { thinkingUi: undefined },
    backgroundRegistry,
  } as unknown as InteractiveCtx;
}

function makeTranscript() {
  return {
    path: () => '/tmp/mock',
    appendTurn: vi.fn(async () => {}),
    rotateOnClear: vi.fn(async () => {}),
    appendEnded: vi.fn(async () => {}),
  };
}

describe('runReplLoop — C-1 regression: setTasksRegistry wired in bootstrap', () => {
  it('calls setTasksRegistry with ctx.backgroundRegistry during REPL bootstrap', async () => {
    const backgroundRegistry = new BackgroundAgentRegistry({});
    const ctx = makeMinimalCtx(backgroundRegistry);

    const turnState: TurnState = {
      turnInFlight: false,
      lastSigintAt: 0,
      activeCompositor: null,
    } as TurnState;

    // The slash dispatch mock returns 'exit' immediately so the loop exits
    // before any readWithAutocomplete call. The bootstrap wiring block runs
    // unconditionally before the while(true) loop begins.
    await runReplLoop(ctx, makeTranscript() as never, turnState, vi.fn());

    // C-1 assertion: setTasksRegistry MUST have been called with the exact
    // registry instance from ctx.backgroundRegistry.
    // Under the broken code (setTasksRegistry not imported), this spy is
    // never called → expect fails → regression would have been caught.
    expect(vi.mocked(tasksMod.setTasksRegistry)).toHaveBeenCalledOnce();
    expect(vi.mocked(tasksMod.setTasksRegistry)).toHaveBeenCalledWith(backgroundRegistry);
  });

  it('the registry wired into setTasksRegistry contains pre-registered jobs', async () => {
    // Verify that the registry passed to setTasksRegistry is the live
    // instance — if a job is registered before the REPL starts, it remains
    // observable via the wired registry after bootstrap.
    const backgroundRegistry = new BackgroundAgentRegistry({});

    const stubHandle = {
      id: 'sub-c1',
      status: 'idle',
      runInBackground: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
      runToResult: vi.fn(),
    };
    const job = backgroundRegistry.register({
      handle: stubHandle as never,
      prompt: 'investigate the stash',
      model: 'sonnet',
    });

    const ctx = makeMinimalCtx(backgroundRegistry);

    const turnState: TurnState = {
      turnInFlight: false,
      lastSigintAt: 0,
      activeCompositor: null,
    } as TurnState;

    await runReplLoop(ctx, makeTranscript() as never, turnState, vi.fn());

    // The registry wired by the REPL bootstrap must be the exact same instance
    // that holds the pre-registered job.
    const wiredRegistry = vi.mocked(tasksMod.setTasksRegistry).mock.calls[0]?.[0] as BackgroundAgentRegistry;
    expect(wiredRegistry).toBe(backgroundRegistry);
    expect(wiredRegistry.get(job.jobId)?.label).toBe('investigate the stash');
  });
});

/**
 * Regression test — between-turn completionWriter idle wiring.
 *
 * Repro: in v3.45.3, typing `/model claude-opus-4-8` between turns produced
 * the warning ("⚠ Unknown model: claude-opus-4-8") rendered INLINE on the
 * same terminal row as the echoed input — the warning text overlaid the
 * tail of `/model claude-opus-4-` at column ~60. Root cause: turn-handler's
 * finally block hardcoded `completionWriter.fn = console.log` after every
 * turn, even though the persistent (borrowed) compositor was still armed.
 * The next between-turn slash warn() then wrote raw at the input row's
 * cursor position instead of committing above the live overlay.
 *
 * Fix: turn-handler's finally now resets `fn := idleFn` (NOT console.log).
 * `idleFn` is set once at REPL bootstrap (immediately after armCompositor)
 * to route through `compositor.commitAbove` when a persistent compositor
 * is available; it stays `console.log` for non-TTY/legacy paths.
 *
 * This test asserts the bootstrap wiring point: after `runReplLoop` runs
 * past `armCompositor` and the immediately-following completionWriter
 * wiring, both `fn` and `idleFn` route through the persistent compositor's
 * `commitAbove`. We observe this from inside the slash dispatch mock,
 * which fires within the loop body BEFORE the REPL exit teardown resets
 * the slots back to `console.log`.
 */
describe('runReplLoop — completionWriter wired to persistent compositor.commitAbove', () => {
  it('between turns, completionWriter.fn and idleFn route through compositor.commitAbove', async () => {
    const commitAboveSpy = vi.fn();
    fakeCompositorState.commitAbove = commitAboveSpy;

    const backgroundRegistry = new BackgroundAgentRegistry({});
    const ctx = makeMinimalCtx(backgroundRegistry);

    // Replace dispatch mock with one that captures completionWriter state
    // at the moment a between-turn slash command fires (i.e. after
    // armCompositor + wiring, before surface.dispose).
    const slashMod = await import('../../slash/registry.js');
    const capturedAtSlashTime = {
      fnIsConsoleLog: null as boolean | null,
      idleFnIsConsoleLog: null as boolean | null,
      fnRoutesToCommitAbove: false,
      idleFnRoutesToCommitAbove: false,
    };
    vi.mocked(slashMod.dispatch).mockImplementationOnce(async () => {
      capturedAtSlashTime.fnIsConsoleLog = ctx.completionWriter.fn === console.log;
      capturedAtSlashTime.idleFnIsConsoleLog = ctx.completionWriter.idleFn === console.log;
      // Behavioral assertion: calling each slot must reach the fake
      // compositor's commitAbove spy.
      const before = commitAboveSpy.mock.calls.length;
      ctx.completionWriter.fn('fn-probe');
      ctx.completionWriter.idleFn('idleFn-probe');
      const after = commitAboveSpy.mock.calls.length;
      capturedAtSlashTime.fnRoutesToCommitAbove = after - before >= 1;
      capturedAtSlashTime.idleFnRoutesToCommitAbove = after - before >= 2;
      return { handled: true, result: 'exit' as const };
    });

    // The mocked parse() in the top-level vi.mock returns null, so the slash
    // dispatch is bypassed in the default test setup. Override parse to
    // return a fake command for this test so dispatch is invoked.
    vi.mocked(slashMod.parse).mockReturnValueOnce({ command: 'exit', args: '' } as never);

    // Slash dispatch only runs if readWithAutocomplete returns text. The
    // default mock already returns '/exit', so the loop dispatches once.
    const turnState: TurnState = {
      turnInFlight: false,
      lastSigintAt: 0,
      activeCompositor: null,
    } as TurnState;

    await runReplLoop(ctx, makeTranscript() as never, turnState, vi.fn());

    // Both slots must have been wired to compositor.commitAbove BEFORE the
    // slash dispatch fired.
    expect(capturedAtSlashTime.fnIsConsoleLog).toBe(false);
    expect(capturedAtSlashTime.idleFnIsConsoleLog).toBe(false);
    expect(capturedAtSlashTime.fnRoutesToCommitAbove).toBe(true);
    expect(capturedAtSlashTime.idleFnRoutesToCommitAbove).toBe(true);
    expect(commitAboveSpy).toHaveBeenCalledWith('fn-probe');
    expect(commitAboveSpy).toHaveBeenCalledWith('idleFn-probe');
  });

  it('after REPL exit, completionWriter slots are reset to console.log (post-dispose safety)', async () => {
    const commitAboveSpy = vi.fn();
    fakeCompositorState.commitAbove = commitAboveSpy;

    const backgroundRegistry = new BackgroundAgentRegistry({});
    const ctx = makeMinimalCtx(backgroundRegistry);

    const turnState: TurnState = {
      turnInFlight: false,
      lastSigintAt: 0,
      activeCompositor: null,
    } as TurnState;

    await runReplLoop(ctx, makeTranscript() as never, turnState, vi.fn());

    // Post-dispose: both slots must NOT route through commitAbove. A late
    // write through completionWriter would otherwise target the disposed
    // compositor. We verify behaviorally — calling each slot must NOT
    // increment the commitAbove spy.
    const baseline = commitAboveSpy.mock.calls.length;
    // Silence stdout for this probe — the reset writer is console.log.
    const origLog = console.log;
    console.log = () => {};
    try {
      ctx.completionWriter.fn('post-dispose-fn');
      ctx.completionWriter.idleFn('post-dispose-idle');
    } finally {
      console.log = origLog;
    }
    expect(commitAboveSpy.mock.calls.length).toBe(baseline);
  });
});

/**
 * P2 regression — AFK_SUGGEST_ENABLED is parsed as a boolean, not raw
 * truthiness.
 *
 * Repro (Codex review on PR #606): the suggest engine's `llmEnabled()` gate
 * was `!!env.AFK_SUGGEST_ENABLED`, so any non-empty string — including the
 * documented falsy values `0` and `false` — enabled the Tier-2 LLM. A user
 * explicitly setting `AFK_SUGGEST_ENABLED=0` would still see interactive
 * typing fire provider calls. The env registry documents only `1/true/yes/on`
 * as activations.
 *
 * This drives the real `runReplLoop` bootstrap to capture the `suggest`
 * wiring handed to `armCompositor`, then evaluates the live `llmEnabled()`
 * closure across env values. Under the broken `!!` code, the `0`/`false`
 * cases would return `true` → assertions fail.
 */
describe('runReplLoop — P2 regression: AFK_SUGGEST_ENABLED parsed as boolean', () => {
  async function captureLlmEnabled(value: string | undefined): Promise<boolean> {
    const prev = process.env.AFK_SUGGEST_ENABLED;
    if (value === undefined) delete process.env.AFK_SUGGEST_ENABLED;
    else process.env.AFK_SUGGEST_ENABLED = value;
    try {
      const ctx = makeMinimalCtx(new BackgroundAgentRegistry({}));
      const turnState: TurnState = {
        turnInFlight: false,
        lastSigintAt: 0,
        activeCompositor: null,
      } as TurnState;
      await runReplLoop(ctx, makeTranscript() as never, turnState, vi.fn());

      const armOpts = fakeCompositorState.lastArmOpts as {
        suggest?: { getContext: () => { llmEnabled: () => boolean } };
      };
      // The suggest block must always be wired — Tier-1 runs even when the
      // LLM tier is off, so getContext()/llmEnabled() are present regardless.
      expect(armOpts?.suggest).toBeDefined();
      return armOpts.suggest!.getContext().llmEnabled();
    } finally {
      if (prev === undefined) delete process.env.AFK_SUGGEST_ENABLED;
      else process.env.AFK_SUGGEST_ENABLED = prev;
    }
  }

  it('enables the LLM tier for each documented truthy value (1/true/yes/on)', async () => {
    expect(await captureLlmEnabled('1')).toBe(true);
    expect(await captureLlmEnabled('true')).toBe(true);
    expect(await captureLlmEnabled('yes')).toBe(true);
    expect(await captureLlmEnabled('on')).toBe(true);
    // Case-insensitive per the /i flag.
    expect(await captureLlmEnabled('TRUE')).toBe(true);
    expect(await captureLlmEnabled('On')).toBe(true);
  });

  it('keeps the LLM tier OFF for falsy values (0/false) and unset', async () => {
    // The bug: these returned `true` under `!!env.AFK_SUGGEST_ENABLED`.
    expect(await captureLlmEnabled('0')).toBe(false);
    expect(await captureLlmEnabled('false')).toBe(false);
    expect(await captureLlmEnabled('no')).toBe(false);
    expect(await captureLlmEnabled('off')).toBe(false);
    expect(await captureLlmEnabled('')).toBe(false);
    expect(await captureLlmEnabled(undefined)).toBe(false);
    // A non-empty non-keyword string is not an activation.
    expect(await captureLlmEnabled('maybe')).toBe(false);
  });
});

describe('runReplLoop — AFK_SUGGEST_GHOST: ghost-text master toggle', () => {
  async function captureArmOpts(ghostEnv: string | undefined): Promise<{
    suggest?: { getContext: () => { llmEnabled: () => boolean } };
  }> {
    const prevGhost = process.env.AFK_SUGGEST_GHOST;
    const prevEnabled = process.env.AFK_SUGGEST_ENABLED;
    if (ghostEnv === undefined) delete process.env.AFK_SUGGEST_GHOST;
    else process.env.AFK_SUGGEST_GHOST = ghostEnv;
    try {
      const ctx = makeMinimalCtx(new BackgroundAgentRegistry({}));
      const turnState: TurnState = {
        turnInFlight: false,
        lastSigintAt: 0,
        activeCompositor: null,
      } as TurnState;
      await runReplLoop(ctx, makeTranscript() as never, turnState, vi.fn());
      return fakeCompositorState.lastArmOpts as {
        suggest?: { getContext: () => { llmEnabled: () => boolean } };
      };
    } finally {
      if (prevGhost === undefined) delete process.env.AFK_SUGGEST_GHOST;
      else process.env.AFK_SUGGEST_GHOST = prevGhost;
      if (prevEnabled === undefined) delete process.env.AFK_SUGGEST_ENABLED;
      else process.env.AFK_SUGGEST_ENABLED = prevEnabled;
    }
  }

  it('disables ghost text for denylist values (0/false/no/off, case-insensitive)', async () => {
    for (const val of ['0', 'false', 'no', 'off', 'FALSE', 'Off', 'NO']) {
      const armOpts = await captureArmOpts(val);
      expect(armOpts.suggest, `expected suggest undefined for AFK_SUGGEST_GHOST=${val}`).toBeUndefined();
    }
  });

  it('keeps ghost text active for truthy/unset values (1/true/on/yes/undefined)', async () => {
    for (const val of ['1', 'true', 'on', 'yes', undefined, 'anything-else']) {
      const armOpts = await captureArmOpts(val);
      expect(armOpts.suggest, `expected suggest defined for AFK_SUGGEST_GHOST=${val}`).toBeDefined();
    }
  });

  it('does not disturb the P2 llmEnabled closure when ghost is active', async () => {
    process.env.AFK_SUGGEST_ENABLED = '1';
    const armOpts = await captureArmOpts('1');
    expect(armOpts.suggest).toBeDefined();
    expect(armOpts.suggest!.getContext().llmEnabled()).toBe(true);

    process.env.AFK_SUGGEST_ENABLED = '0';
    const armOpts2 = await captureArmOpts('1');
    expect(armOpts2.suggest).toBeDefined();
    expect(armOpts2.suggest!.getContext().llmEnabled()).toBe(false);
  });
});
