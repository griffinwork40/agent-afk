import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalCompositor } from './terminal-compositor.js';

describe('interactive bootstrap status line hooks', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('repaints current stats on demand and after clearScreen restart', async () => {
    const statusLine = {
      start: vi.fn(),
      stop: vi.fn(),
      repaint: vi.fn(),
    };
    const rl = { on: vi.fn(), close: vi.fn() };
    const registerAll = vi.fn();
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    vi.doMock('node:readline', () => ({
      createInterface: vi.fn(() => rl),
    }));
    vi.doMock('../agent/session.js', () => ({
      AgentSession: class MockAgentSession {
        close = vi.fn(async () => undefined);
        interrupt = vi.fn(async () => undefined);
      },
    }));
    vi.doMock('../agent/default-hook-registry.js', () => ({
      createDefaultHookRegistry: vi.fn(() => ({
        registry: {},
        memoryStore: { close: vi.fn() },
        // Real factory always returns this ref (default-hook-registry.ts:72,125);
        // bootstrap.ts:601 writes `.current` once the provider exists, so the mock
        // must include it or the assignment throws "Cannot set properties of undefined".
        pathApprovalGrantRef: { current: undefined },
      })),
    }));
    vi.doMock('../agent/memory/index.js', () => ({
      MemoryStore: vi.fn(() => ({ close: vi.fn() })),
      injectHotMemory: vi.fn((config: unknown) => config),
      memoryToolSchemas: [],
      MEMORY_TOOL_NAMES: [],
      createMemoryHandlers: vi.fn(() => new Map()),
    }));
    vi.doMock('./shared-helpers.js', () => ({
      parseThinking: vi.fn(() => undefined),
      parseEffort: vi.fn(() => undefined),
      parseMaxOutputTokens: vi.fn(() => undefined),
      parseProvider: vi.fn(() => undefined),
      getApiKey: vi.fn(() => 'test-key'),
      getApiKeyForModel: vi.fn(() => 'test-key'),
      getModel: vi.fn(() => 'sonnet'),
      getThinking: vi.fn(() => undefined),
      getEffort: vi.fn(() => undefined),
      getMaxOutputTokens: vi.fn(() => undefined),
      getDefaultSubagentModel: vi.fn(() => 'sonnet'),
      findClaudeExecutable: vi.fn(() => '/usr/bin/claude'),
      loadSystemPrompt: vi.fn(() => undefined),
      loadConfigSystemPrompt: vi.fn(() => undefined),
      resolveBaseSystemPrompt: vi.fn(() => ({ prompt: undefined, source: 'none' })),
      // Required since bootstrap.ts now calls isGrantManager — return false so
      // the pre-existing tests don't care about grant wiring.
      isGrantManager: vi.fn(() => false),
    }));
    vi.doMock('./status-line.js', () => ({
      StatusLine: vi.fn(() => statusLine),
    }));
    vi.doMock('./slash/index.js', () => ({ registerAll }));
    vi.doMock('./slash/writer.js', () => ({
      createConsoleWriter: vi.fn(() => ({
        line: vi.fn(),
        raw: vi.fn(),
        success: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
    }));

    const { bootstrapSession } = await import('./commands/interactive/bootstrap.js');
    const ctx = await bootstrapSession({ model: 'sonnet', maxTurns: '10' });

    expect(registerAll).toHaveBeenCalledTimes(1);

    ctx.stats.model = 'opus';
    ctx.stats.permissionMode = 'plan';
    ctx.stats.totalCostUsd = 1.25;
    ctx.stats.totalTokens = 2048;

    ctx.slashCtx.ui.repaintStatusLine();
    expect(statusLine.repaint).toHaveBeenLastCalledWith({
      model: 'opus',
      cost: 1.25,
      tokens: 2048,
      contextPct: 0,
      contextLimit: 200000,
      contextUsedTokens: undefined,
      contextSparkline: undefined,
      permissionMode: 'plan',
      cwd: process.cwd(),
    });

    // Regression: clearScreen must zero the persistent compositor's overlay
    // AND committed band before the physical clear. bootstrap leaves
    // getCompositor unset (it is wired by repl-loop.ts:270 at runtime); wire a
    // mock the same way so the closure reaches a live compositor and we can
    // assert both resets fire (and are ordered before the raw clear).
    const setOverlay = vi.fn();
    const resetCommittedBand = vi.fn();
    ctx.slashCtx.getCompositor = () =>
      ({ setOverlay, resetCommittedBand }) as unknown as TerminalCompositor;

    const stopOrderBeforeClear = statusLine.stop.mock.invocationCallOrder.length;
    ctx.slashCtx.ui.clearScreen();

    expect(statusLine.stop).toHaveBeenCalledTimes(stopOrderBeforeClear + 1);
    expect(stdoutWrite).toHaveBeenCalledWith('\x1b[3J\x1b[2J\x1b[H');
    expect(statusLine.start).toHaveBeenCalledTimes(1);
    // Overlay reset fired, and BEFORE the raw screen-clear escape — otherwise
    // the subsequent commitAbove repaint would re-paint the stale overlay.
    expect(setOverlay).toHaveBeenCalledWith('');
    // Committed-band reset fired too — otherwise the stale transcript band
    // survives the wipe and repositionCommittedBand re-pins it on the next
    // shrink repaint (slash menu open→collapse), resurrecting prior history.
    expect(resetCommittedBand).toHaveBeenCalledTimes(1);
    expect(statusLine.repaint).toHaveBeenLastCalledWith({
      model: 'opus',
      cost: 1.25,
      tokens: 2048,
      contextPct: 0,
      contextLimit: 200000,
      contextUsedTokens: undefined,
      contextSparkline: undefined,
      permissionMode: 'plan',
      cwd: process.cwd(),
    });
    const clearCall = stdoutWrite.mock.invocationCallOrder[
      stdoutWrite.mock.calls.findIndex((args) => args[0] === '\x1b[3J\x1b[2J\x1b[H')
    ]!;
    expect(statusLine.stop.mock.invocationCallOrder.at(-1)).toBeLessThan(clearCall);
    expect(clearCall).toBeLessThan(statusLine.start.mock.invocationCallOrder.at(-1)!);
    // The overlay reset must precede the raw clear so no stale overlay survives.
    expect(setOverlay.mock.invocationCallOrder.at(-1)!).toBeLessThan(clearCall);
    // Same ordering guarantee for the band reset.
    expect(resetCommittedBand.mock.invocationCallOrder.at(-1)!).toBeLessThan(clearCall);
  });
});

/**
 * P1 regression — bootstrap forwards the OpenAI-compatible endpoint into the
 * ghost-text suggestion context.
 *
 * Repro (Codex review on PR #606): `bootstrapSession` set
 * `suggestBaseUrl` from `cliConfig.baseUrl` (the distinct Anthropic-shim
 * endpoint) instead of `cliConfig.openaiBaseUrl`. So when a user configured
 * only `openaiBaseUrl` (Ollama / vLLM / LM Studio / a proxy) — the same value
 * `parseProvider` already receives for the live session (bootstrap.ts:352) —
 * `suggestBaseUrl` was left undefined and the suggest engine fell back to
 * api.openai.com. Side-channel completions then either failed or leaked to the
 * wrong provider while the session used the configured local endpoint.
 *
 * suggest.ts:355 forwards `ctx.baseUrl` as an `openaiBaseUrl` provider hint, so
 * `suggestBaseUrl` MUST carry `openaiBaseUrl`, never `baseUrl`.
 */
describe('interactive bootstrap — P1: suggestBaseUrl mirrors openaiBaseUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Mocks shared with the status-line test above — enough to let
  // bootstrapSession reach the InteractiveCtx construction without a real
  // session/TTY. `loadConfig` is the subject: it is overridden per-case.
  function applyCommonMocks(): void {
    const rl = { on: vi.fn(), close: vi.fn() };
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.doMock('node:readline', () => ({ createInterface: vi.fn(() => rl) }));
    vi.doMock('../agent/session.js', () => ({
      AgentSession: class MockAgentSession {
        close = vi.fn(async () => undefined);
        interrupt = vi.fn(async () => undefined);
      },
    }));
    vi.doMock('../agent/default-hook-registry.js', () => ({
      createDefaultHookRegistry: vi.fn(() => ({
        registry: {},
        memoryStore: { close: vi.fn() },
        // Real factory always returns this ref (default-hook-registry.ts);
        // bootstrap.ts writes `.current` once the provider exists, so the mock
        // must include it or the assignment throws "Cannot set properties of
        // undefined". Mirrors the status-line test mock above.
        pathApprovalGrantRef: { current: undefined },
      })),
    }));
    vi.doMock('../agent/memory/index.js', () => ({
      MemoryStore: vi.fn(() => ({ close: vi.fn() })),
      injectHotMemory: vi.fn((config: unknown) => config),
      memoryToolSchemas: [],
      MEMORY_TOOL_NAMES: [],
      createMemoryHandlers: vi.fn(() => new Map()),
    }));
    vi.doMock('./shared-helpers.js', () => ({
      parseThinking: vi.fn(() => undefined),
      parseEffort: vi.fn(() => undefined),
      parseMaxOutputTokens: vi.fn(() => undefined),
      parseProvider: vi.fn(() => undefined),
      getApiKey: vi.fn(() => 'test-key'),
      getApiKeyForModel: vi.fn(() => 'test-key'),
      getModel: vi.fn(() => 'sonnet'),
      getThinking: vi.fn(() => undefined),
      getEffort: vi.fn(() => undefined),
      getMaxOutputTokens: vi.fn(() => undefined),
      getDefaultSubagentModel: vi.fn(() => 'sonnet'),
      findClaudeExecutable: vi.fn(() => '/usr/bin/claude'),
      loadSystemPrompt: vi.fn(() => undefined),
      loadConfigSystemPrompt: vi.fn(() => undefined),
      resolveBaseSystemPrompt: vi.fn(() => ({ prompt: undefined, source: 'none' })),
      // Required since bootstrap.ts now calls isGrantManager — return false so
      // these tests don't care about grant wiring.
      isGrantManager: vi.fn(() => false),
    }));
    vi.doMock('./status-line.js', () => ({
      StatusLine: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), repaint: vi.fn() })),
    }));
    vi.doMock('./slash/index.js', () => ({ registerAll: vi.fn() }));
    vi.doMock('./slash/writer.js', () => ({
      createConsoleWriter: vi.fn(() => ({
        line: vi.fn(), raw: vi.fn(), success: vi.fn(),
        info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      })),
    }));
  }

  it('uses cliConfig.openaiBaseUrl when only openaiBaseUrl is configured', async () => {
    applyCommonMocks();
    vi.doMock('./config.js', () => ({
      loadConfig: vi.fn(() => ({ openaiBaseUrl: 'http://localhost:1234/v1' })),
    }));

    const { bootstrapSession } = await import('./commands/interactive/bootstrap.js');
    const ctx = await bootstrapSession({ model: 'sonnet', maxTurns: '10' });

    // The bug set this from `cliConfig.baseUrl` (undefined here) → suggestBaseUrl
    // would be undefined and suggestions would hit api.openai.com instead.
    expect(ctx.suggestBaseUrl).toBe('http://localhost:1234/v1');
  });

  it('does NOT use cliConfig.baseUrl (Anthropic shim) for suggestBaseUrl', async () => {
    applyCommonMocks();
    // Only the Anthropic-style baseUrl is set — there is no OpenAI endpoint, so
    // suggestBaseUrl must stay undefined (suggest.ts forwards it as an
    // openaiBaseUrl hint; the Anthropic endpoint would be wrong for that path).
    vi.doMock('./config.js', () => ({
      loadConfig: vi.fn(() => ({ baseUrl: 'http://localhost:9999' })),
    }));

    const { bootstrapSession } = await import('./commands/interactive/bootstrap.js');
    const ctx = await bootstrapSession({ model: 'sonnet', maxTurns: '10' });

    expect(ctx.suggestBaseUrl).toBeUndefined();
  });

  it('prefers openaiBaseUrl even when both endpoints are configured', async () => {
    applyCommonMocks();
    vi.doMock('./config.js', () => ({
      loadConfig: vi.fn(() => ({
        baseUrl: 'http://localhost:9999',
        openaiBaseUrl: 'http://localhost:1234/v1',
      })),
    }));

    const { bootstrapSession } = await import('./commands/interactive/bootstrap.js');
    const ctx = await bootstrapSession({ model: 'sonnet', maxTurns: '10' });

    expect(ctx.suggestBaseUrl).toBe('http://localhost:1234/v1');
  });
});

