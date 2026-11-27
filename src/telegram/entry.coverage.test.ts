/**
 * Coverage tests for src/telegram/entry.ts (COV-011).
 *
 * entry.ts owns:
 *   - installCrashHandlers() / _resetCrashHandlersForTest()
 *   - main() — the full startup + shutdown orchestration
 *
 * Strategy: mock every import that touches the network/FS/process and drive
 * main() through its logical branches (missing token, missing allowlist,
 * failed getMe, successful boot, bot.start() failure, shutdown signals).
 * No real network, no real timers, no real process.exit().
 */

import { describe, test, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any import that uses them.
// ---------------------------------------------------------------------------

const { mockBotCtor, mockBotStart, mockBotStop, mockGetStats } = vi.hoisted(() => {
  const mockBotStop = vi.fn(async () => {});
  const mockBotStart = vi.fn<() => Promise<{ polling: Promise<void> }>>();
  const mockGetStats = vi.fn(() => ({ running: false, activeSessions: 0, totalChats: 0 }));
  const mockBotCtor = vi.fn(function (this: Record<string, unknown>) {
    this.start = mockBotStart;
    this.stop = mockBotStop;
    this.getStats = mockGetStats;
  });
  return { mockBotCtor, mockBotStart, mockBotStop, mockGetStats };
});

vi.mock('./bot.js', () => ({ TelegramBot: mockBotCtor }));
vi.mock('./allowlist.js', () => ({ parseAllowedChatIds: vi.fn(() => new Set([111])) }));
vi.mock('./setup-wizard.js', () => ({
  validateBotToken: vi.fn(async () => ({ id: 42, username: 'testbot', firstName: 'Test' })),
}));
vi.mock('../agent/memory/index.js', () => ({ MemoryStore: vi.fn(function (this: Record<string, unknown>) { this.close = vi.fn(); }) }));
vi.mock('../agent/state/state-store.js', () => ({ StateStore: vi.fn(function (this: Record<string, unknown>) { this.close = vi.fn(); }) }));
vi.mock('../agent/providers/index.js', () => ({ providerForModel: vi.fn(() => 'anthropic') }));
vi.mock('../cli/config.js', () => ({
  loadConfig: vi.fn(() => ({ model: 'claude-sonnet-4-5', apiKey: 'sk-test' })),
  loadTelegramConfig: vi.fn(() => ({ tagOnlyChats: [] })),
  getOperatorPermissionMode: vi.fn(() => undefined),
}));
vi.mock('../paths.js', () => ({
  getEnvConfigPath: vi.fn(() => '/tmp/test-afk.env'),
  getStateDatabasePath: vi.fn(() => '/tmp/test-state.db'),
}));
vi.mock('../cli/shared-helpers.js', () => ({
  loadSystemPrompt: vi.fn(() => 'base prompt'),
  getThinking: vi.fn(() => undefined),
  getEffort: vi.fn(() => undefined),
}));
vi.mock('./env-file-overrides.js', () => ({ applyTelegramFileOverrides: vi.fn() }));
vi.mock('./credentials.js', () => ({
  planTelegramCredential: vi.fn(() => ({ kind: 'env', key: 'ANTHROPIC_API_KEY' })),
  applyTelegramCredentialPlan: vi.fn(() => true),
}));
vi.mock('../agent/auth/credential-resolver.js', () => ({
  preloadClaudeKeychainOAuth: vi.fn(async () => {}),
  loadAnthropicCredential: vi.fn(() => 'sk-test'),
}));
vi.mock('./daemon-version.js', () => ({
  readDiskVersion: vi.fn(() => '1.0.0'),
  UNKNOWN_VERSION: '__unknown__',
}));
vi.mock('./create-session.js', () => ({ createTelegramSessionFactory: vi.fn(() => vi.fn()) }));
vi.mock('./stats-ticker.js', () => ({ startStatsTicker: vi.fn(() => 42) }));  // returns interval id
vi.mock('./push.js', () => ({ pushIfConfigured: vi.fn(async () => {}) }));
vi.mock('../utils/crash-notifier.js', () => ({
  installCrashNotifier: vi.fn(() => ({ reset: vi.fn() })),
}));
vi.mock('../utils/errors.js', () => ({ errorMessage: vi.fn((e: unknown) => String(e)) }));
vi.mock('../service/version-skew.js', () => ({ writeServiceStartupSidecar: vi.fn(() => true) }));

// ---------------------------------------------------------------------------
// env mock — controls TELEGRAM_BOT_TOKEN etc.
// ---------------------------------------------------------------------------
const mockEnv: Record<string, string | undefined> = {
  TELEGRAM_BOT_TOKEN: 'test-token:abc',
  AFK_TELEGRAM_ALLOWED_CHAT_IDS: '111',
  TELEGRAM_VERBOSE: '',
  AFK_TELEGRAM_CWD: '',
  AFK_TELEGRAM_SESSION_IDLE_MS: '',
  AFK_TELEGRAM_TAG_ONLY_CHAT_IDS: '',
  TELEGRAM_DATA_DIR: '',
};
vi.mock('../config/env.js', () => ({ env: new Proxy({}, { get: (_t, k) => mockEnv[k as string] }) }));

// ---------------------------------------------------------------------------
// process.exit stub — captured per-test
// ---------------------------------------------------------------------------
let exitSpy: MockInstance;
let finishPolling: () => void;
let failPolling: (error: Error) => void;
let signalListeners: Map<'SIGINT' | 'SIGTERM', ReturnType<typeof process.listeners>>;

beforeEach(() => {
  // Each test imports a fresh entry module, never state left in the ESM cache.
  vi.resetModules();
  signalListeners = new Map(['SIGINT', 'SIGTERM'].map((signal) =>
    [signal as 'SIGINT' | 'SIGTERM', process.listeners(signal)]));
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  // Reset env to working defaults before each test.
  mockEnv.TELEGRAM_BOT_TOKEN = 'test-token:abc';
  mockEnv.AFK_TELEGRAM_ALLOWED_CHAT_IDS = '111';
  const polling = new Promise<void>((resolve, reject) => {
    finishPolling = resolve;
    failPolling = reject;
  });
  mockBotStart.mockReset().mockResolvedValue({ polling });
  mockBotStop.mockReset().mockImplementation(async () => { finishPolling(); });
});

afterEach(async () => {
  const { _resetCrashHandlersForTest } = await import('./entry.js');
  _resetCrashHandlersForTest();
  for (const [signal, original] of signalListeners) {
    for (const listener of process.listeners(signal)) {
      if (!original.includes(listener)) process.removeListener(signal, listener);
    }
  }
  exitSpy.mockRestore();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('entry.ts — installCrashHandlers', () => {
  test('is idempotent: calling twice does not install a second handler', async () => {
    const { installCrashHandlers, _resetCrashHandlersForTest } = await import('./entry.js');
    _resetCrashHandlersForTest();
    const { installCrashNotifier } = await import('../utils/crash-notifier.js');
    const spy = vi.mocked(installCrashNotifier);
    spy.mockClear();

    installCrashHandlers();
    installCrashHandlers(); // second call must be a no-op

    expect(spy).toHaveBeenCalledTimes(1);
    _resetCrashHandlersForTest();
  });

  test('_resetCrashHandlersForTest allows re-installation', async () => {
    const { installCrashHandlers, _resetCrashHandlersForTest } = await import('./entry.js');
    _resetCrashHandlersForTest();
    const { installCrashNotifier } = await import('../utils/crash-notifier.js');
    const spy = vi.mocked(installCrashNotifier);
    spy.mockClear();

    installCrashHandlers();
    _resetCrashHandlersForTest();
    installCrashHandlers();

    expect(spy).toHaveBeenCalledTimes(2);
    _resetCrashHandlersForTest();
  });
});

describe('entry.ts — main() early-exit branches', () => {
  test('exits 1 when TELEGRAM_BOT_TOKEN is missing', async () => {
    mockEnv.TELEGRAM_BOT_TOKEN = undefined;
    exitSpy.mockImplementationOnce((() => { throw new Error('exit:1'); }) as never);
    const { main } = await import('./entry.js');
    await expect(main()).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits 1 when allowedChatIds is empty', async () => {
    const allowlist = await import('./allowlist.js');
    vi.mocked(allowlist.parseAllowedChatIds).mockReturnValueOnce(new Set());
    exitSpy.mockImplementationOnce((() => { throw new Error('exit:1'); }) as never);
    const { main } = await import('./entry.js');
    await expect(main()).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits 1 when validateBotToken returns null', async () => {
    // validateBotToken is called AFTER identity is checked — null means
    // the bot token was rejected.  We need to mock it before calling main()
    // and ensure the process.exit(1) fires before the handle = identity.username
    // dereference (which only runs on success).
    const wizard = await import('./setup-wizard.js');
    vi.mocked(wizard.validateBotToken).mockResolvedValueOnce(null);
    // Also mock process.exit so the branch truly stops.
    exitSpy.mockImplementationOnce((() => { throw new Error('exit:1'); }) as never);
    const { main } = await import('./entry.js');
    await expect(main()).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockReset().mockImplementation((() => {}) as never);
  });

  test('exits 1 when loadConfig throws', async () => {
    const config = await import('../cli/config.js');
    vi.mocked(config.loadConfig).mockImplementationOnce(() => { throw new Error('bad config'); });
    // process.exit must stop execution so config.model dereference never runs.
    exitSpy.mockImplementationOnce((() => { throw new Error('exit:1'); }) as never);
    const { main } = await import('./entry.js');
    await expect(main()).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockReset().mockImplementation((() => {}) as never);
  });

  test('exits 1 when applyTelegramCredentialPlan returns false', async () => {
    const creds = await import('./credentials.js');
    vi.mocked(creds.applyTelegramCredentialPlan).mockReturnValueOnce(false);
    exitSpy.mockImplementationOnce((() => { throw new Error('exit:1'); }) as never);
    const { main } = await import('./entry.js');
    await expect(main()).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

function stopDuringStartup(signal: 'SIGINT' | 'SIGTERM') {
  return async () => {
    process.emit(signal);
    return { polling: Promise.resolve() };
  };
}

describe('entry.ts — main() happy path', () => {
  test('constructs TelegramBot and calls bot.start()', async () => {
    mockBotCtor.mockClear();
    mockBotStart.mockClear();
    const { main } = await import('./entry.js');
    const { writeServiceStartupSidecar } = await import('../service/version-skew.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const running = main();
      await vi.waitFor(() => expect(writeServiceStartupSidecar).toHaveBeenCalledWith('telegram', '1.0.0'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Bot started successfully!'));
      expect(mockBotStop).not.toHaveBeenCalled();
      process.emit('SIGINT');
      process.emit('SIGTERM');
      await running;
      expect(mockBotStop).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      log.mockRestore();
    }
    expect(mockBotCtor).toHaveBeenCalled();
    expect(mockBotStart).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  test('exits 1 when bot.start() throws', async () => {
    mockBotStart.mockRejectedValueOnce(new Error('telegraf error'));
    const { main } = await import('./entry.js');
    await main();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test.each(['rejects', 'resolves'] as const)('exits 1 when polling unexpectedly %s after startup', async (outcome) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { writeServiceStartupSidecar } = await import('../service/version-skew.js');
    const { main } = await import('./entry.js');
    try {
      const running = main();
      await vi.waitFor(() => expect(writeServiceStartupSidecar).toHaveBeenCalledOnce());
      if (outcome === 'rejects') failPolling(new Error('409 Conflict'));
      else finishPolling();
      await running;
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Telegram polling failed:'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(outcome === 'rejects' ? '409 Conflict' : 'stopped unexpectedly'));
      expect(mockBotStop).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      error.mockRestore();
    }
  });

  test('warns but continues when daemonVersion is UNKNOWN_VERSION', async () => {
    const daemonVersion = await import('./daemon-version.js');
    vi.mocked(daemonVersion.readDiskVersion).mockReturnValueOnce('__unknown__');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockBotStart.mockImplementationOnce(stopDuringStartup('SIGINT'));
    const { main } = await import('./entry.js');
    await main();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('version drift'));
    warnSpy.mockRestore();
  });

  test('uses bot identity username as handle when available', async () => {
    const wizard = await import('./setup-wizard.js');
    vi.mocked(wizard.validateBotToken).mockResolvedValueOnce({ id: 99, username: 'mybot', firstName: 'My' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockBotStart.mockImplementationOnce(stopDuringStartup('SIGINT'));
    const { main } = await import('./entry.js');
    await main();
    const joined = logSpy.mock.calls.flat().join(' ');
    expect(joined).toContain('@mybot');
    logSpy.mockRestore();
  });

  test('uses firstName as handle when username absent', async () => {
    const wizard = await import('./setup-wizard.js');
    vi.mocked(wizard.validateBotToken).mockResolvedValueOnce({ id: 99, firstName: 'NoUsername' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockBotStart.mockImplementationOnce(stopDuringStartup('SIGINT'));
    const { main } = await import('./entry.js');
    await main();
    const joined = logSpy.mock.calls.flat().join(' ');
    expect(joined).toContain('NoUsername');
    logSpy.mockRestore();
  });

  test('logs tag-only info when tagOnlyChats is non-empty', async () => {
    const allowlist = await import('./allowlist.js');
    // first call = allowedChatIds (111), second = tagOnlyChats (999)
    vi.mocked(allowlist.parseAllowedChatIds)
      .mockReturnValueOnce(new Set([111]))
      .mockReturnValueOnce(new Set([999]));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockBotStart.mockImplementationOnce(stopDuringStartup('SIGINT'));
    const { main } = await import('./entry.js');
    await main();
    const joined = logSpy.mock.calls.flat().join(' ');
    expect(joined).toContain('Tag-only');
    logSpy.mockRestore();
  });

  test('SIGTERM triggers shutdown (process.exit(0))', async () => {
    mockBotStart.mockImplementationOnce(stopDuringStartup('SIGTERM'));
    const { main } = await import('./entry.js');
    await main();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('process.on keeps both listeners after first signal fires', async () => {
    // Invariant: process.once would remove the listener on first delivery,
    // leaving a repeated SIGTERM with default action (process kill) during
    // pending teardown. process.on must keep both handlers alive until finally.
    const { main } = await import('./entry.js');
    const running = main();
    await vi.waitFor(() => expect(mockBotStart).toHaveBeenCalledTimes(1));

    const beforeSIGINT = process.listenerCount('SIGINT');
    const beforeSIGTERM = process.listenerCount('SIGTERM');

    // Emit SIGTERM — with process.once this would remove the SIGTERM listener.
    process.emit('SIGTERM');

    // Both counts must be unchanged: handlers are still registered.
    expect(process.listenerCount('SIGINT')).toBe(beforeSIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSIGTERM);

    await running;

    // After teardown, finally must have removed both.
    expect(process.listenerCount('SIGINT')).toBe(beforeSIGINT - 1);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSIGTERM - 1);
  });

  test('repeated same signal during teardown is absorbed by stopping guard', async () => {
    // A second SIGTERM while bot.stop() is in flight must not start a second
    // shutdown (bot.stop called once) and must not kill the process (handler
    // still registered via process.on).
    let releaseTeardown!: () => void;
    const teardownGate = new Promise<void>((res) => { releaseTeardown = res; });
    mockBotStop.mockReset().mockImplementation(async () => {
      finishPolling();
      await teardownGate;
    });

    const { main } = await import('./entry.js');
    const running = main();
    await vi.waitFor(() => expect(mockBotStart).toHaveBeenCalledTimes(1));

    process.emit('SIGTERM');                                     // first: starts shutdown
    await vi.waitFor(() => expect(mockBotStop).toHaveBeenCalledTimes(1));

    process.emit('SIGTERM');                                     // second: stopping guard absorbs it
    expect(mockBotStop).toHaveBeenCalledTimes(1);               // still exactly one call

    releaseTeardown();
    await running;
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  test('second signal during cleanup does not overwrite shutdownPromise; main() waits for teardown gate', async () => {
    // ??= keeps shutdownPromise pointing at the original pending promise when a
    // second signal fires while teardown is still running. Without it, the
    // stopping-guard's immediate return (a resolved Promise<void>) would
    // overwrite the pending one, making `await shutdownPromise` a no-op and
    // letting finally remove listeners before bot.stop() finishes.

    let releaseTeardown!: () => void;
    const teardownGate = new Promise<void>((res) => { releaseTeardown = res; });

    mockBotStop.mockReset().mockImplementation(async () => {
      finishPolling();    // schedules microtask: `await polling` resolves
      await teardownGate; // holds cleanup pending
    });

    const { main } = await import('./entry.js');
    const running = main();
    await vi.waitFor(() => expect(mockBotStart).toHaveBeenCalledTimes(1));

    // Emit both signals synchronously: SIGTERM's onSignal() completes its
    // assignment before SIGINT's onSignal() runs (process.emit is synchronous).
    process.emit('SIGTERM');
    process.emit('SIGINT');

    await vi.waitFor(() => expect(mockBotStop).toHaveBeenCalledTimes(1));
    // stopping guard absorbed SIGINT — bot.stop() called exactly once.
    expect(mockBotStop).toHaveBeenCalledTimes(1);

    // setImmediate drains the microtask queue and one full I/O tick.
    // If `await undefined` was a no-op (bug), process.exit would have already
    // fired before this point.
    let mainResolved = false;
    const raceHandle = running.then(() => { mainResolved = true; });
    await new Promise<void>((res) => setImmediate(res));
    expect(mainResolved).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();

    releaseTeardown();
    await raceHandle;
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  test('threads AFK_THINKING / AFK_EFFORT into TelegramBot constructor', async () => {
    // Arrange: return env-sourced thinking and effort from the shared-helpers mock.
    const helpers = await import('../cli/shared-helpers.js');
    vi.mocked(helpers.getThinking).mockReturnValueOnce({ type: 'enabled', budgetTokens: 8000 });
    vi.mocked(helpers.getEffort).mockReturnValueOnce('high');

    mockBotCtor.mockClear();
    mockBotStart.mockImplementationOnce(stopDuringStartup('SIGINT'));

    const { main } = await import('./entry.js');
    await main();

    expect(mockBotCtor).toHaveBeenCalledTimes(1);
    const ctorArg = mockBotCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(ctorArg.thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });
    expect(ctorArg.effort).toBe('high');
  });

  test('forwards permissionMode when getOperatorPermissionMode returns a value', async () => {
    const config = await import('../cli/config.js');
    vi.mocked(config.getOperatorPermissionMode).mockReturnValueOnce('default');
    mockBotCtor.mockClear();
    mockBotStart.mockImplementationOnce(stopDuringStartup('SIGINT'));
    const { main } = await import('./entry.js');
    await main();
    expect(mockBotCtor).toHaveBeenCalledTimes(1);
    const ctorArg = (mockBotCtor.mock.calls[0] as unknown[] | undefined)?.[0] as Record<string, unknown>;
    expect(ctorArg['permissionMode']).toBe('default');
  });

  test('omits permissionMode when getOperatorPermissionMode returns undefined', async () => {
    const config = await import('../cli/config.js');
    vi.mocked(config.getOperatorPermissionMode).mockReturnValueOnce(undefined);
    mockBotCtor.mockClear();
    mockBotStart.mockImplementationOnce(stopDuringStartup('SIGINT'));
    const { main } = await import('./entry.js');
    await main();
    expect(mockBotCtor).toHaveBeenCalledTimes(1);
    const ctorArg = (mockBotCtor.mock.calls[0] as unknown[] | undefined)?.[0] as Record<string, unknown>;
    expect(ctorArg).not.toHaveProperty('permissionMode');
  });
});
