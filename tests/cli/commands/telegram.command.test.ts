/**
 * Unit tests for `src/cli/commands/telegram.ts` (COV-008).
 *
 * Strategy: mock all side-effecting imports (telegram/manager,
 * telegram/setup-wizard, cli/auth-wizard, paths, fs, child_process) so
 * every Commander action handler can be driven via parseAsync without
 * touching the real Telegram API, PID files, or filesystem.
 * process.exit is intercepted to prevent the test process from dying.
 *
 * Per POSIX guard R4: no test is gated on `process.platform`. All I/O is
 * mocked.
 */

import { Command } from 'commander';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — hoisted before any SUT import.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const start = vi.fn();
  const stop = vi.fn();
  const status = vi.fn();
  const runTelegramSetup = vi.fn();
  const checkTokenFromFile = vi.fn();
  const discoverChatFromFile = vi.fn();
  const upsertEnvVar = vi.fn();
  const getEnvConfigPath = vi.fn(() => '/fake/.afk/config/afk.env');
  const existsSync = vi.fn(() => false);
  const readFileSync = vi.fn(() => 'line1\nline2\nline3');
  const spawn = vi.fn(() => ({ on: vi.fn() }));

  return {
    start, stop, status, runTelegramSetup,
    checkTokenFromFile, discoverChatFromFile, upsertEnvVar,
    getEnvConfigPath, existsSync, readFileSync, spawn,
  };
});

vi.mock('../../../src/telegram/manager.js', () => ({
  start: mocks.start,
  stop: mocks.stop,
  status: mocks.status,
}));

vi.mock('../../../src/telegram/setup-wizard.js', () => ({
  runTelegramSetup: mocks.runTelegramSetup,
  checkTokenFromFile: mocks.checkTokenFromFile,
  discoverChatFromFile: mocks.discoverChatFromFile,
}));

vi.mock('../../../src/cli/auth-wizard.js', () => ({
  upsertEnvVar: mocks.upsertEnvVar,
}));

vi.mock('../../../src/paths.js', () => ({
  getEnvConfigPath: mocks.getEnvConfigPath,
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: mocks.existsSync, readFileSync: mocks.readFileSync };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: mocks.spawn };
});

vi.mock('../../../src/cli/palette.js', () => ({
  palette: {
    success: (s: string) => s,
    error: (s: string) => s,
    warning: (s: string) => s,
    meta: (s: string) => s,
    info: (s: string) => s,
    dim: (s: string) => s,
    heading: (s: string) => s,
  },
}));

vi.mock('../../../src/utils/errors.js', () => ({
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// SUT imported after mocks.
import { registerTelegramCommand } from '../../../src/cli/commands/telegram.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let logLines: string[] = [];
let errLines: string[] = [];
let exitSpy: ReturnType<typeof vi.spyOn>;

function makeProgram(): Command {
  const prog = new Command();
  prog.exitOverride();
  registerTelegramCommand(prog);
  return prog;
}

/** Minimal BotStatus snapshot. */
const stoppedStatus = {
  running: false,
  pidFile: '/fake/.afk/state/telegram/bot.pid',
  logFile: '/fake/.afk/logs/telegram.log',
};

const runningStatus = {
  running: true,
  pid: 4567,
  uptimeSec: 90,
  memoryMb: 42,
  pidFile: '/fake/.afk/state/telegram/bot.pid',
  logFile: '/fake/.afk/logs/telegram.log',
  logTail: ['INFO starting'],
};

beforeEach(() => {
  logLines = [];
  errLines = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    logLines.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    errLines.push(args.join(' '));
  });
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(
    (_code?: number | string | null) => undefined as never,
  );
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  vi.clearAllMocks();

  // Default mock returns.
  mocks.status.mockReturnValue(stoppedStatus);
  mocks.start.mockResolvedValue({ kind: 'started', pid: 4567, logFile: '/fake/telegram.log' });
  mocks.stop.mockResolvedValue({ kind: 'stopped', pid: 4567 });
  mocks.getEnvConfigPath.mockReturnValue('/fake/.afk/config/afk.env');
  mocks.existsSync.mockReturnValue(false);
  mocks.readFileSync.mockReturnValue('line1\nline2\nline3');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// telegram setup
// ---------------------------------------------------------------------------

describe('telegram setup', () => {
  it('calls runTelegramSetup and resolves cleanly', async () => {
    mocks.runTelegramSetup.mockResolvedValue(undefined);
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'setup'], { from: 'user' });
    expect(mocks.runTelegramSetup).toHaveBeenCalled();
  });

  it('prints error and exits 1 when setup throws', async () => {
    mocks.runTelegramSetup.mockRejectedValue(new Error('network error'));
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'setup'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errLines.join('\n')).toContain('network error');
  });
});

// ---------------------------------------------------------------------------
// telegram check-token
// ---------------------------------------------------------------------------

