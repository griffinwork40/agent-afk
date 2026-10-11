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
  const mockBotStart = vi.fn(async () => {});
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
}));
vi.mock('../paths.js', () => ({
  getEnvConfigPath: vi.fn(() => '/tmp/test-afk.env'),
  getStateDatabasePath: vi.fn(() => '/tmp/test-state.db'),
}));
vi.mock('../cli/shared-helpers.js', () => ({ loadSystemPrompt: vi.fn(() => 'base prompt') }));
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

beforeEach(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  // Reset env to working defaults before each test.
  mockEnv.TELEGRAM_BOT_TOKEN = 'test-token:abc';
  mockEnv.AFK_TELEGRAM_ALLOWED_CHAT_IDS = '111';
  mockBotStart.mockReset().mockResolvedValue(undefined);
  mockBotStop.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
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
    mockEnv.TELEGRAM_BOT_TOKEN = undefined as unknown as string;
    const { main } = await import('./entry.js');
    await main();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits 1 when allowedChatIds is empty', async () => {
    const allowlist = await import('./allowlist.js');
    vi.mocked(allowlist.parseAllowedChatIds).mockReturnValueOnce(new Set());
    const { main } = await import('./entry.js');
    await main();
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
    const { main } = await import('./entry.js');
    await main();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('entry.ts — main() happy path', () => {
  test('constructs TelegramBot and calls bot.start()', async () => {
    mockBotCtor.mockClear();
    mockBotStart.mockClear();
    const { main } = await import('./entry.js');
    // Immediately trigger SIGINT to stop the infinite run after start.
    mockBotStart.mockImplementationOnce(async () => {
      process.emit('SIGINT');
    });
    await main();
    expect(mockBotCtor).toHaveBeenCalled();
    expect(mockBotStart).toHaveBeenCalledTimes(1);
  });

  test('exits 1 when bot.start() throws', async () => {
    mockBotStart.mockRejectedValueOnce(new Error('telegraf error'));
    const { main } = await import('./entry.js');
    await main();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('warns but continues when daemonVersion is UNKNOWN_VERSION', async () => {
    const daemonVersion = await import('./daemon-version.js');
    vi.mocked(daemonVersion.readDiskVersion).mockReturnValueOnce('__unknown__');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockBotStart.mockImplementationOnce(async () => { process.emit('SIGINT'); });
    const { main } = await import('./entry.js');
    await main();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('version drift'));
    warnSpy.mockRestore();
  });

  test('uses bot identity username as handle when available', async () => {
    const wizard = await import('./setup-wizard.js');
    vi.mocked(wizard.validateBotToken).mockResolvedValueOnce({ id: 99, username: 'mybot', firstName: 'My' });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockBotStart.mockImplementationOnce(async () => { process.emit('SIGINT'); });
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
    mockBotStart.mockImplementationOnce(async () => { process.emit('SIGINT'); });
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
    mockBotStart.mockImplementationOnce(async () => { process.emit('SIGINT'); });
    const { main } = await import('./entry.js');
    await main();
    const joined = logSpy.mock.calls.flat().join(' ');
    expect(joined).toContain('Tag-only');
    logSpy.mockRestore();
  });

  test('SIGTERM triggers shutdown (process.exit(0))', async () => {
    mockBotStart.mockImplementationOnce(async () => { process.emit('SIGTERM'); });
    const { main } = await import('./entry.js');
    await main();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
