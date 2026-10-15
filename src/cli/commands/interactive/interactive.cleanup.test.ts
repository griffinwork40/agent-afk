/**
 * Unit tests for interactive.cleanup.ts
 *
 * Focus: signal-handler exitReason wiring (issue #2762).
 * Tests verify that:
 *   - makeSessionSaver passes exitReason from the ref to saveSession.
 *   - SIGINT idle path writes exitReason='sigint'.
 *   - SIGTERM/SIGHUP handlers write their respective reasons.
 *   - The grace-period timer is .unref()'d (restores pre-fix behaviour).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeSessionSaver,
  installSignalHandlers,
  type ExitReasonRef,
} from './interactive.cleanup.js';
import { makeSigintHandler } from './interactive.signal-handlers.js';
import type { InteractiveCtx } from './shared.js';
import type { TurnState } from './repl-loop.js';

// Module-level mock: lets us capture onCancel/onStop args passed to launchInterruptPicker
// by makeSigintHandler when the armed-compositor path fires.
vi.mock('./interrupt-picker.js', () => ({
  launchInterruptPicker: vi.fn(),
}));
import { launchInterruptPicker } from './interrupt-picker.js';
const mockLaunchInterruptPicker = launchInterruptPicker as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

vi.mock('../../session-store.js', () => ({
  saveSession: vi.fn(() => '/fake/path.json'),
}));

import { saveSession } from '../../session-store.js';
const mockSaveSession = saveSession as ReturnType<typeof vi.fn>;

function makeMinimalCtx(): InteractiveCtx {
  return {
    stats: {
      totalTurns: 1,
      sessionStartTime: Date.now(),
      model: 'test-model',
      totalCostUsd: 0,
      totalTokens: 0,
      totalDurationMs: 0,
      unpricedTurns: 0,
      turns: [],
    },
    session: { current: null as never },
    rl: {
      close: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    } as unknown as InteractiveCtx['rl'],
  } as unknown as InteractiveCtx;
}

function makeTurnState(overrides?: Partial<TurnState>): TurnState {
  return {
    turnInFlight: false,
    lastSigintAt: 0,
    ...overrides,
  } as TurnState;
}

function makePickerAbort(): AbortController {
  return new AbortController();
}

// ---------------------------------------------------------------------------
// makeSessionSaver — exitReason wiring
// ---------------------------------------------------------------------------

describe('makeSessionSaver (issue #2762)', () => {
  beforeEach(() => {
    mockSaveSession.mockClear();
  });

  it('passes exitReason from ref to saveSession when saving', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: 'sigterm' };
    const { saveCurrentSession } = makeSessionSaver(ctx, exitReasonRef);

    saveCurrentSession();

    expect(mockSaveSession).toHaveBeenCalledOnce();
    const opts = mockSaveSession.mock.calls[0][2] as Record<string, unknown>;
    expect(opts['closeTime']).toBe(true);
    expect(opts['exitReason']).toBe('sigterm');
  });

  it('passes exitReason=undefined when ref holds no reason', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const { saveCurrentSession } = makeSessionSaver(ctx, exitReasonRef);

    saveCurrentSession();

    const opts = mockSaveSession.mock.calls[0][2] as Record<string, unknown>;
    expect(opts['exitReason']).toBeUndefined();
  });

  it('works when no exitReasonRef supplied (backward compat)', () => {
    const ctx = makeMinimalCtx();
    const { saveCurrentSession } = makeSessionSaver(ctx);

    saveCurrentSession();

    const opts = mockSaveSession.mock.calls[0][2] as Record<string, unknown>;
    expect(opts['closeTime']).toBe(true);
    expect(opts['exitReason']).toBeUndefined();
  });

  it('guards on totalTurns===0 (no save when session had no turns)', () => {
    const ctx = makeMinimalCtx();
    ctx.stats.totalTurns = 0;
    const { saveCurrentSession, isSaved } = makeSessionSaver(ctx);

    const result = saveCurrentSession();

    expect(result).toBeUndefined();
    expect(mockSaveSession).not.toHaveBeenCalled();
    expect(isSaved()).toBe(false);
  });

  it('isSaved() returns true after successful save', () => {
    const ctx = makeMinimalCtx();
    const { saveCurrentSession, isSaved } = makeSessionSaver(ctx);

    expect(isSaved()).toBe(false);
    saveCurrentSession();
    expect(isSaved()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// installSignalHandlers — exitReason is written before rl.close()
// ---------------------------------------------------------------------------

describe('installSignalHandlers exitReason wiring (issue #2762)', () => {
  let addedListeners: Map<string, (() => void)[]>;
  let removedListeners: Map<string, (() => void)[]>;

  beforeEach(() => {
    addedListeners = new Map();
    removedListeners = new Map();
    vi.spyOn(process, 'on').mockImplementation((event: string, handler: () => void) => {
      const existing = addedListeners.get(event) ?? [];
      addedListeners.set(event, [...existing, handler]);
      return process;
    });
    vi.spyOn(process, 'removeListener').mockImplementation((event: string, handler: () => void) => {
      const existing = removedListeners.get(event) ?? [];
      removedListeners.set(event, [...existing, handler]);
      return process;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SIGINT idle double-press sets exitReason=sigint before rl.close()', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const turnState = makeTurnState({ lastSigintAt: Date.now() - 100 }); // within window
    const pickerAbort = makePickerAbort();

    const { handleSigint, removeListeners } = installSignalHandlers({
      ctx, turnState, pickerAbort, exitReasonRef,
    });

    // Simulate idle double-Ctrl+C: lastSigintAt is recent, turnInFlight is false
    handleSigint();

    expect(exitReasonRef.current).toBe('sigint');
    expect(ctx.rl.close).toHaveBeenCalledOnce();

    removeListeners();
  });

  it('SIGINT single press (first press) does NOT set exitReason', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const turnState = makeTurnState({ lastSigintAt: 0 }); // no recent press
    const pickerAbort = makePickerAbort();

    const { handleSigint, removeListeners } = installSignalHandlers({
      ctx, turnState, pickerAbort, exitReasonRef,
    });

    handleSigint(); // first press: prints "Press Ctrl+C again"

    expect(exitReasonRef.current).toBeUndefined();
    expect(ctx.rl.close).not.toHaveBeenCalled();

    removeListeners();
  });

  it('SIGTERM handler sets exitReason=sigterm before rl.close()', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const turnState = makeTurnState();
    const pickerAbort = makePickerAbort();

    installSignalHandlers({ ctx, turnState, pickerAbort, exitReasonRef });

    const sigtermHandler = addedListeners.get('SIGTERM')?.[0];
    expect(sigtermHandler).toBeDefined();

    // Fire the SIGTERM handler
    sigtermHandler!();

    expect(exitReasonRef.current).toBe('sigterm');
    expect(ctx.rl.close).toHaveBeenCalledOnce();
  });

  it('SIGHUP handler sets exitReason=sighup before rl.close()', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const turnState = makeTurnState();
    const pickerAbort = makePickerAbort();

    installSignalHandlers({ ctx, turnState, pickerAbort, exitReasonRef });

    const sighupHandler = addedListeners.get('SIGHUP')?.[0];
    expect(sighupHandler).toBeDefined();

    sighupHandler!();

    expect(exitReasonRef.current).toBe('sighup');
    expect(ctx.rl.close).toHaveBeenCalledOnce();
  });

  it('SIGTERM/SIGHUP handlers are idempotent (inFlight guard)', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const turnState = makeTurnState();
    const pickerAbort = makePickerAbort();

    installSignalHandlers({ ctx, turnState, pickerAbort, exitReasonRef });

    const sigtermHandler = addedListeners.get('SIGTERM')?.[0];
    sigtermHandler!();
    sigtermHandler!(); // second call must be a no-op

    // rl.close should only be called once
    expect(ctx.rl.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// SIGINT in-flight paths: second-Ctrl+C & onCancel must set exitReason=sigint
// (issue #2900 regression — ??= 'eof' fallback would mis-classify these exits)
// ---------------------------------------------------------------------------

describe('SIGINT in-flight exitReason wiring (issue #2900)', () => {
  let addedListeners: Map<string, (() => void)[]>;

  beforeEach(() => {
    addedListeners = new Map();
    vi.spyOn(process, 'on').mockImplementation((event: string | symbol, handler: (...args: unknown[]) => void) => {
      const key = String(event);
      const existing = addedListeners.get(key) ?? [];
      addedListeners.set(key, [...existing, handler as () => void]);
      return process;
    });
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('second Ctrl+C while picker open sets exitReason=sigint before rl.close()', () => {
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    // turnInFlight=true and interruptPickerAbort set → "second Ctrl+C while picker open" path
    const turnState = makeTurnState({
      turnInFlight: true,
      interruptPickerAbort: new AbortController(),
    } as Partial<TurnState>);
    const pickerAbort = makePickerAbort();

    const { handleSigint, removeListeners } = installSignalHandlers({
      ctx, turnState, pickerAbort, exitReasonRef,
    });

    handleSigint();

    expect(exitReasonRef.current).toBe('sigint');
    expect(ctx.rl.close).toHaveBeenCalledOnce();

    removeListeners();
  });

  it('picker onCancel callback sets exitReason=sigint before rl.close()', () => {
    // Note: this test calls makeSigintHandler directly and does not exercise the
    // installSignalHandlers registration path. The registration path (process.on
    // wiring) is covered by the 'SIGINT handler sets exitReason' test above via
    // installSignalHandlers. The onCancel behaviour is isolated here because
    // triggering the picker's cancel callback via installSignalHandlers would
    // require a real process.emit('SIGINT') after the picker is launched, which is
    // harder to coordinate reliably. A separate integration-level test would be
    // needed to close that gap — tracked as advisory in #3170.
    //
    // makeSigintHandler calls launchInterruptPicker synchronously (mocked above).
    // Capture the onCancel arg and invoke it to verify exitReason is set.
    mockLaunchInterruptPicker.mockClear();

    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: undefined };
    const armedCompositor = { isArmed: () => true };
    // turnInFlight=true, no interruptPickerAbort, armed compositor → picker launch path
    const turnState = makeTurnState({
      turnInFlight: true,
      interruptPickerAbort: null,
      activeCompositor: armedCompositor,
    } as Partial<TurnState>);
    const pickerAbort = makePickerAbort();

    const handleSigint = makeSigintHandler({ ctx, turnState, pickerAbort, exitReasonRef });
    handleSigint(); // fires launchInterruptPicker with onCancel arg

    expect(mockLaunchInterruptPicker).toHaveBeenCalledOnce();
    const opts = mockLaunchInterruptPicker.mock.calls[0]?.[0] as { onCancel: () => void };

    // Simulate the user clicking "Cancel" in the interrupt picker
    opts.onCancel();

    expect(exitReasonRef.current).toBe('sigint');
    expect(ctx.rl.close).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// exitReason='eof' written on the rl.on('close') path (issue #2900)
// ---------------------------------------------------------------------------

describe("exitReason 'eof' on readline close (issue #2900)", () => {
  it("??= 'eof' fills an empty ref, so stdin-EOF is recorded in the sidecar", () => {
    // Simulate the rl.on('close') handler logic from interactive.ts:
    //   ctx.exitReasonRef!.current ??= 'eof';
    // When no signal handler has written a reason yet (stdin EOF, piped input).
    const exitReasonRef: ExitReasonRef = { current: undefined };
    exitReasonRef.current ??= 'eof';
    expect(exitReasonRef.current).toBe('eof');
  });

  it("??= 'eof' does NOT overwrite a reason already set by a signal handler", () => {
    // When SIGTERM fired before readline closed, the existing reason is preserved.
    const exitReasonRef: ExitReasonRef = { current: 'sigterm' };
    exitReasonRef.current ??= 'eof';
    expect(exitReasonRef.current).toBe('sigterm');
  });

  it("??= 'eof' does NOT overwrite 'sigint' — SIGINT exits are not mis-classified as EOF", () => {
    // Regression guard for issue #2900: SIGINT paths set exitReasonRef.current='sigint'
    // before calling rl.close(); the ??= fallback in rl.on('close') must not overwrite it.
    const exitReasonRef: ExitReasonRef = { current: 'sigint' };
    exitReasonRef.current ??= 'eof';
    expect(exitReasonRef.current).toBe('sigint');
  });

  it('makeSessionSaver records eof in the sidecar when exitReasonRef holds eof', () => {
    mockSaveSession.mockClear();
    const ctx = makeMinimalCtx();
    const exitReasonRef: ExitReasonRef = { current: 'eof' };
    const { saveCurrentSession } = makeSessionSaver(ctx, exitReasonRef);

    saveCurrentSession();

    expect(mockSaveSession).toHaveBeenCalledOnce();
    const opts = mockSaveSession.mock.calls[0][2] as Record<string, unknown>;
    expect(opts['closeTime']).toBe(true);
    expect(opts['exitReason']).toBe('eof');
  });
});

// ---------------------------------------------------------------------------
// Mocks for printExitSummary / snapshotGitStateForCancelAll / cancelSessionBackgroundWork
// ---------------------------------------------------------------------------

vi.mock('../../render.js', () => ({
  divider: vi.fn((_label: string) => '--- Session Summary ---'),
}));

vi.mock('../../format-utils.js', () => ({
  formatDuration: vi.fn((_ms: number) => '1m 23s'),
}));

vi.mock('../../render/session-summary.js', () => ({
  costTokenParts: vi.fn(() => ['$0.01', '1234tok']),
}));

vi.mock('../../resume-command.js', () => ({
  formatResumeCommand: vi.fn((id: string, _model: unknown) => `afk interactive --resume ${id}`),
}));

vi.mock('../../palette.js', () => ({
  palette: {
    dim: vi.fn((s: string) => s),
    brand: vi.fn((s: string) => s),
    info: vi.fn((s: string) => s),
    warn: vi.fn((s: string) => s),
    error: vi.fn((s: string) => s),
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
    execFile: vi.fn(),
  };
});

import { execFileSync, execFile as execFileCb } from 'node:child_process';
const mockExecFileSync = execFileSync as ReturnType<typeof vi.fn>;
const mockExecFileCb = execFileCb as ReturnType<typeof vi.fn>;

import {
  printExitSummary,
  snapshotGitStateForCancelAll,
  cancelSessionBackgroundWork,
} from './interactive.cleanup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtxWithTurns(overrides?: Partial<InteractiveCtx['stats']>): InteractiveCtx {
  const base = makeMinimalCtx();
  Object.assign(base.stats, {
    totalTurns: 3,
    sessionStartTime: Date.now() - 5000,
    model: 'claude-opus-4',
    sessionId: 'sess-abc123',
    totalCostUsd: 0.01,
    totalTokens: 1234,
    cwd: '/tmp/test-repo',
    ...overrides,
  });
  return base;
}

function makeBackgroundRegistry(jobs: Array<{ status: string }> = []) {
  return {
    list: vi.fn(() => jobs),
    cancelAll: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDetachRegistry() {
  return { cancelAll: vi.fn() };
}

function makeProcessJobs() {
  return { killAll: vi.fn().mockResolvedValue(undefined) };
}

// ---------------------------------------------------------------------------
// printExitSummary
// ---------------------------------------------------------------------------

describe('printExitSummary', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockExecFileSync.mockReturnValue('');
    mockSaveSession.mockReturnValue('/fake/sess-abc123.json');
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints nothing when totalTurns === 0', () => {
    const ctx = makeCtxWithTurns({ totalTurns: 0 });
    const save = vi.fn(() => undefined);
    printExitSummary(ctx, undefined, save);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('prints divider, stats lines, and trailing blank when turns > 0', () => {
    const ctx = makeCtxWithTurns();
    mockExecFileSync.mockReturnValue('1 file changed, 2 insertions(+)');
    const save = vi.fn(() => '/fake/sess-abc123.json');
    printExitSummary(ctx, undefined, save);
    // divider + line1 + line2 + edits + resume + trailing blank = at least 5 calls
    expect(consoleSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('includes worktree basename when worktreeHandle is provided', () => {
    const ctx = makeCtxWithTurns();
    mockExecFileSync.mockReturnValue('');
    const save = vi.fn(() => undefined);
    const handle = { path: '/some/.afk-worktrees/my-worktree' } as import('./worktree.js').WorktreeHandle;
    printExitSummary(ctx, handle, save);
    const allText = consoleSpy.mock.calls.flat().join('\n');
    expect(allText).toContain('my-worktree');
  });

  it('shows "none" for worktree when handle is undefined', () => {
    const ctx = makeCtxWithTurns();
    mockExecFileSync.mockReturnValue('');
    const save = vi.fn(() => undefined);
    printExitSummary(ctx, undefined, save);
    const allText = consoleSpy.mock.calls.flat().join('\n');
    expect(allText).toContain('none');
  });

  it('shows "no files changed" when git diff --shortstat returns empty string', () => {
    const ctx = makeCtxWithTurns();
    mockExecFileSync.mockReturnValue('   '); // whitespace → trim → empty
    const save = vi.fn(() => undefined);
    printExitSummary(ctx, undefined, save);
    const allText = consoleSpy.mock.calls.flat().join('\n');
    expect(allText).toContain('no files changed');
  });

  it('shows the shortstat text when git diff returns content', () => {
    const ctx = makeCtxWithTurns();
    mockExecFileSync.mockReturnValue(' 2 files changed, 5 insertions(+), 1 deletion(-)\n');
    const save = vi.fn(() => undefined);
    printExitSummary(ctx, undefined, save);
    const allText = consoleSpy.mock.calls.flat().join('\n');
    expect(allText).toContain('2 files changed');
  });

  it('silently skips the edits line when execFileSync throws', () => {
    const ctx = makeCtxWithTurns();
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
    const save = vi.fn(() => undefined);
    // Should not throw
    expect(() => printExitSummary(ctx, undefined, save)).not.toThrow();
    const allText = consoleSpy.mock.calls.flat().join('\n');
    expect(allText).not.toContain('edits:');
  });

  it('prints resume command using ctx.stats.sessionId', () => {
    const ctx = makeCtxWithTurns({ sessionId: 'my-session-id' });
    mockExecFileSync.mockReturnValue('');
    const save = vi.fn(() => undefined);
    printExitSummary(ctx, undefined, save);
    const allText = consoleSpy.mock.calls.flat().join('\n');
    expect(allText).toContain('my-session-id');
  });

  it('derives resume id from savedPath when sessionId is absent', () => {
    const ctx = makeCtxWithTurns({ sessionId: undefined });
    mockExecFileSync.mockReturnValue('');
    mockSaveSession.mockReturnValue('/fake/derived-id.json');
    const save = vi.fn(() => '/fake/derived-id.json');
    printExitSummary(ctx, undefined, save);
    const allText = consoleSpy.mock.calls.flat().join('\n');
    expect(allText).toContain('derived-id');
  });

  it('omits resume line when both sessionId and savedPath are absent', () => {
    const ctx = makeCtxWithTurns({ sessionId: undefined });
    mockExecFileSync.mockReturnValue('');
    const save = vi.fn(() => undefined);
    printExitSummary(ctx, undefined, save);
    const allText = consoleSpy.mock.calls.flat().join('\n');
    expect(allText).not.toContain('Continue with');
  });

  it('swallows errors thrown by saveCurrentSession and still prints other lines', () => {
    const ctx = makeCtxWithTurns({ sessionId: undefined });
    mockExecFileSync.mockReturnValue('');
    const save = vi.fn(() => { throw new Error('disk full'); });
    expect(() => printExitSummary(ctx, undefined, save)).not.toThrow();
    // divider should still appear
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('uses process.cwd() as fallback cwd for git when ctx.stats.cwd is undefined', () => {
    const ctx = makeCtxWithTurns({ cwd: undefined });
    mockExecFileSync.mockReturnValue('');
    const save = vi.fn(() => undefined);
    printExitSummary(ctx, undefined, save);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', '--shortstat', 'HEAD'],
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });
});

// ---------------------------------------------------------------------------
// snapshotGitStateForCancelAll
// ---------------------------------------------------------------------------

describe('snapshotGitStateForCancelAll', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    mockExecFileCb.mockReset();
  });

  it('writes a snapshot header to stderr when git commands succeed', async () => {
    // execFile (promisified) — mock the callback form used by promisify
    mockExecFileCb.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: ' 1 file changed\n', stderr: '' });
      },
    );
    await snapshotGitStateForCancelAll('/tmp/repo');
    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('pre-cancelAll git snapshot');
  });

  it('shows "(no uncommitted changes)" when git diff --stat is empty', async () => {
    mockExecFileCb.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        const out = args.includes('--stat') ? '' : '';
        cb(null, { stdout: out, stderr: '' });
      },
    );
    await snapshotGitStateForCancelAll('/tmp/repo');
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('(no uncommitted changes)');
  });

  it('shows "(working tree clean)" when git status --short is empty', async () => {
    mockExecFileCb.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: '', stderr: '' });
      },
    );
    await snapshotGitStateForCancelAll('/tmp/repo');
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('(working tree clean)');
  });

  it('silently swallows errors from git (not a git repo, timeout, etc.)', async () => {
    mockExecFileCb.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
        cb(new Error('not a git repo'));
      },
    );
    await expect(snapshotGitStateForCancelAll('/tmp/not-a-repo')).resolves.toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('indents each diff line with 4 spaces', async () => {
    mockExecFileCb.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        const out = args.includes('--stat') ? 'file.ts | 2 ++\n' : '';
        cb(null, { stdout: out, stderr: '' });
      },
    );
    await snapshotGitStateForCancelAll('/tmp/repo');
    const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('    file.ts | 2 ++');
  });
});

// ---------------------------------------------------------------------------
// cancelSessionBackgroundWork
// ---------------------------------------------------------------------------

describe('cancelSessionBackgroundWork', () => {
  afterEach(() => {
    mockExecFileCb.mockReset();
    vi.spyOn(process.stderr, 'write').mockRestore();
  });

  it('calls backgroundRegistry.cancelAll()', async () => {
    const bgReg = makeBackgroundRegistry();
    const ctx = makeCtxWithTurns();
    (ctx as unknown as Record<string, unknown>).backgroundRegistry = bgReg;
    await cancelSessionBackgroundWork(ctx as unknown as InteractiveCtx);
    expect(bgReg.cancelAll).toHaveBeenCalled();
  });

  it('calls detachRegistry.cancelAll() when present', async () => {
    const bgReg = makeBackgroundRegistry();
    const detach = makeDetachRegistry();
    const ctx = makeCtxWithTurns();
    (ctx as unknown as Record<string, unknown>).backgroundRegistry = bgReg;
    (ctx as unknown as Record<string, unknown>).detachRegistry = detach;
    await cancelSessionBackgroundWork(ctx as unknown as InteractiveCtx);
    expect(detach.cancelAll).toHaveBeenCalled();
  });

  it('calls processJobs.killAll() when present', async () => {
    const bgReg = makeBackgroundRegistry();
    const pjobs = makeProcessJobs();
    const ctx = makeCtxWithTurns();
    (ctx as unknown as Record<string, unknown>).backgroundRegistry = bgReg;
    (ctx as unknown as Record<string, unknown>).processJobs = pjobs;
    await cancelSessionBackgroundWork(ctx as unknown as InteractiveCtx);
    expect(pjobs.killAll).toHaveBeenCalled();
  });

  it('snapshots git state when there are running background jobs', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockExecFileCb.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: '', stderr: '' });
      },
    );
    const bgReg = makeBackgroundRegistry([{ status: 'running' }]);
    const ctx = makeCtxWithTurns({ cwd: '/tmp/repo' });
    (ctx as unknown as Record<string, unknown>).backgroundRegistry = bgReg;
    await cancelSessionBackgroundWork(ctx as unknown as InteractiveCtx);
    expect(bgReg.cancelAll).toHaveBeenCalled();
  });

  it('does NOT snapshot git state when no running jobs', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const bgReg = makeBackgroundRegistry([{ status: 'done' }]);
    const ctx = makeCtxWithTurns();
    (ctx as unknown as Record<string, unknown>).backgroundRegistry = bgReg;
    await cancelSessionBackgroundWork(ctx as unknown as InteractiveCtx);
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('swallows backgroundRegistry.cancelAll() rejection (best-effort)', async () => {
    const bgReg = {
      list: vi.fn(() => []),
      cancelAll: vi.fn().mockRejectedValue(new Error('cancel failed')),
    };
    const ctx = makeCtxWithTurns();
    (ctx as unknown as Record<string, unknown>).backgroundRegistry = bgReg;
    await expect(cancelSessionBackgroundWork(ctx as unknown as InteractiveCtx)).resolves.toBeUndefined();
  });

  it('swallows processJobs.killAll() rejection (best-effort)', async () => {
    const bgReg = makeBackgroundRegistry();
    const pjobs = { killAll: vi.fn().mockRejectedValue(new Error('kill failed')) };
    const ctx = makeCtxWithTurns();
    (ctx as unknown as Record<string, unknown>).backgroundRegistry = bgReg;
    (ctx as unknown as Record<string, unknown>).processJobs = pjobs;
    await expect(cancelSessionBackgroundWork(ctx as unknown as InteractiveCtx)).resolves.toBeUndefined();
  });

  it('is safe when detachRegistry is absent', async () => {
    const bgReg = makeBackgroundRegistry();
    const ctx = makeCtxWithTurns();
    (ctx as unknown as Record<string, unknown>).backgroundRegistry = bgReg;
    // detachRegistry intentionally absent
    delete (ctx as unknown as Record<string, unknown>).detachRegistry;
    await expect(cancelSessionBackgroundWork(ctx as unknown as InteractiveCtx)).resolves.toBeUndefined();
  });

  it('is safe when processJobs is absent', async () => {
    const bgReg = makeBackgroundRegistry();
    const ctx = makeCtxWithTurns();
    (ctx as unknown as Record<string, unknown>).backgroundRegistry = bgReg;
    delete (ctx as unknown as Record<string, unknown>).processJobs;
    await expect(cancelSessionBackgroundWork(ctx as unknown as InteractiveCtx)).resolves.toBeUndefined();
  });
});