describe('telegram check-token', () => {
  it('writes JSON result to stdout', async () => {
    const result = { set: true, valid: true, username: 'mybot', botId: 123 };
    mocks.checkTokenFromFile.mockResolvedValue(result);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'check-token'], { from: 'user' });
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(written.trim());
    expect(parsed).toMatchObject({ set: true, valid: true });
    expect(mocks.checkTokenFromFile).toHaveBeenCalledWith('/fake/.afk/config/afk.env');
  });
});

// ---------------------------------------------------------------------------
// telegram discover-chat
// ---------------------------------------------------------------------------

describe('telegram discover-chat', () => {
  it('writes JSON result to stdout with default timeout', async () => {
    const result = { found: true, chats: [{ id: 9999, username: 'user' }] };
    mocks.discoverChatFromFile.mockResolvedValue(result);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'discover-chat'], { from: 'user' });
    expect(mocks.discoverChatFromFile).toHaveBeenCalledWith(
      '/fake/.afk/config/afk.env',
      expect.objectContaining({ timeoutSec: 60 }),
    );
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(JSON.parse(written.trim())).toMatchObject({ found: true });
  });

  it('respects --timeout-sec option', async () => {
    mocks.discoverChatFromFile.mockResolvedValue({ found: false, chats: [] });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'discover-chat', '--timeout-sec', '30'], { from: 'user' });
    expect(mocks.discoverChatFromFile).toHaveBeenCalledWith(
      '/fake/.afk/config/afk.env',
      expect.objectContaining({ timeoutSec: 30 }),
    );
  });

  it('exits 2 when --timeout-sec is not a positive integer', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'discover-chat', '--timeout-sec', 'bad'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(errLines.join('\n')).toContain('--timeout-sec');
  });

  it('exits 2 when --timeout-sec is zero', async () => {
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'discover-chat', '--timeout-sec', '0'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

// ---------------------------------------------------------------------------
// telegram set-allowed-chat
// ---------------------------------------------------------------------------

describe('telegram set-allowed-chat', () => {
  it('persists the chat ID and writes JSON ok result', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'set-allowed-chat', '12345'], { from: 'user' });
    expect(mocks.upsertEnvVar).toHaveBeenCalledWith(
      '/fake/.afk/config/afk.env',
      'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
      '12345',
    );
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(JSON.parse(written.trim())).toMatchObject({ ok: true });
  });

  it('exits 2 when chatId is not a finite integer', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'set-allowed-chat', 'notanumber'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(2);
    // The JSON line is the first complete JSON object written
    const jsonLine = writes.find((w) => w.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    expect(JSON.parse(jsonLine!.trim())).toMatchObject({ ok: false, reason: 'invalid-chat-id' });
  });
});

// ---------------------------------------------------------------------------
// telegram start
// ---------------------------------------------------------------------------

describe('telegram start', () => {
  it('prints success when bot starts', async () => {
    mocks.start.mockResolvedValue({ kind: 'started', pid: 4567, logFile: '/fake/telegram.log' });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'start'], { from: 'user' });
    const all = logLines.join('\n');
    expect(all).toContain('Bot started');
    expect(all).toContain('4567');
    expect(all).toContain('Tail with');
  });

  it('exits 1 with warning when already running', async () => {
    mocks.start.mockResolvedValue({ kind: 'already-running', message: 'Bot is already running (PID 1111)' });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'start'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logLines.join('\n')).toContain('already running');
  });

  it('exits 1 with error when bot exits immediately', async () => {
    mocks.start.mockResolvedValue({
      kind: 'exited-immediately',
      message: 'Bot exited immediately',
      logTail: ['Error: no token'],
    });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'start'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    const all = errLines.join('\n');
    expect(all).toContain('exited immediately');
    expect(all).toContain('Last log entries');
  });

  it('exits 1 with error for generic failure', async () => {
    mocks.start.mockResolvedValue({ kind: 'error', message: 'spawn failed' });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'start'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errLines.join('\n')).toContain('spawn failed');
  });

  it('handles exited-immediately with empty logTail gracefully', async () => {
    mocks.start.mockResolvedValue({
      kind: 'exited-immediately',
      message: 'Bot exited immediately',
      logTail: [],
    });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'start'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// telegram stop
// ---------------------------------------------------------------------------

describe('telegram stop', () => {
  it('prints success when stopped', async () => {
    mocks.stop.mockResolvedValue({ kind: 'stopped', pid: 4567 });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'stop'], { from: 'user' });
    expect(logLines.join('\n')).toContain('Bot stopped');
  });

  it('warns (no exit) when not running', async () => {
    mocks.stop.mockResolvedValue({ kind: 'not-running' });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'stop'], { from: 'user' });
    expect(logLines.join('\n')).toContain('not running');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('warns about force-kill', async () => {
    mocks.stop.mockResolvedValue({ kind: 'force-killed', pid: 4567 });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'stop'], { from: 'user' });
    expect(logLines.join('\n')).toContain('force-killed');
  });
});