describe('interactive command exit teardown', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the status line before printing the exit summary', async () => {
    const cleanupFns: Array<() => Promise<void>> = [];
    const spinner = {
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
    };
    spinner.start.mockReturnValue(spinner);

    const rl = new EventEmitter() as EventEmitter & { close(): void };
    rl.close = () => {
      rl.emit('close');
    };

    const statusLine = { start: vi.fn(), stop: vi.fn() };
    const session = {
      close: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
    };
    const transcript = {
      path: vi.fn(() => '/tmp/session.md'),
      appendEnded: vi.fn(async () => undefined),
    };

    const repaintStatusLine = vi.fn();

    vi.doMock('ora', () => ({
      default: vi.fn(() => spinner),
    }));
    vi.doMock('./render.js', () => ({
      welcomeBanner: vi.fn(() => 'WELCOME'),
      divider: vi.fn((label: string) => label),
    }));
    vi.doMock('../utils/cleanupRegistry.js', () => ({
      registerCleanup: vi.fn((fn: () => Promise<void>) => {
        cleanupFns.push(fn);
        return () => undefined;
      }),
      runCleanupFunctions: vi.fn(async () => {
        await Promise.all(cleanupFns.map((fn) => fn()));
      }),
    }));
    vi.doMock('./shared-helpers.js', () => ({
      getModel: vi.fn(() => 'sonnet'),
      getApiKey: vi.fn(() => undefined),
      getApiKeyForModel: vi.fn(() => undefined),
    }));
    vi.doMock('./session-store.js', () => ({
      saveSession: vi.fn(),
    }));
    vi.doMock('./commands/interactive/bootstrap.js', () => ({
      bootstrapSession: vi.fn(async () => ({
        session: { current: session },
        memoryStore: { close: vi.fn() },
        stats: {
          totalTurns: 1,
          totalCostUsd: 0.25,
          totalTokens: 512,
          totalDurationMs: 0,
          sessionStartTime: Date.now() - 1000,
          turnCosts: [0.25],
          turnTokens: [{ input: 256, output: 256, cache: 0 }],
          turns: [],
          model: 'sonnet',
          permissionMode: 'default',
          sessionId: 'sdk-exit',
        },
        statusLine,
        slashCtx: {
          ui: {
            repaintStatusLine,
          },
        } as never,
        rl,
        options: { model: 'sonnet', maxTurns: '10', debug: false },
        // Stub registry: the teardown path calls cancelAll() during normal
        // session close. Real registry is exercised by bgsub.test.ts.
        backgroundRegistry: { cancelAll: vi.fn(async () => undefined) },
      })),
    }));
    vi.doMock('./commands/interactive/transcript.js', () => ({
      initTranscript: vi.fn(async () => transcript),
    }));
    vi.doMock('./commands/interactive/repl-loop.js', () => ({
      runReplLoop: vi.fn(async () => {
        rl.emit('close');
      }),
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => code as never));

    const { Command } = await import('commander');
    const { registerInteractiveCommand } = await import('./commands/interactive.js');

    const program = new Command();
    registerInteractiveCommand(program);
    await program.parseAsync(['node', 'afk', 'interactive']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(exitSpy).toHaveBeenCalledWith(0);

    expect(statusLine.stop).toHaveBeenCalledTimes(1);
    expect(statusLine.start).toHaveBeenCalledTimes(1);
    expect(repaintStatusLine).toHaveBeenCalledTimes(1);

    const summaryLogIndex = logSpy.mock.calls.findIndex(([line]) =>
      typeof line === 'string' && line.includes('Session Summary'),
    );
    const resumeLogIndex = logSpy.mock.calls.findIndex(([line]) =>
      typeof line === 'string' && line.includes('afk interactive --model sonnet --resume sdk-exit'),
    );
    expect(summaryLogIndex).toBeGreaterThanOrEqual(0);
    expect(resumeLogIndex).toBeGreaterThanOrEqual(0);
    expect(statusLine.stop.mock.invocationCallOrder[0]!).toBeLessThan(logSpy.mock.invocationCallOrder[summaryLogIndex]!);
    expect(logSpy.mock.invocationCallOrder[summaryLogIndex]!).toBeLessThan(logSpy.mock.invocationCallOrder[resumeLogIndex]!);
  });
});

