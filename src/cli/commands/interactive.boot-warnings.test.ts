/**
 * Regression: bootstrap warnings must survive the interactive startup screen
 * clear (#745).
 *
 * The startup clear is `\x1b[3J\x1b[2J\x1b[H`. `\x1b[3J` is Erase Saved Lines
 * — it wipes the terminal's SCROLLBACK, not just the viewport — so anything
 * written before it is unrecoverable, even by scrolling up. `bootstrapSession`
 * is awaited BEFORE that clear in the same `.action()` callback, so any producer
 * inside bootstrap that printed straight to stdout/stderr was silently erased.
 *
 * That erased class included the agent-registry built-in-shadow warning, which
 * is a safety signal: a `~/.afk/agents/research-agent.md` declaring broader
 * `tools:` converts the read-only verifier that bundled skills dispatch by bare
 * name into a write-capable agent. The fix routes such producers into
 * `ctx.bootWarnings` and drains them after the clear.
 *
 * Two exits out of bootstrap must both surface the buffer: the success path
 * drains after the clear, and the abort path drains in `interactive.ts`'s catch
 * before `handleCommandError` exits (see the `bootstrap abort path` block).
 *
 * These tests assert ORDER — that the warning bytes are written AFTER the clear
 * escape — via `mock.invocationCallOrder`, the same technique
 * `interactive-lifecycle.test.ts` uses for the clearScreen/compositor ordering.
 * Per `docs/scrollback.md`, mock-stdout tests can prove bytes were WRITTEN and
 * in what order, but cannot prove they reached a real terminal's scrollback;
 * the PTY scenario (`tests/pty/scenarios.ts`) covers visibility.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Mutable mocks controlled per test
// ---------------------------------------------------------------------------

const mockBootstrapSession = vi.fn();
const mockRunReplLoop = vi.fn();
// Stands in for the real `never`-returning handler, which calls process.exit.
// Throwing instead makes the abort path observable AND preserves the property
// the drain ordering depends on: nothing after this call runs.
const mockHandleCommandError = vi.fn((err: unknown): never => {
  throw err instanceof Error ? err : new Error(String(err));
});

// ---------------------------------------------------------------------------
// Mocks — hoisted above imports. Mirrors interactive.resume.test.ts's thin
// surface: we need the real `interactive.ts` action to run from bootstrap
// through the clear and the pre-arm print block, then stop before the REPL.
// ---------------------------------------------------------------------------

vi.mock('./interactive/bootstrap.js', () => ({
  get bootstrapSession() { return mockBootstrapSession; },
}));

vi.mock('./interactive/repl-loop.js', () => ({
  get runReplLoop() { return mockRunReplLoop; },
}));

vi.mock('./interactive/boot-prune.js', () => ({
  bootPruneWorktrees: vi.fn().mockResolvedValue({ ran: false, removedCount: 0 }),
}));

vi.mock('./interactive/worktree.js', () => ({
  setupWorktree: vi.fn(),
}));

vi.mock('./interactive/worktree-autoname.js', () => ({
  runFirstTurnAutoname: vi.fn(),
}));

vi.mock('../resume-session.js', () => ({
  resolveResumeTarget: vi.fn(() => undefined),
  resumeConfigFor: vi.fn(() => ({})),
  saveCurrentSession: vi.fn(),
}));

vi.mock('../shared-helpers.js', () => ({
  getApiKey: vi.fn(() => 'test-key'),
  getModel: vi.fn(() => 'sonnet'),
  getThinking: vi.fn(() => undefined),
  getEffort: vi.fn(() => undefined),
  getMaxOutputTokens: vi.fn(() => undefined),
  getMaxToolUseIterations: vi.fn(() => undefined),
  loadSystemPrompt: vi.fn(() => undefined),
  loadConfigSystemPrompt: vi.fn(() => undefined),
  resolveBaseSystemPrompt: vi.fn(() => ({ prompt: undefined, source: 'none' })),
  parseThinking: vi.fn(() => undefined),
  parseEffort: vi.fn(() => undefined),
  parseMaxOutputTokens: vi.fn(() => undefined),
  parseProvider: vi.fn(() => undefined),
  parseThinkingUiMode: vi.fn(() => 'live'),
  getDefaultSubagentModel: vi.fn(() => 'sonnet'),
}));

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ interactive: {} })),
}));

vi.mock('../update-checker.js', () => ({
  printUpdateBanner: vi.fn(),
}));

vi.mock('../errors/index.js', () => ({
  get handleCommandError() { return mockHandleCommandError; },
}));

vi.mock('ora', () => ({
  default: vi.fn(() => {
    const inst = {
      text: '',
      start() { return inst; },
      stop() { return inst; },
      succeed() { return inst; },
      fail() { return inst; },
    };
    return inst;
  }),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { registerInteractiveCommand } from './interactive.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLEAR = '\x1b[3J\x1b[2J\x1b[H';

/**
 * Minimal InteractiveCtx stand-in: only the members `interactive.ts` touches
 * between `bootstrapSession` returning and `runReplLoop` being called.
 */