// ---------------------------------------------------------------------------
// telegram restart
// ---------------------------------------------------------------------------

describe('telegram restart', () => {
  it('stop-then-start: prints restart success', async () => {
    mocks.stop.mockResolvedValue({ kind: 'stopped', pid: 4567 });
    mocks.start.mockResolvedValue({ kind: 'started', pid: 9999, logFile: '/fake/telegram.log' });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'restart'], { from: 'user' });
    const all = logLines.join('\n');
    expect(all).toContain('Stopped');
    expect(all).toContain('restarted');
  });

  it('exits 1 when start fails after stop', async () => {
    mocks.stop.mockResolvedValue({ kind: 'force-killed', pid: 4567 });
    mocks.start.mockResolvedValue({ kind: 'exited-immediately', message: 'failed' });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'restart'], { from: 'user' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errLines.join('\n')).toContain('Restart failed');
  });

  it('handles not-running stop result before start', async () => {
    mocks.stop.mockResolvedValue({ kind: 'not-running' });
    mocks.start.mockResolvedValue({ kind: 'started', pid: 9999, logFile: '/fake/telegram.log' });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'restart'], { from: 'user' });
    expect(logLines.join('\n')).toContain('restarted');
  });
});

// ---------------------------------------------------------------------------
// telegram status
// ---------------------------------------------------------------------------

describe('telegram status', () => {
  it('renders stopped status', async () => {
    mocks.status.mockReturnValue(stoppedStatus);
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'status'], { from: 'user' });
    const all = logLines.join('\n');
    expect(all).toContain('Stopped');
    expect(all).toContain(stoppedStatus.pidFile);
    expect(all).toContain(stoppedStatus.logFile);
  });

  it('renders running status with uptime and memory', async () => {
    mocks.status.mockReturnValue(runningStatus);
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'status'], { from: 'user' });
    const all = logLines.join('\n');
    expect(all).toContain('Running');
    expect(all).toContain('4567');
    expect(all).toContain('1m 30s'); // formatUptime(90)
    expect(all).toContain('42 MB');
  });

  it('renders log tail when present', async () => {
    mocks.status.mockReturnValue(runningStatus);
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'status'], { from: 'user' });
    expect(logLines.join('\n')).toContain('INFO starting');
  });

  it('does not show log tail header when logTail is empty', async () => {
    mocks.status.mockReturnValue({ ...stoppedStatus, logTail: [] });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'status'], { from: 'user' });
    expect(logLines.join('\n')).not.toContain('Recent log entries');
  });
});

// ---------------------------------------------------------------------------
// telegram logs
// ---------------------------------------------------------------------------

describe('telegram logs', () => {
  it('warns when log file does not exist', async () => {
    mocks.status.mockReturnValue(stoppedStatus);
    mocks.existsSync.mockReturnValue(false);
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'logs'], { from: 'user' });
    expect(logLines.join('\n')).toContain('No log file');
  });

  it('prints trailing lines when log exists', async () => {
    mocks.status.mockReturnValue(stoppedStatus);
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue('a\nb\nc\nd\ne');
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'logs'], { from: 'user' });
    expect(logLines.join('\n')).toContain('a');
  });

  it('spawns tail -f when --follow is given', async () => {
    mocks.status.mockReturnValue(stoppedStatus);
    mocks.existsSync.mockReturnValue(true);
    const onFn = vi.fn();
    mocks.spawn.mockReturnValue({ on: onFn });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'logs', '--follow'], { from: 'user' });
    expect(mocks.spawn).toHaveBeenCalledWith(
      'tail',
      expect.arrayContaining(['-f']),
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });
});

// ---------------------------------------------------------------------------
// formatUptime — covered via 'telegram status' exercising all branches.
// ---------------------------------------------------------------------------

describe('formatUptime branch coverage via status', () => {
  it('shows seconds-only for uptime < 60s', async () => {
    mocks.status.mockReturnValue({ ...runningStatus, uptimeSec: 45 });
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'status'], { from: 'user' });
    expect(logLines.join('\n')).toContain('45s');
  });

  it('shows h m for uptime in hours', async () => {
    mocks.status.mockReturnValue({ ...runningStatus, uptimeSec: 3661 }); // 1h 1m 1s
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'status'], { from: 'user' });
    expect(logLines.join('\n')).toContain('1h');
  });

  it('shows d h for uptime in days', async () => {
    mocks.status.mockReturnValue({ ...runningStatus, uptimeSec: 90061 }); // >1 day
    const prog = makeProgram();
    await prog.parseAsync(['telegram', 'status'], { from: 'user' });
    expect(logLines.join('\n')).toMatch(/\d+d/);
  });
});