describe('interactive worktree flag', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupCommonMocks(): {
    cleanupFns: Array<() => Promise<void>>;
    rl: EventEmitter & { close(): void };
    statusLine: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    session: { close: ReturnType<typeof vi.fn>; interrupt: ReturnType<typeof vi.fn> };
    transcript: { path: ReturnType<typeof vi.fn>; appendEnded: ReturnType<typeof vi.fn> };
    spinner: {
      start: ReturnType<typeof vi.fn>;
      succeed: ReturnType<typeof vi.fn>;
      fail: ReturnType<typeof vi.fn>;
      text: string;
    };
    repaintStatusLine: ReturnType<typeof vi.fn>;
  } {
    const cleanupFns: Array<() => Promise<void>> = [];
    const spinner = {
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      text: '',
    };
    spinner.start.mockReturnValue(spinner);

    const rl = new EventEmitter() as EventEmitter & { close(): void };
    rl.close = () => {
      rl.emit('close');
    };

    const statusLine = { start: vi.fn(), stop: vi.fn() };
    const session = {
      close: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
    };
    const transcript = {
      path: vi.fn(() => '/tmp/session.md'),
      appendEnded: vi.fn(async () => undefined),
    };

    const repaintStatusLine = vi.fn();

    vi.doMock('ora', () => ({
      default: vi.fn(() => spinner),
    }));
    vi.doMock('./render.js', () => ({
      welcomeBanner: vi.fn(() => 'WELCOME'),
      divider: vi.fn((label: string) => label),
    }));
    vi.doMock('../utils/cleanupRegistry.js', () => ({
      registerCleanup: vi.fn((fn: () => Promise<void>) => {
        cleanupFns.push(fn);
        return () => undefined;
      }),
      runCleanupFunctions: vi.fn(async () => {
        await Promise.all(cleanupFns.map((fn) => fn()));
      }),
    }));
    vi.doMock('./shared-helpers.js', () => ({
      getModel: vi.fn(() => 'sonnet'),
      getApiKey: vi.fn(() => undefined),
      getApiKeyForModel: vi.fn(() => undefined),
    }));
    vi.doMock('./session-store.js', () => ({
      saveSession: vi.fn(),
    }));
    vi.doMock('./commands/interactive/transcript.js', () => ({
      initTranscript: vi.fn(async () => transcript),
    }));
    vi.doMock('./commands/interactive/repl-loop.js', () => ({
      runReplLoop: vi.fn(async () => {
        rl.emit('close');
      }),
    }));

    return { cleanupFns, rl, statusLine, session, transcript, spinner, repaintStatusLine };
  }

  function makeBootstrapMock(
    rl: EventEmitter,
    statusLine: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> },
    session: { close: ReturnType<typeof vi.fn>; interrupt: ReturnType<typeof vi.fn> },
    repaintStatusLine: ReturnType<typeof vi.fn>,
    options: { model: string; maxTurns: string; debug: boolean; worktree?: string | true },
  ): ReturnType<typeof vi.fn> {
    return vi.fn(async () => ({
      session: { current: session },
      memoryStore: { close: vi.fn() },
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
        permissionMode: 'default',
      },
      statusLine,
      slashCtx: {
        ui: {
          repaintStatusLine,
        },
      } as never,
      rl,
      options,
      backgroundRegistry: { cancelAll: vi.fn(async () => undefined) },
    }));
  }

  it('creates a worktree and passes its path as cwd to bootstrapSession', async () => {
    const { rl, statusLine, session, repaintStatusLine } = setupCommonMocks();

    const worktreeCleanup = vi.fn(async () => undefined);
    const setupWorktree = vi.fn(async () => ({
      path: '/tmp/afk-wt/feat-spec',
      branch: 'feat-spec',
      cleanup: worktreeCleanup,
    }));
    vi.doMock('./commands/interactive/worktree.js', () => ({ setupWorktree }));

    const bootstrapMock = makeBootstrapMock(rl, statusLine, session, repaintStatusLine, {
      model: 'sonnet',
      maxTurns: '10',
      debug: false,
      worktree: 'feat-spec',
    });
    vi.doMock('./commands/interactive/bootstrap.js', () => ({
      bootstrapSession: bootstrapMock,
    }));

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => code as never));

    const { Command } = await import('commander');
    const { registerInteractiveCommand } = await import('./commands/interactive.js');

    const program = new Command();
    registerInteractiveCommand(program);
    await program.parseAsync(['node', 'afk', 'interactive', '--worktree', 'feat-spec']);
    await new Promise((resolve) => setImmediate(resolve));

    expect(exitSpy).toHaveBeenCalledWith(0);
    // `setupWorktree` is now called with a second arg (branch-prefix override
    // slot). When no env var or config sets it, the slot is undefined.
    expect(setupWorktree).toHaveBeenCalledWith('feat-spec', undefined);
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
    expect(bootstrapMock.mock.calls[0]![1]).toEqual({ cwd: '/tmp/afk-wt/feat-spec' });
    expect(worktreeCleanup).toHaveBeenCalledTimes(1);
    expect(session.close).toHaveBeenCalledTimes(1);

    // The SDK subprocess must shut down BEFORE `git worktree remove --force`
    // touches the directory; otherwise removal can race against an open
    // session. `vi.fn`'s `invocationCallOrder` is a monotonically-increasing
    // call ID, so a strictly-less-than comparison guarantees ordering.
    const sessionCloseOrder = session.close.mock.invocationCallOrder[0];
    const worktreeCleanupOrder = worktreeCleanup.mock.invocationCallOrder[0];
    expect(sessionCloseOrder).toBeDefined();
    expect(worktreeCleanupOrder).toBeDefined();
    expect(sessionCloseOrder!).toBeLessThan(worktreeCleanupOrder!);
  });

  it('does not call setupWorktree when --worktree is not passed', async () => {
    const { rl, statusLine, session, repaintStatusLine } = setupCommonMocks();

    const setupWorktree = vi.fn();
    vi.doMock('./commands/interactive/worktree.js', () => ({ setupWorktree }));

    const bootstrapMock = makeBootstrapMock(rl, statusLine, session, repaintStatusLine, {
      model: 'sonnet',
      maxTurns: '10',
      debug: false,
    });
    vi.doMock('./commands/interactive/bootstrap.js', () => ({
      bootstrapSession: bootstrapMock,
    }));

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => code as never));

    const { Command } = await import('commander');
    const { registerInteractiveCommand } = await import('./commands/interactive.js');

    const program = new Command();
    registerInteractiveCommand(program);
    await program.parseAsync(['node', 'afk', 'interactive']);
    await new Promise((resolve) => setImmediate(resolve));

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(setupWorktree).not.toHaveBeenCalled();
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
    expect(bootstrapMock.mock.calls[0]![1]).toBeUndefined();
  });

  // ── Item #1: worktree branch line persists past spinner.succeed ─────────
  it('prints ↪ worktree: line after spinner.succeed when --worktree is set', async () => {
    const { rl, statusLine, session, repaintStatusLine, spinner } = setupCommonMocks();

    const worktreeCleanup = vi.fn(async () => undefined);
    const setupWorktree = vi.fn(async () => ({
      path: '/tmp/afk-wt/my-feature',
      branch: 'my-feature',
      cleanup: worktreeCleanup,
    }));
    vi.doMock('./commands/interactive/worktree.js', () => ({ setupWorktree }));

    const bootstrapMock = makeBootstrapMock(rl, statusLine, session, repaintStatusLine, {
      model: 'sonnet',
      maxTurns: '10',
      debug: false,
      worktree: 'my-feature',
    });
    vi.doMock('./commands/interactive/bootstrap.js', () => ({
      bootstrapSession: bootstrapMock,
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => code as never));

    const { Command } = await import('commander');
    const { registerInteractiveCommand } = await import('./commands/interactive.js');

    const program = new Command();
    registerInteractiveCommand(program);
    await program.parseAsync(['node', 'afk', 'interactive', '--worktree', 'my-feature']);
    await new Promise((resolve) => setImmediate(resolve));

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(spinner.succeed).toHaveBeenCalledWith('Session ready');

    // The worktree line must appear in the console.log output after
    // spinner.succeed is called.
    const allLogs = logSpy.mock.calls.map(args => args.map(a => String(a)).join(' '));
    const worktreeLine = allLogs.find(line => line.includes('↪ worktree:'));
    expect(worktreeLine).toBeDefined();
    expect(worktreeLine).toContain('my-feature');
  });

  // ── Item #8: expanded session-close summary ──────────────────────────────
  it('includes model: and worktree: lines in session summary when turns > 0', async () => {
    const { rl, statusLine, session, repaintStatusLine } = setupCommonMocks();

    const worktreeCleanup = vi.fn(async () => undefined);
    const setupWorktree = vi.fn(async () => ({
      path: '/tmp/afk-wt/summary-test',
      branch: 'summary-test',
      cleanup: worktreeCleanup,
    }));
    vi.doMock('./commands/interactive/worktree.js', () => ({ setupWorktree }));

    vi.doMock('./commands/interactive/bootstrap.js', () => ({
      bootstrapSession: vi.fn(async () => ({
        session: { current: session },
        memoryStore: { close: vi.fn() },
        stats: {
          totalTurns: 2,
          totalCostUsd: 0.05,
          totalTokens: 1024,
          totalDurationMs: 0,
          sessionStartTime: Date.now() - 5000,
          turnCosts: [0.025, 0.025],
          turnTokens: [
            { input: 256, output: 256, cache: 0 },
            { input: 256, output: 256, cache: 0 },
          ],
          turns: [],
          model: 'claude-opus-4',
          permissionMode: 'default',
          sessionId: 'item8-test',
        },
        statusLine,
        slashCtx: {
          ui: { repaintStatusLine },
        } as never,
        rl,
        options: { model: 'claude-opus-4', maxTurns: '10', debug: false, worktree: 'summary-test' },
        backgroundRegistry: { cancelAll: vi.fn(async () => undefined) },
      })),
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => code as never));

    const { Command } = await import('commander');
    const { registerInteractiveCommand } = await import('./commands/interactive.js');

    const program = new Command();
    registerInteractiveCommand(program);
    await program.parseAsync(['node', 'afk', 'interactive', '--worktree', 'summary-test']);
    await new Promise((resolve) => setImmediate(resolve));

    const allLogs = logSpy.mock.calls.map(args => args.map(a => String(a)).join(' '));

    // Line 1 basics: turn count still present
    const statsLine = allLogs.find(l => l.includes('2 turns'));
    expect(statsLine).toBeDefined();

    // Line 2: model and worktree name
    const modelLine = allLogs.find(l => l.includes('model:') && l.includes('claude-opus-4'));
    expect(modelLine).toBeDefined();
    expect(modelLine).toContain('worktree:');
    expect(modelLine).toContain('summary-test');

    // Line 5 (resume hint): should contain the resume command
    const resumeLine = allLogs.find(l => l.includes('Continue with:') || l.includes('--resume'));
    expect(resumeLine).toBeDefined();
  });

  it('zero-turn worktree session calls cleanup with force:true', async () => {
    const { rl, statusLine, session, repaintStatusLine } = setupCommonMocks();

    const worktreeCleanup = vi.fn(async (_opts?: { force?: boolean }) => undefined);
    const setupWorktree = vi.fn(async () => ({
      path: '/tmp/afk-wt/feat-spec',
      branch: 'feat-spec',
      cleanup: worktreeCleanup,
    }));
    vi.doMock('./commands/interactive/worktree.js', () => ({ setupWorktree }));

    // makeBootstrapMock returns totalTurns: 0 by default
    const bootstrapMock = makeBootstrapMock(rl, statusLine, session, repaintStatusLine, {
      model: 'sonnet',
      maxTurns: '10',
      debug: false,
      worktree: 'feat-spec',
    });
    vi.doMock('./commands/interactive/bootstrap.js', () => ({
      bootstrapSession: bootstrapMock,
    }));

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => code as never));

    const { Command } = await import('commander');
    const { registerInteractiveCommand } = await import('./commands/interactive.js');

    const program = new Command();
    registerInteractiveCommand(program);
    await program.parseAsync(['node', 'afk', 'interactive', '--worktree', 'feat-spec']);
    await new Promise((resolve) => setImmediate(resolve));

    expect(worktreeCleanup).toHaveBeenCalledTimes(1);
    expect(worktreeCleanup).toHaveBeenCalledWith({ force: true });
  });

  it('non-zero-turn worktree session calls cleanup with force:false', async () => {
    const { rl, statusLine, session, repaintStatusLine } = setupCommonMocks();

    const worktreeCleanup = vi.fn(async (_opts?: { force?: boolean }) => undefined);
    const setupWorktree = vi.fn(async () => ({
      path: '/tmp/afk-wt/feat-spec',
      branch: 'feat-spec',
      cleanup: worktreeCleanup,
    }));
    vi.doMock('./commands/interactive/worktree.js', () => ({ setupWorktree }));

    // Override bootstrapSession to return totalTurns: 2
    vi.doMock('./commands/interactive/bootstrap.js', () => ({
      bootstrapSession: vi.fn(async () => ({
        session: { current: session },
        memoryStore: { close: vi.fn() },
        stats: {
          totalTurns: 2,
          totalCostUsd: 0,
          totalTokens: 0,
          totalDurationMs: 0,
          sessionStartTime: Date.now(),
          turnCosts: [],
          turnTokens: [],
          turns: [],
          model: 'sonnet',
          permissionMode: 'default',
        },
        statusLine,
        slashCtx: {
          ui: { repaintStatusLine },
        } as never,
        rl,
        options: { model: 'sonnet', maxTurns: '10', debug: false, worktree: 'feat-spec' },
        backgroundRegistry: { cancelAll: vi.fn(async () => undefined) },
      })),
    }));

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => code as never));

    const { Command } = await import('commander');
    const { registerInteractiveCommand } = await import('./commands/interactive.js');

    const program = new Command();
    registerInteractiveCommand(program);
    await program.parseAsync(['node', 'afk', 'interactive', '--worktree', 'feat-spec']);
    await new Promise((resolve) => setImmediate(resolve));

    expect(worktreeCleanup).toHaveBeenCalledTimes(1);
    expect(worktreeCleanup).toHaveBeenCalledWith({ force: false });
  });
});