function makeCtx(bootWarnings: string[]): Record<string, unknown> {
  return {
    bootWarnings,
    stats: { model: 'sonnet', totalTurns: 0, permissionMode: 'default' },
    statusLine: { start: vi.fn(), stop: vi.fn(), repaint: vi.fn() },
    slashCtx: {
      ui: { repaintStatusLine: vi.fn() },
      getCompositor: () => undefined,
    },
    completionWriter: { fn: vi.fn(), line: vi.fn() },
    rl: { on: vi.fn(), close: vi.fn() },
    // `abort`/`interrupt` are required by the SIGINT/SIGTERM/SIGHUP handlers
    // `interactive.ts` installs before the clear — without them a stray signal
    // during teardown throws instead of unwinding.
    session: {
      current: {
        close: vi.fn(async () => undefined),
        abort: vi.fn(),
        interrupt: vi.fn(async () => undefined),
      },
    },
    memoryStore: { close: vi.fn() },
    backgroundRegistry: { list: vi.fn(() => []) },
    getInFlight: () => false,
    teardownTrustedSkillEvents: undefined,
    options: {},
  };
}

/**
 * Run the interactive action, capturing every stdout+stderr write in one
 * ordered list. Both streams share the terminal cursor, so ordering must be
 * evaluated across the two together — exactly why `interactive.ts` wraps both
 * when measuring `preArmAnchorRow`.
 */
