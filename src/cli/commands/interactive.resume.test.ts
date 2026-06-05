/**
 * Tests for the early-validation guard in `afk interactive` (`afk i`):
 *   --resume <id> → bail before worktree setup when id is unknown
 *   --continue   → bail before worktree setup when no saved sessions exist
 *
 * The guard's whole purpose is to fail BEFORE any side effects (worktree
 * creation, screen clear, REPL boot). If `bootstrapSession` returns —
 * meaning the guard didn't short-circuit — the test setup is incomplete
 * because the full REPL boot path is heavy. We assert the bail happens
 * by checking `process.exitCode === 1` and that `bootstrapSession` was
 * never called.
 *
 * Mirrors the pattern in `chat.resume.test.ts` but with a thinner mock
 * surface: the guard runs before the heavyweight imports, so we only
 * need to silence what `registerInteractiveCommand` touches before the
 * guard (ora spinner, boot-prune, config loading).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Mutable mocks controlled per test
// ---------------------------------------------------------------------------

const mockResolveResumeTarget = vi.fn(
  () => undefined as ReturnType<typeof import('../resume-session.js')['resolveResumeTarget']>,
);
const mockBootstrapSession = vi.fn();

// ---------------------------------------------------------------------------
// Mocks — hoisted above imports
// ---------------------------------------------------------------------------

vi.mock('../resume-session.js', () => ({
  get resolveResumeTarget() { return mockResolveResumeTarget; },
  resumeConfigFor: vi.fn(() => ({})),
}));

vi.mock('./interactive/bootstrap.js', () => ({
  get bootstrapSession() { return mockBootstrapSession; },
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

vi.mock('../shared-helpers.js', () => ({
  getApiKey: vi.fn(() => 'test-key'),
  getModel: vi.fn(() => 'sonnet'),
  getThinking: vi.fn(() => undefined),
  getEffort: vi.fn(() => undefined),
  getMaxOutputTokens: vi.fn(() => undefined),
  loadSystemPrompt: vi.fn(() => undefined),
  loadConfigSystemPrompt: vi.fn(() => undefined),
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
  handleCommandError: vi.fn((err: unknown): never => {
    throw err instanceof Error ? err : new Error(String(err));
  }),
}));

// Silence the ora spinner so its stderr output doesn't pollute capture.
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
// Test helpers
// ---------------------------------------------------------------------------

async function runInteractive(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerInteractiveCommand(program);
  // The interactive command is the default — invoke explicitly so we
  // don't accidentally fall through to other registered subcommands.
  await program.parseAsync(['node', 'afk', 'interactive', ...args]);
}

/** Capture stderr output from fn(). */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await fn();
  } catch {
    // swallow — the guard's `return` is what we care about; other errors
    // from the (mocked) bootstrap path would mean the guard failed to
    // short-circuit and the test will fail on the assertions below.
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('afk interactive — early --resume / --continue validation guard', () => {
  beforeEach(() => {
    mockResolveResumeTarget.mockReturnValue(undefined);
    mockBootstrapSession.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  it('bails out before bootstrapSession when --resume id is unknown', async () => {
    // resolveResumeTarget returns a shell target without `stored` for unknown ids.
    mockResolveResumeTarget.mockReturnValue({ id: 'unknown-id', resumeId: 'unknown-id' });

    const stderr = await captureStderr(() =>
      runInteractive('--resume', 'unknown-id'),
    );

    expect(stderr).toContain('session not found');
    expect(stderr).toContain('"unknown-id"'); // JSON.stringify quotes the id
    expect(stderr).toContain('/resume');      // recovery hint present
    expect(process.exitCode).toBe(1);
    expect(mockBootstrapSession).not.toHaveBeenCalled();
  });

  it('bails out before bootstrapSession when --continue has no saved sessions', async () => {
    // resolveResumeTarget THROWS when `--continue` is set and listSessions()
    // is empty. The widened guard's try/catch must catch and surface this
    // before any worktree side-effect.
    mockResolveResumeTarget.mockImplementation(() => {
      throw new Error('No saved sessions found for --continue. Run a session first or use /save.');
    });

    const stderr = await captureStderr(() =>
      runInteractive('--continue'),
    );

    expect(stderr).toContain('No saved sessions found');
    expect(stderr).toContain('/resume'); // recovery hint present
    expect(process.exitCode).toBe(1);
    expect(mockBootstrapSession).not.toHaveBeenCalled();
  });

  it('escapes control bytes in --resume value via JSON.stringify', async () => {
    mockResolveResumeTarget.mockReturnValue({
      id: '\u001b[31m-evil',
      resumeId: '\u001b[31m-evil',
    });

    const stderr = await captureStderr(() =>
      runInteractive('--resume', '\u001b[31m-evil'),
    );

    // The raw ESC byte must not appear in stderr — sanitization escapes
    // it to the visible literal `\u001b` form.
    expect(stderr).not.toContain('\u001b[31m-evil');
    expect(stderr).toContain('\\u001b[31m-evil');
    expect(mockBootstrapSession).not.toHaveBeenCalled();
  });

  it('does not bail when no --resume or --continue flag is set', async () => {
    // The guard block is skipped entirely. bootstrapSession will be
    // called — we throw from the mock to abort the rest of the boot
    // chain before it tries to actually start a session.
    mockBootstrapSession.mockRejectedValue(new Error('test-shortcircuit'));

    await captureStderr(() => runInteractive());

    expect(mockBootstrapSession).toHaveBeenCalled();
    // No "session not found" exit from the guard.
    // (Bootstrap throw separately sets exitCode via handleCommandError.)
  });

  it('does not bail when --resume id IS found (stored populated)', async () => {
    mockResolveResumeTarget.mockReturnValue({
      id: 'my-session',
      resumeId: 'sdk-abc',
      stored: {
        sessionId: 'sdk-abc',
        model: 'sonnet',
        startedAt: 0,
        savedAt: 0,
        totalTurns: 1,
        totalCostUsd: 0,
        totalTokens: 0,
        totalDurationMs: 0,
        turns: [],
      },
    });
    mockBootstrapSession.mockRejectedValue(new Error('test-shortcircuit'));

    const stderr = await captureStderr(() =>
      runInteractive('--resume', 'my-session'),
    );

    // Guard didn't fire.
    expect(stderr).not.toContain('session not found');
    // Bootstrap was reached (then short-circuited by the mock throw).
    expect(mockBootstrapSession).toHaveBeenCalled();
  });
});
