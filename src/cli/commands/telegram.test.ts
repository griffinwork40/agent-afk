/**
 * Tests for `afk telegram` CLI command group.
 *
 * Exercises subcommand registration, argument validation, all start/stop/
 * status/restart/logs/setup/check-token/discover-chat/set-allowed-chat paths,
 * error and refusal paths, and output formatting — all backed by fully-mocked
 * collaborator modules.  No real Telegram API is ever contacted, no real bot
 * token is read or printed, and no filesystem writes escape os.tmpdir().
 *
 * Pattern mirrors service.test.ts: vi.mock the modules with side-effects,
 * drive the CLI through a Commander instance with program.exitOverride(), and
 * spy on console.log / console.error / process.stdout.write to assert output.
 *
 * @module cli/commands/telegram.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the SUT import so vi.mock hoisting fires.
// ---------------------------------------------------------------------------

// Mock palette so chalk side-effects are removed; functions are identity so
// output content is still assertable.
vi.mock('../palette.js', () => ({
  palette: {
    success: (s: string) => s,
    warning: (s: string) => s,
    error: (s: string) => s,
    meta: (s: string) => s,
    info: (s: string) => s,
    heading: (s: string) => s,
    dim: (s: string) => s,
  },
}));

// Hoist the mock factory functions so they can be customised per-test.
const { mockStart, mockStop, mockStatus } = vi.hoisted(() => ({
  mockStart: vi.fn(),
  mockStop: vi.fn(),
  mockStatus: vi.fn(),
}));

vi.mock('../../telegram/manager.js', () => ({
  start: mockStart,
  stop: mockStop,
  status: mockStatus,
}));

const { mockRunTelegramSetup, mockCheckTokenFromFile, mockDiscoverChatFromFile } = vi.hoisted(
  () => ({
    mockRunTelegramSetup: vi.fn(),
    mockCheckTokenFromFile: vi.fn(),
    mockDiscoverChatFromFile: vi.fn(),
  }),
);

vi.mock('../../telegram/setup-wizard.js', () => ({
  runTelegramSetup: mockRunTelegramSetup,
  checkTokenFromFile: mockCheckTokenFromFile,
  discoverChatFromFile: mockDiscoverChatFromFile,
}));

// upsertEnvVar is imported via auth-wizard which re-exports from utils/envFile.
const { mockUpsertEnvVar } = vi.hoisted(() => ({ mockUpsertEnvVar: vi.fn() }));

vi.mock('../auth-wizard.js', () => ({
  upsertEnvVar: mockUpsertEnvVar,
}));

// getEnvConfigPath must return a predictable, tmp-scoped path.
const MOCK_ENV_PATH = join(tmpdir(), 'afk-test-telegram-env');

vi.mock('../../paths.js', () => ({
  getEnvConfigPath: () => MOCK_ENV_PATH,
  getAfkStateDir: () => join(tmpdir(), 'afk-state'),
  getLogsDir: () => join(tmpdir(), 'afk-logs'),
}));

// Mock errorMessage so we control what's in error strings.
vi.mock('../../utils/errors.js', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

// Mock child_process.spawn to prevent real tail invocations.
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

// Mock fs so we control existsSync / readFileSync without touching disk.
const { mockExistsSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

// SUT imported AFTER all mocks.
import { registerTelegramCommand } from './telegram.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerTelegramCommand(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(['node', 'afk', ...args]);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let logs: string[];
let errors: string[];
let stdoutWrites: string[];

beforeEach(() => {
  logs = [];
  errors = [];
  stdoutWrites = [];

  // Reset all mock call counts/implementations between tests so state from
  // one test does not leak into the next (vi.restoreAllMocks only resets spies).
  vi.clearAllMocks();

  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as (code?: number) => never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Subcommand registration
// ---------------------------------------------------------------------------

describe('registerTelegramCommand — subcommand registration', () => {
  it('registers a "telegram" command', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('telegram');
  });

  it('registers expected subcommands under telegram', () => {
    const program = buildProgram();
    const telegram = program.commands.find((c) => c.name() === 'telegram')!;
    const subNames = telegram.commands.map((c) => c.name());
    expect(subNames).toContain('setup');
    expect(subNames).toContain('start');
    expect(subNames).toContain('stop');
    expect(subNames).toContain('status');
    expect(subNames).toContain('restart');
    expect(subNames).toContain('logs');
    expect(subNames).toContain('check-token');
    expect(subNames).toContain('discover-chat');
    expect(subNames).toContain('set-allowed-chat');
  });
});

// ---------------------------------------------------------------------------
// afk telegram setup
// ---------------------------------------------------------------------------

describe('afk telegram setup', () => {
  it('calls runTelegramSetup and exits successfully on success', async () => {
    mockRunTelegramSetup.mockResolvedValue(undefined);
    await run(['telegram', 'setup']);
    expect(mockRunTelegramSetup).toHaveBeenCalledOnce();
  });

  it('prints error and exits(1) when runTelegramSetup throws', async () => {
    mockRunTelegramSetup.mockRejectedValue(new Error('network error'));
    await expect(run(['telegram', 'setup'])).rejects.toThrow('process.exit called');
    expect(errors.some((e) => e.includes('Setup failed'))).toBe(true);
    expect(errors.some((e) => e.includes('network error'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// afk telegram check-token
// ---------------------------------------------------------------------------

describe('afk telegram check-token', () => {
  it('writes JSON result to stdout when token is valid', async () => {
    mockCheckTokenFromFile.mockResolvedValue({
      set: true,
      valid: true,
      username: 'mybot',
      botId: 99,
    });
    await run(['telegram', 'check-token']);
    expect(mockCheckTokenFromFile).toHaveBeenCalledWith(MOCK_ENV_PATH);
    const written = stdoutWrites.join('');
    const parsed = JSON.parse(written.trim());
    expect(parsed).toMatchObject({ set: true, valid: true, username: 'mybot', botId: 99 });
  });

  it('writes JSON result to stdout when token is not set', async () => {
    mockCheckTokenFromFile.mockResolvedValue({ set: false, valid: false, reason: 'unset' });
    await run(['telegram', 'check-token']);
    const written = stdoutWrites.join('');
    const parsed = JSON.parse(written.trim());
    expect(parsed).toMatchObject({ set: false, valid: false, reason: 'unset' });
  });

  it('writes JSON result to stdout on network error (result, not throw)', async () => {
    mockCheckTokenFromFile.mockResolvedValue({ set: true, valid: false, reason: 'network' });
    await run(['telegram', 'check-token']);
    const parsed = JSON.parse(stdoutWrites.join('').trim());
    expect(parsed.reason).toBe('network');
  });

  it('never prints the token itself in stdout output', async () => {
    mockCheckTokenFromFile.mockResolvedValue({ set: true, valid: true, username: 'bot', botId: 1 });
    await run(['telegram', 'check-token']);
    const allOutput = [...logs, ...errors, ...stdoutWrites].join('\n');
    // The mock env path may contain "token" in the path variable name; check
    // that no realistic token-shaped string leaked.
    expect(allOutput).not.toMatch(/\b[0-9]{8,}:[A-Za-z0-9_-]{20,}/);
  });
});

// ---------------------------------------------------------------------------
// afk telegram discover-chat
// ---------------------------------------------------------------------------

describe('afk telegram discover-chat', () => {
  it('writes JSON result with default 60s timeout', async () => {
    mockDiscoverChatFromFile.mockResolvedValue({ found: false, chats: [] });
    await run(['telegram', 'discover-chat']);
    expect(mockDiscoverChatFromFile).toHaveBeenCalledWith(MOCK_ENV_PATH, { timeoutSec: 60 });
    const parsed = JSON.parse(stdoutWrites.join('').trim());
    expect(parsed).toMatchObject({ found: false, chats: [] });
  });

  it('passes a custom --timeout-sec value', async () => {
    mockDiscoverChatFromFile.mockResolvedValue({ found: true, chats: [{ chatId: 111, name: 'Alice' }] });
    await run(['telegram', 'discover-chat', '--timeout-sec', '30']);
    expect(mockDiscoverChatFromFile).toHaveBeenCalledWith(MOCK_ENV_PATH, { timeoutSec: 30 });
  });

  it('exits(2) and prints error when --timeout-sec is zero', async () => {
    await expect(run(['telegram', 'discover-chat', '--timeout-sec', '0'])).rejects.toThrow(
      'process.exit called',
    );
    expect(errors.some((e) => e.includes('--timeout-sec must be a positive integer'))).toBe(true);
  });

  it('exits(2) and prints error when --timeout-sec is negative', async () => {
    await expect(run(['telegram', 'discover-chat', '--timeout-sec', '-5'])).rejects.toThrow(
      'process.exit called',
    );
    expect(errors.some((e) => e.includes('--timeout-sec must be a positive integer'))).toBe(true);
  });

  it('exits(2) when --timeout-sec is not a number', async () => {
    await expect(run(['telegram', 'discover-chat', '--timeout-sec', 'abc'])).rejects.toThrow(
      'process.exit called',
    );
    expect(errors.some((e) => e.includes('--timeout-sec must be a positive integer'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// afk telegram set-allowed-chat
// ---------------------------------------------------------------------------

describe('afk telegram set-allowed-chat', () => {
  it('persists a valid chat ID and emits {ok:true}', async () => {
    await run(['telegram', 'set-allowed-chat', '123456789']);
    expect(mockUpsertEnvVar).toHaveBeenCalledWith(
      MOCK_ENV_PATH,
      'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
      '123456789',
    );
    const parsed = JSON.parse(stdoutWrites.join('').trim());
    expect(parsed).toMatchObject({ ok: true, path: MOCK_ENV_PATH });
  });

  it('emits {ok:false, reason:"invalid-chat-id"} and exits(2) for a non-numeric chat ID', async () => {
    await expect(run(['telegram', 'set-allowed-chat', 'notanumber'])).rejects.toThrow(
      'process.exit called',
    );
    const parsed = JSON.parse(stdoutWrites.join('').trim());
    expect(parsed).toMatchObject({ ok: false, reason: 'invalid-chat-id' });
    expect(mockUpsertEnvVar).not.toHaveBeenCalled();
  });

  it('emits {ok:false} for an empty string chat ID', async () => {
    await expect(run(['telegram', 'set-allowed-chat', ''])).rejects.toThrow('process.exit called');
    const parsed = JSON.parse(stdoutWrites.join('').trim());
    expect(parsed.ok).toBe(false);
  });

  it('accepts a negative chat ID (group chats have negative IDs)', async () => {
    await run(['telegram', 'set-allowed-chat', '-1001234567890']);
    expect(mockUpsertEnvVar).toHaveBeenCalledWith(
      MOCK_ENV_PATH,
      'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
      '-1001234567890',
    );
    const parsed = JSON.parse(stdoutWrites.join('').trim());
    expect(parsed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// afk telegram start
// ---------------------------------------------------------------------------

describe('afk telegram start — kind=started', () => {
  it('prints success message with PID and log file', async () => {
    mockStart.mockResolvedValue({ kind: 'started', pid: 1234, logFile: '/tmp/telegram.log' });
    await run(['telegram', 'start']);
    expect(logs.some((l) => l.includes('Bot started'))).toBe(true);
    expect(logs.some((l) => l.includes('1234'))).toBe(true);
    expect(logs.some((l) => l.includes('/tmp/telegram.log'))).toBe(true);
  });
});

describe('afk telegram start — kind=already-running', () => {
  it('logs a warning and exits(1)', async () => {
    mockStart.mockResolvedValue({ kind: 'already-running', message: 'Bot is already running (PID 999)' });
    await expect(run(['telegram', 'start'])).rejects.toThrow('process.exit called');
    expect(logs.some((l) => l.includes('already running') || l.includes('Bot is already running'))).toBe(true);
  });
});

describe('afk telegram start — kind=exited-immediately (no log tail)', () => {
  it('prints error and exits(1)', async () => {
    mockStart.mockResolvedValue({ kind: 'exited-immediately', message: 'Bot exited immediately', logTail: [] });
    await expect(run(['telegram', 'start'])).rejects.toThrow('process.exit called');
    expect(errors.some((e) => e.includes('exited immediately') || e.includes('Bot exited immediately'))).toBe(true);
  });
});

describe('afk telegram start — kind=exited-immediately (with log tail)', () => {
  it('prints log tail lines in addition to the error', async () => {
    mockStart.mockResolvedValue({
      kind: 'exited-immediately',
      message: 'Bot exited immediately',
      logTail: ['Error: token invalid', 'at bot.js:12'],
    });
    await expect(run(['telegram', 'start'])).rejects.toThrow('process.exit called');
    const allErrors = errors.join('\n');
    expect(allErrors).toContain('Error: token invalid');
    expect(allErrors).toContain('at bot.js:12');
  });
});

describe('afk telegram start — kind=spawn-failed', () => {
  it('prints error and exits(1)', async () => {
    mockStart.mockResolvedValue({ kind: 'spawn-failed', message: 'Failed to spawn' });
    await expect(run(['telegram', 'start'])).rejects.toThrow('process.exit called');
    expect(errors.some((e) => e.includes('Failed to spawn'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// afk telegram stop
// ---------------------------------------------------------------------------

describe('afk telegram stop', () => {
  it('logs "not running" warning when kind=not-running', async () => {
    mockStop.mockResolvedValue({ kind: 'not-running' });
    await run(['telegram', 'stop']);
    expect(logs.some((l) => l.includes('not running'))).toBe(true);
  });

  it('logs success when kind=stopped', async () => {
    mockStop.mockResolvedValue({ kind: 'stopped', pid: 2222 });
    await run(['telegram', 'stop']);
    expect(logs.some((l) => l.includes('Bot stopped') && l.includes('2222'))).toBe(true);
  });

  it('logs force-killed warning when kind=force-killed', async () => {
    mockStop.mockResolvedValue({ kind: 'force-killed', pid: 3333 });
    await run(['telegram', 'stop']);
    expect(logs.some((l) => l.includes('force-killed') && l.includes('3333'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// afk telegram restart
// ---------------------------------------------------------------------------

describe('afk telegram restart', () => {
  it('stops and restarts, logging PID on success', async () => {
    mockStop.mockResolvedValue({ kind: 'stopped', pid: 100 });
    mockStart.mockResolvedValue({ kind: 'started', pid: 200, logFile: '/tmp/telegram.log' });
    await run(['telegram', 'restart']);
    expect(logs.some((l) => l.includes('100'))).toBe(true);
    expect(logs.some((l) => l.includes('restarted') && l.includes('200'))).toBe(true);
  });

  it('proceeds to start even when stop says not-running', async () => {
    mockStop.mockResolvedValue({ kind: 'not-running' });
    mockStart.mockResolvedValue({ kind: 'started', pid: 300, logFile: '/tmp/telegram.log' });
    await run(['telegram', 'restart']);
    expect(logs.some((l) => l.includes('restarted'))).toBe(true);
  });

  it('exits(1) and prints error when restart start fails', async () => {
    mockStop.mockResolvedValue({ kind: 'stopped', pid: 100 });
    mockStart.mockResolvedValue({ kind: 'spawn-failed', message: 'spawn error' });
    await expect(run(['telegram', 'restart'])).rejects.toThrow('process.exit called');
    expect(errors.some((e) => e.includes('Restart failed') || e.includes('spawn error'))).toBe(true);
  });

  it('logs stopped PID when stop returns force-killed', async () => {
    mockStop.mockResolvedValue({ kind: 'force-killed', pid: 555 });
    mockStart.mockResolvedValue({ kind: 'started', pid: 666, logFile: '/tmp/t.log' });
    await run(['telegram', 'restart']);
    // "Stopped (PID 555)" should appear
    expect(logs.some((l) => l.includes('555'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// afk telegram status
// ---------------------------------------------------------------------------

describe('afk telegram status — stopped', () => {
  it('renders "Stopped" for a non-running bot', async () => {
    mockStatus.mockReturnValue({
      running: false,
      pidFile: '/tmp/afk-state/telegram/bot.pid',
      logFile: '/tmp/afk-logs/telegram.log',
    });
    await run(['telegram', 'status']);
    expect(logs.some((l) => l.includes('Stopped'))).toBe(true);
    expect(logs.some((l) => l.includes('/tmp/afk-logs/telegram.log'))).toBe(true);
  });
});

describe('afk telegram status — running with uptime and memory', () => {
  it('renders PID, uptime, memory, and log tail', async () => {
    mockStatus.mockReturnValue({
      running: true,
      pid: 4242,
      uptimeSec: 130,
      memoryMb: 64,
      pidFile: '/tmp/afk-state/telegram/bot.pid',
      logFile: '/tmp/afk-logs/telegram.log',
      logTail: ['INFO: bot ready', 'INFO: listening'],
    });
    await run(['telegram', 'status']);
    const allLogs = logs.join('\n');
    expect(allLogs).toContain('4242');
    expect(allLogs).toContain('64 MB');
    expect(allLogs).toContain('bot ready');
    expect(allLogs).toContain('listening');
  });
});

describe('afk telegram status — running without optional fields', () => {
  it('renders without crashing when uptimeSec and memoryMb are undefined', async () => {
    mockStatus.mockReturnValue({
      running: true,
      pid: 1,
      pidFile: '/tmp/bot.pid',
      logFile: '/tmp/telegram.log',
    });
    await run(['telegram', 'status']);
    expect(logs.some((l) => l.includes('Running'))).toBe(true);
  });
});

describe('afk telegram status — logTail rendering', () => {
  it('does not render "Recent log entries" section when logTail is empty', async () => {
    mockStatus.mockReturnValue({
      running: false,
      pidFile: '/tmp/bot.pid',
      logFile: '/tmp/telegram.log',
      logTail: [],
    });
    await run(['telegram', 'status']);
    expect(logs.every((l) => !l.includes('Recent log entries'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// afk telegram logs
// ---------------------------------------------------------------------------

describe('afk telegram logs — no log file', () => {
  it('prints warning when log file does not exist', async () => {
    mockStatus.mockReturnValue({
      running: false,
      pidFile: '/tmp/bot.pid',
      logFile: '/tmp/telegram.log',
    });
    mockExistsSync.mockReturnValue(false);
    await run(['telegram', 'logs']);
    expect(logs.some((l) => l.includes('No log file'))).toBe(true);
    expect(logs.some((l) => l.includes('Start the bot first'))).toBe(true);
  });
});

describe('afk telegram logs — file exists, no --follow', () => {
  it('reads and prints the last N lines of the log file', async () => {
    mockStatus.mockReturnValue({
      running: false,
      pidFile: '/tmp/bot.pid',
      logFile: '/tmp/telegram.log',
    });
    mockExistsSync.mockReturnValue(true);
    const logContent = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    mockReadFileSync.mockReturnValue(logContent);
    await run(['telegram', 'logs', '-n', '5']);
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe('afk telegram logs — --follow flag', () => {
  it('spawns tail -f when --follow is set', async () => {
    mockStatus.mockReturnValue({
      running: false,
      pidFile: '/tmp/bot.pid',
      logFile: '/tmp/telegram.log',
    });
    mockExistsSync.mockReturnValue(true);
    const fakeChild = { on: vi.fn() };
    mockSpawn.mockReturnValue(fakeChild);
    await run(['telegram', 'logs', '--follow']);
    expect(mockSpawn).toHaveBeenCalledWith(
      'tail',
      expect.arrayContaining(['-f', '/tmp/telegram.log']),
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('registers an error handler on the spawned child', async () => {
    mockStatus.mockReturnValue({
      running: false,
      pidFile: '/tmp/bot.pid',
      logFile: '/tmp/telegram.log',
    });
    mockExistsSync.mockReturnValue(true);
    const fakeChild = { on: vi.fn() };
    mockSpawn.mockReturnValue(fakeChild);
    await run(['telegram', 'logs', '-f']);
    expect(fakeChild.on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('logs spawn error message when tail child emits "error"', async () => {
    mockStatus.mockReturnValue({
      running: false,
      pidFile: '/tmp/bot.pid',
      logFile: '/tmp/telegram.log',
    });
    mockExistsSync.mockReturnValue(true);
    let capturedHandler: ((e: Error) => void) | undefined;
    const fakeChild = {
      on: vi.fn((_event: string, handler: (e: Error) => void) => {
        capturedHandler = handler;
      }),
    };
    mockSpawn.mockReturnValue(fakeChild);
    await run(['telegram', 'logs', '--follow']);
    expect(capturedHandler).toBeDefined();
    capturedHandler!(new Error('ENOENT'));
    expect(errors.some((e) => e.includes('ENOENT') || e.includes('Failed to spawn tail'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatUptime — exercised indirectly through afk telegram status
// ---------------------------------------------------------------------------

describe('formatUptime — all branches via status rendering', () => {
  const cases: Array<[number, RegExp]> = [
    [30, /30s/],
    [90, /1m 30s/],
    [3690, /1h 1m/],
    [90061, /1d 1h/],
  ];

  for (const [uptimeSec, pattern] of cases) {
    it(`formats ${uptimeSec}s as ${pattern}`, async () => {
      mockStatus.mockReturnValue({
        running: true,
        pid: 1,
        uptimeSec,
        pidFile: '/tmp/bot.pid',
        logFile: '/tmp/telegram.log',
      });
      await run(['telegram', 'status']);
      expect(logs.some((l) => pattern.test(l))).toBe(true);
    });
  }
});