async function runAndCapture(
  bootWarnings: string[],
  opts?: { failBootstrap?: Error },
): Promise<string[]> {
  // `interactive.ts` installs SIGINT/SIGTERM/SIGHUP handlers before the clear
  // and unregisters them only via its cleanup path, which never runs here (we
  // short-circuit at runReplLoop). Snapshot the pre-existing listeners so the
  // caller can restore them and each run doesn't leak a handler onto `process`.
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const priorListeners = new Map(
    signals.map((s) => [s, [...process.listeners(s)]] as const),
  );
  const writes: string[] = [];
  const record = (chunk: unknown): boolean => {
    writes.push(String(chunk));
    return true;
  };
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(record);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(record);
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    writes.push(a.map(String).join(' '));
  });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    writes.push(a.map(String).join(' '));
  });

  if (opts?.failBootstrap !== undefined) {
    // Reproduces the real abort shape: producers push into the CALLER-owned
    // bucket (`extras.bootWarnings`), and only then does bootstrap throw — e.g.
    // an MCP config warning collected just before `McpManager.fromConfig`
    // rejects on an `alwaysLoad` server. No ctx is ever returned, so the
    // post-clear drain is unreachable by construction.
    const failure = opts.failBootstrap;
    mockBootstrapSession.mockImplementation(
      async (_options: unknown, extras?: { bootWarnings?: string[] }) => {
        for (const w of bootWarnings) extras?.bootWarnings?.push(w);
        throw failure;
      },
    );
  } else {
    mockBootstrapSession.mockResolvedValue(makeCtx(bootWarnings));
  }
  // Stop the boot chain right after the pre-arm print block.
  mockRunReplLoop.mockRejectedValue(new Error('test-shortcircuit'));

  try {
    const program = new Command();
    program.exitOverride();
    registerInteractiveCommand(program);
    await program.parseAsync(['node', 'afk', 'interactive']);
  } catch {
    // `runReplLoop` rejection is the intended stop signal.
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    // Drop handlers this run added; restore exactly the prior set.
    for (const s of signals) {
      process.removeAllListeners(s);
      for (const fn of priorListeners.get(s) ?? []) {
        process.on(s, fn as (...args: unknown[]) => void);
      }
    }
  }
  return writes;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('afk interactive — bootstrap warnings survive the startup clear (#745)', () => {
  beforeEach(() => {
    mockBootstrapSession.mockReset();
    mockRunReplLoop.mockReset();
    // `mockClear`, not `mockReset` — the throwing implementation must survive.
    mockHandleCommandError.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('emits an agent-registry built-in-shadow warning AFTER the screen clear', async () => {
    const warning =
      '[afk] agents: ~/.afk/agents/research-agent.md overrides built-in agent "research-agent"' +
      ' — the built-in restricts its tools and gates bash to read-only commands;' +
      ' the override replaces both';

    const writes = await runAndCapture([warning]);

    const clearIdx = writes.findIndex((w) => w.includes(CLEAR));
    const warnIdx = writes.findIndex((w) => w.includes('overrides built-in agent'));

    expect(clearIdx).toBeGreaterThanOrEqual(0);   // the clear did happen
    expect(warnIdx).toBeGreaterThanOrEqual(0);    // the warning was emitted at all
    // The whole bug: written before the clear === destroyed, scrollback included.
    expect(warnIdx).toBeGreaterThan(clearIdx);
    // Content must survive intact, not be summarized away — the operator needs
    // the agent name and the tools-restriction clause to act on it.
    expect(writes[warnIdx]).toContain('research-agent');
    expect(writes[warnIdx]).toContain('read-only');
  });

  it('routes MCP bootstrap warnings through the same post-clear path', async () => {
    const writes = await runAndCapture(['[mcp] server "foo": unknown key "cmd"']);

    const clearIdx = writes.findIndex((w) => w.includes(CLEAR));
    const mcpIdx = writes.findIndex((w) => w.includes('[mcp]'));

    expect(mcpIdx).toBeGreaterThanOrEqual(0);
    expect(mcpIdx).toBeGreaterThan(clearIdx);
  });

  it('emits each warning exactly once (no double-emission)', async () => {
    const writes = await runAndCapture(['[mcp] duplicated?']);
    const hits = writes.filter((w) => w.includes('duplicated?'));
    expect(hits).toHaveLength(1);
  });

  it('prints nothing extra when bootstrap produced no warnings', async () => {
    const writes = await runAndCapture([]);
    expect(writes.some((w) => w.includes('[mcp]'))).toBe(false);
    expect(writes.some((w) => w.includes('overrides built-in agent'))).toBe(false);
    // The clear still runs — this asserts absence of noise, not absence of boot.
    expect(writes.some((w) => w.includes(CLEAR))).toBe(true);
  });

  it('drains the buffer so a later re-read cannot reprint stale warnings', async () => {
    const bootWarnings = ['[mcp] transient'];
    await runAndCapture(bootWarnings);
    // interactive.ts empties the array in place after printing; the REPL loop
    // and any later reader must see nothing left to emit.
    expect(bootWarnings).toHaveLength(0);
  });

  /**
   * Regression found in review of PR #751: the post-clear drain sits ~360 lines
   * after the `bootstrapSession` await. When bootstrap THROWS, `ctx` is never
   * assigned and `handleCommandError` exits the process, so every warning
   * buffered before the throw was destroyed — silently, with no clear to blame.
   *
   * That was a strict regression, not an inherited gap: before #751 these
   * producers wrote to stderr the moment they fired, and the abort path never
   * reaches the clear, so the diagnostic stayed on screen next to the failure
   * it explained. The fix hoists the buffer into `interactive.ts` and drains it
   * in the catch, which is why these tests exercise the CALLER-owned bucket.
   */
  describe('bootstrap abort path', () => {
    it('emits warnings buffered before a bootstrap failure', async () => {
      const writes = await runAndCapture(
        ['[mcp] server "foo": unknown key "cmd"'],
        { failBootstrap: new Error('mcp server "foo" (alwaysLoad) failed to connect') },
      );

      // `handleCommandError` is mocked to throw, mirroring the real `never`
      // return: if these bytes are present at all, they were written BEFORE the
      // process would have exited. Presence is the ordering proof on this path.
      expect(writes.some((w) => w.includes('unknown key "cmd"'))).toBe(true);
      // Proves we actually went down the abort path rather than succeeding.
      expect(mockHandleCommandError).toHaveBeenCalledTimes(1);
    });

    it('never reaches the screen clear, so immediate emission is safe', async () => {
      const writes = await runAndCapture(['[mcp] pre-throw'], {
        failBootstrap: new Error('boom'),
      });
      // `\x1b[3J` is the only reason buffering was needed in the first place.
      // It does not run here, so nothing erases the drained warning — and no
      // second drain exists on this path to double-print it.
      expect(writes.some((w) => w.includes(CLEAR))).toBe(false);
      expect(writes.filter((w) => w.includes('pre-throw'))).toHaveLength(1);
    });

    it('prints nothing when bootstrap fails before any producer ran', async () => {
      const writes = await runAndCapture([], { failBootstrap: new Error('bad --model') });
      // Absence of noise: the drain must add no header or blank line of its own
      // to the far more common "bad flag" failure.
      expect(writes.some((w) => w.includes('[mcp]'))).toBe(false);
      expect(mockHandleCommandError).toHaveBeenCalledTimes(1);
    });
  });
});