describe('interactive signal-handler wiring (PR #486)', () => {
  // Closes the integration-coverage gap on session.abort() pre-aborts:
  // closure.test.ts exercises session.abort() in isolation, but does NOT
  // verify that interactive.ts actually CALLS abort() from its SIGINT,
  // SIGTERM, SIGHUP handlers. Deleting any of the three pre-abort lines
  // in interactive.ts must fail one of these tests.

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Drive parseAsync through the natural exit path with a spy on
   * process.on capturing the three signal handlers as they are
   * installed. Returns the captured handlers + the session.abort spy.
   *
   * The action installs handlers AFTER bootstrapSession resolves and
   * BEFORE awaiting runReplLoop, so by the time runReplLoop's mock
   * fires `rl.emit('close')` the handlers are recorded. Cleanups then
   * remove them from `process` itself, but our captured function
   * references are still callable.
   */
  async function captureSignalHandlers(): Promise<{
    abortSpy: ReturnType<typeof vi.fn>;
    handlers: Map<string, (...args: unknown[]) => void>;
  }> {
    const cleanupFns: Array<() => Promise<void>> = [];
    const spinner = {
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      text: '',
    };
    spinner.start.mockReturnValue(spinner);

    const rl = new EventEmitter() as EventEmitter & { close(): void };
    rl.close = () => { rl.emit('close'); };

    const statusLine = { start: vi.fn(), stop: vi.fn() };
    const abortSpy = vi.fn();
    const session = {
      close: vi.fn(async () => undefined),
      interrupt: vi.fn(async () => undefined),
      abort: abortSpy,
    };
    const transcript = {
      path: vi.fn(() => '/tmp/session.md'),
      appendEnded: vi.fn(async () => undefined),
    };
    const repaintStatusLine = vi.fn();

    vi.doMock('ora', () => ({ default: vi.fn(() => spinner) }));
    vi.doMock('./render.js', () => ({
      welcomeBanner: vi.fn(() => 'WELCOME'),
      divider: vi.fn((label: string) => label),
    }));
    vi.doMock('../utils/cleanupRegistry.js', () => ({
      registerCleanup: vi.fn((fn: () => Promise<void>) => {
        cleanupFns.push(fn);
        return () => undefined;
      }),
      runCleanupFunctions: vi.fn(async () => {
        await Promise.all(cleanupFns.map((fn) => fn()));
      }),
    }));
    vi.doMock('./shared-helpers.js', () => ({
      getModel: vi.fn(() => 'sonnet'),
      getApiKey: vi.fn(() => undefined),
      getApiKeyForModel: vi.fn(() => undefined),
    }));
    vi.doMock('./session-store.js', () => ({ saveSession: vi.fn() }));
    vi.doMock('./commands/interactive/transcript.js', () => ({
      initTranscript: vi.fn(async () => transcript),
    }));
    vi.doMock('./commands/interactive/repl-loop.js', () => ({
      runReplLoop: vi.fn(async () => { rl.emit('close'); }),
    }));
    vi.doMock('./commands/interactive/bootstrap.js', () => ({
      bootstrapSession: vi.fn(async () => ({
        session: { current: session },
        memoryStore: { close: vi.fn() },
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
          permissionMode: 'default',
        },
        statusLine,
        slashCtx: { ui: { repaintStatusLine } } as never,
        rl,
        options: { model: 'sonnet', maxTurns: '10', debug: false },
        backgroundRegistry: { cancelAll: vi.fn(async () => undefined) },
      })),
    }));

    // Capture the three signal handlers as they're registered.
    // Invariant: interactive.ts MUST register on plain string event
    // names 'SIGINT', 'SIGTERM', 'SIGHUP' for these tests to catch the
    // wiring. The capture happens via process.on spy — the action's
    // own removeListener cleanups don't affect our stored function refs.
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const realOn = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'SIGINT' || event === 'SIGTERM' || event === 'SIGHUP') {
        handlers.set(event, listener);
      }
      return realOn(event as never, listener as never);
    }) as never);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => code as never) as never);

    const { Command } = await import('commander');
    const { registerInteractiveCommand } = await import('./commands/interactive.js');
    const program = new Command();
    registerInteractiveCommand(program);
    await program.parseAsync(['node', 'afk', 'interactive']);
    await new Promise((resolve) => setImmediate(resolve));

    // Neuter side-effects that would fire when we invoke the captured
    // handlers below. The natural exit path has already completed; without
    // these guards, ctx.rl.close() inside SIGTERM/SIGHUP would re-emit
    // 'close' (calling process.exit again in a microtask), and the
    // handlers' 2s setTimeout grace would later call process.exit
    // after vitest has restored its exit detector — both manifest as
    // unhandled-rejection failures even though the test assertions
    // themselves pass.
    rl.removeAllListeners('close');
    rl.close = vi.fn();
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (() => ({ unref: () => undefined })) as never,
    );

    return { abortSpy, handlers };
  }

  it('SIGTERM handler calls session.abort("sigterm") before rl.close', async () => {
    const { abortSpy, handlers } = await captureSignalHandlers();
    abortSpy.mockClear(); // ignore any prior calls along the natural exit path

    const handler = handlers.get('SIGTERM');
    expect(handler).toBeDefined();
    handler!();

    expect(abortSpy).toHaveBeenCalledWith('sigterm');
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('SIGHUP handler calls session.abort("sighup") before rl.close', async () => {
    const { abortSpy, handlers } = await captureSignalHandlers();
    abortSpy.mockClear();

    const handler = handlers.get('SIGHUP');
    expect(handler).toBeDefined();
    handler!();

    expect(abortSpy).toHaveBeenCalledWith('sighup');
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('SIGINT handler calls session.abort("sigint") on the second press within the exit window', async () => {
    const { abortSpy, handlers } = await captureSignalHandlers();
    abortSpy.mockClear();

    const handler = handlers.get('SIGINT');
    expect(handler).toBeDefined();
    // First press: arms the exit window, prints the "press again" hint,
    // and MUST NOT call abort (the first press is a soft prompt).
    handler!();
    expect(abortSpy).not.toHaveBeenCalled();

    // Second press within 1500ms: fires the abort.
    handler!();
    expect(abortSpy).toHaveBeenCalledWith('sigint');
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });

  it('SIGTERM handler is idempotent — repeated signals do not re-abort', async () => {
    const { abortSpy, handlers } = await captureSignalHandlers();
    abortSpy.mockClear();

    const handler = handlers.get('SIGTERM');
    handler!();
    handler!();
    handler!();

    // sigtermInFlight guard inside interactive.ts blocks re-entry,
    // and AgentSession.abort itself short-circuits on already-aborted —
    // both layers cooperate to keep this at exactly one call.
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledWith('sigterm');
  });
});

/**
 * Regression guard for issue #166: path-approval grant wiring for
 * OpenAI-compatible providers.
 *
 * Before the fix, `bootstrapSession` gated the grant-wiring block on
 * `instanceof AnthropicDirectProvider`, so any OpenAI-compatible provider
 * (GPT-4o, local vLLM, etc.) left `pathApprovalGrantRef.current` undefined
 * and path-approval failed open silently.
 *
 * The fix replaces the `instanceof` check with a structural `isGrantManager`
 * guard so any provider exposing the four GrantManager methods gets wired —
 * regardless of its concrete class.
 */
describe('interactive bootstrap — path-approval grant wiring for OpenAI-compatible providers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A minimal provider stub that satisfies both the ModelProvider duck-type
   * the bootstrap expects AND the GrantManager interface, but without
   * opening any real resources (no SQLite, no HTTP connections).
   */
  function makeOpenAICompatStub() {
    const readRoots: string[] = [];
    return {
      // GrantManager surface — the methods isGrantManager checks for
      addReadRoot: vi.fn((absPath: string) => { readRoots.push(absPath); }),
      addWriteRoot: vi.fn(),
      revokeRoot: vi.fn(),
      getGrants: vi.fn(() => ({
        resolveBase: undefined,
        readRoots: [...readRoots],
        writeRoots: [],
        allowAll: false,
      })),
      // ModelProvider minimum surface bootstrap touches before the wiring block
      close: vi.fn(),
    };
  }

  /**
   * Helper that wires all mocks needed for bootstrapSession to reach the grant-
   * wiring block. `pathApprovalGrantRef` is the observable bundle returned by the
   * mock hook registry — its `.current` must be set to `stub` by bootstrap when
   * `stub` passes the isGrantManager check.
   */
  function applyGrantWiringMocks(
    stub: ReturnType<typeof makeOpenAICompatStub>,
    pathApprovalGrantRef: { current: unknown },
  ) {
    const rl = { on: vi.fn(), close: vi.fn() };
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.doMock('node:readline', () => ({ createInterface: vi.fn(() => rl) }));
    vi.doMock('../agent/session.js', () => ({
      AgentSession: class MockAgentSession {
        close = vi.fn(async () => undefined);
        interrupt = vi.fn(async () => undefined);
      },
    }));
    vi.doMock('../agent/default-hook-registry.js', () => ({
      createDefaultHookRegistry: vi.fn(() => ({
        registry: {},
        memoryStore: { close: vi.fn() },
        pathApprovalGrantRef,
      })),
    }));
    vi.doMock('../agent/memory/index.js', () => ({
      MemoryStore: vi.fn(() => ({ close: vi.fn() })),
      injectHotMemory: vi.fn((config: unknown) => config),
      memoryToolSchemas: [],
      MEMORY_TOOL_NAMES: [],
      createMemoryHandlers: vi.fn(() => new Map()),
    }));
    // Mock shared-helpers — BUT keep isGrantManager real and parseProvider
    // returning the OpenAI-compatible stub so the wiring block fires.
    vi.doMock('./shared-helpers.js', () => ({
      parseThinking: vi.fn(() => undefined),
      parseEffort: vi.fn(() => undefined),
      parseMaxOutputTokens: vi.fn(() => undefined),
      // parseProvider returns our stub — this causes the memoized factory to
      // build stub as startupProvider, which then passes isGrantManager.
      parseProvider: vi.fn(() => stub),
      getApiKey: vi.fn(() => 'test-key'),
      getApiKeyForModel: vi.fn(() => 'test-key'),
      getModel: vi.fn(() => 'sonnet'),
      getThinking: vi.fn(() => undefined),
      getEffort: vi.fn(() => undefined),
      getMaxOutputTokens: vi.fn(() => undefined),
      getDefaultSubagentModel: vi.fn(() => 'sonnet'),
      findClaudeExecutable: vi.fn(() => '/usr/bin/claude'),
      loadSystemPrompt: vi.fn(() => undefined),
      loadConfigSystemPrompt: vi.fn(() => undefined),
      resolveBaseSystemPrompt: vi.fn(() => ({ prompt: undefined, source: 'none' })),
      // isGrantManager is the guard under test — keep the real structural check.
      isGrantManager: (p: unknown): boolean => {
        if (p === null || typeof p !== 'object') return false;
        const obj = p as Record<string, unknown>;
        return (
          typeof obj['addReadRoot'] === 'function' &&
          typeof obj['addWriteRoot'] === 'function' &&
          typeof obj['revokeRoot'] === 'function' &&
          typeof obj['getGrants'] === 'function'
        );
      },
    }));
    vi.doMock('./status-line.js', () => ({
      StatusLine: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), repaint: vi.fn() })),
    }));
    vi.doMock('./slash/index.js', () => ({ registerAll: vi.fn() }));
    vi.doMock('./slash/writer.js', () => ({
      createConsoleWriter: vi.fn(() => ({
        line: vi.fn(), raw: vi.fn(), success: vi.fn(),
        info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      })),
    }));
  }

  it('wires pathApprovalGrantRef when the startup provider implements GrantManager (OpenAI-compat path)', async () => {
    const stub = makeOpenAICompatStub();
    // Observable ref for pathApprovalGrantRef — bootstrap must set .current to stub.
    const pathApprovalGrantRef: { current: unknown } = { current: undefined };
    applyGrantWiringMocks(stub, pathApprovalGrantRef);

    // Use importActual to bypass any cached mock for bootstrap — other tests
    // in this file register vi.doMock('./commands/interactive/bootstrap.js', ...)
    // which persists in the mock registry and would shadow the real import.
    const { bootstrapSession } = await vi.importActual<typeof import('./commands/interactive/bootstrap.js')>('./commands/interactive/bootstrap.js');
    await bootstrapSession({ model: 'gpt-4o', maxTurns: '10' });

    // pathApprovalGrantRef.current must be set to the GrantManager stub.
    // This test FAILS on origin/main (instanceof AnthropicDirectProvider check
    // skips the wiring block for non-Anthropic providers) and PASSES after fix.
    expect(pathApprovalGrantRef.current).toBe(stub);
  });

  it('does NOT set pathApprovalGrantRef.current when the startup provider lacks GrantManager methods', async () => {
    // A stub that has close() but NONE of the four GrantManager methods.
    const noGrantsStub = { close: vi.fn() } as unknown as ReturnType<typeof makeOpenAICompatStub>;
    const pathApprovalGrantRef: { current: unknown } = { current: undefined };
    applyGrantWiringMocks(noGrantsStub, pathApprovalGrantRef);

    const { bootstrapSession } = await vi.importActual<typeof import('./commands/interactive/bootstrap.js')>('./commands/interactive/bootstrap.js');
    await bootstrapSession({ model: 'gpt-4o', maxTurns: '10' });

    // pathApprovalGrantRef.current must remain undefined — the no-grants stub
    // fails isGrantManager, so the else-warn branch fires instead.
    expect(pathApprovalGrantRef.current).toBeUndefined();
  });
});
