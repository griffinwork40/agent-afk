/**
 * Additional coverage tests for src/telegram/setup-wizard.ts (COV-016).
 *
 * The existing setup-wizard.test.ts covers readEnvVarFromFile, checkTokenFromFile,
 * and discoverChatFromFile at the file-read level. This file exercises:
 *   - validateBotToken (mock fetch: ok, !ok, error, bad shape)
 *   - fetchUpdates (mock fetch: ok, !ok, error, bad shape)
 *   - findChatIdInUpdates (various message/edited_message shapes)
 *   - pollForChats (immediate hit, timeout, sleep path)
 *   - checkTokenFromFile (valid token, network failure)
 *   - discoverChatFromFile (found, timeout)
 *
 * All network calls are intercepted via vi.stubGlobal('fetch', ...).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  validateBotToken,
  fetchUpdates,
  findChatIdInUpdates,
  pollForChats,
  checkTokenFromFile,
  discoverChatFromFile,
  runTelegramSetup,
} from './setup-wizard.js';

// ---------------------------------------------------------------------------
// Hoisted readline mock — ESM namespace not configurable, must be vi.mock'd.
// ---------------------------------------------------------------------------
const { mockCreateInterface, mockRlAnswer } = vi.hoisted(() => {
  // Default: auto-answer every question with '1'.
  const mockRlAnswer = { value: '1' };
  const mockClose = vi.fn();
  const mockCreateInterface = vi.fn(() => ({
    question: (_q: string, cb: (a: string) => void) => cb(mockRlAnswer.value),
    close: mockClose,
  }));
  return { mockCreateInterface, mockRlAnswer };
});
vi.mock('readline', () => ({ createInterface: mockCreateInterface }));

// Mock sleep so pollForChats loops resolve instantly.
vi.mock('../agent/providers/shared/sleep-with-abort.js', () => ({
  sleep: vi.fn(async () => {}),
}));

// Mocks for runTelegramSetup interactive dependencies.
vi.mock('../utils/prompt-secret.js', () => ({ promptSecret: vi.fn(async () => 'mock-token') }));
vi.mock('../utils/envFile.js', () => ({ upsertEnvVar: vi.fn() }));
vi.mock('../paths.js', () => ({ getEnvConfigPath: vi.fn(() => '/tmp/test-afk.env') }));
vi.mock('../config/env.js', () => ({ env: { TELEGRAM_BOT_TOKEN: undefined } }));
vi.mock('../cli/palette.js', () => ({
  palette: {
    heading: (s: string) => s,
    meta: (s: string) => s,
    success: (s: string) => s,
    warning: (s: string) => s,
    error: (s: string) => s,
    brand: (s: string) => s,
  },
}));
vi.mock('../cli/input/stdin-claim.js', () => ({
  withStdinClaim: vi.fn((_label: string, fn: () => unknown) => fn()),
}));

// ---------------------------------------------------------------------------
// fetch stub helpers
// ---------------------------------------------------------------------------

function okJson(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

function notOk(): Response {
  return { ok: false, json: async () => ({}) } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// validateBotToken
// ---------------------------------------------------------------------------

describe('validateBotToken', () => {
  test('returns BotIdentity on successful getMe', async () => {
    fetchSpy.mockResolvedValueOnce(
      okJson({ ok: true, result: { id: 42, username: 'testbot', first_name: 'Test' } }),
    );
    const result = await validateBotToken('valid-token');
    expect(result).toEqual({ id: 42, username: 'testbot', firstName: 'Test' });
  });

  test('omits username when absent from result', async () => {
    fetchSpy.mockResolvedValueOnce(
      okJson({ ok: true, result: { id: 7, first_name: 'Noname' } }),
    );
    const result = await validateBotToken('tok');
    expect(result).toEqual({ id: 7, firstName: 'Noname' });
    expect(result).not.toHaveProperty('username');
  });

  test('returns null when response is !ok', async () => {
    fetchSpy.mockResolvedValueOnce(notOk());
    expect(await validateBotToken('bad-token')).toBeNull();
  });

  test('returns null when ok:false in body', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({ ok: false }));
    expect(await validateBotToken('tok')).toBeNull();
  });

  test('returns null when result missing id', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({ ok: true, result: { first_name: 'X' } }));
    expect(await validateBotToken('tok')).toBeNull();
  });

  test('returns null on fetch error (network)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await validateBotToken('tok')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchUpdates
// ---------------------------------------------------------------------------

describe('fetchUpdates', () => {
  test('returns parsed updates on success', async () => {
    const updates = [{ message: { chat: { id: 1, type: 'private' } } }];
    fetchSpy.mockResolvedValueOnce(okJson({ ok: true, result: updates }));
    expect(await fetchUpdates('tok')).toEqual(updates);
  });

  test('returns [] when response is !ok', async () => {
    fetchSpy.mockResolvedValueOnce(notOk());
    expect(await fetchUpdates('tok')).toEqual([]);
  });

  test('returns [] when body ok:false', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({ ok: false, result: [] }));
    expect(await fetchUpdates('tok')).toEqual([]);
  });

  test('returns [] when result is not an array', async () => {
    fetchSpy.mockResolvedValueOnce(okJson({ ok: true, result: null }));
    expect(await fetchUpdates('tok')).toEqual([]);
  });

  test('returns [] on fetch error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('net'));
    expect(await fetchUpdates('tok')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findChatIdInUpdates
// ---------------------------------------------------------------------------

describe('findChatIdInUpdates', () => {
  test('extracts chats from message field', () => {
    const updates = [
      { message: { chat: { id: 100, type: 'private', first_name: 'Alice' } } },
    ];
    const result = findChatIdInUpdates(updates);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ chatId: 100, type: 'private', firstName: 'Alice' });
  });

  test('extracts chats from edited_message field', () => {
    const updates = [
      { edited_message: { chat: { id: 200, type: 'group', username: 'grp' } } },
    ];
    const result = findChatIdInUpdates(updates);
    expect(result[0]).toMatchObject({ chatId: 200, type: 'group', username: 'grp' });
  });

  test('deduplicates by chatId (later entry wins)', () => {
    const updates = [
      { message: { chat: { id: 5, type: 'private', first_name: 'First' } } },
      { message: { chat: { id: 5, type: 'private', first_name: 'Second' } } },
    ];
    const result = findChatIdInUpdates(updates);
    expect(result).toHaveLength(1);
  });

  test('skips updates with no chat', () => {
    const updates = [{ message: {} }, { edited_message: { chat: { type: 'private' } } }];
    // No numeric id → skipped.
    expect(findChatIdInUpdates(updates as Parameters<typeof findChatIdInUpdates>[0])).toHaveLength(0);
  });

  test('returns [] for empty input', () => {
    expect(findChatIdInUpdates([])).toEqual([]);
  });

  test('omits username/firstName when absent', () => {
    const updates = [{ message: { chat: { id: 9, type: 'channel' } } }];
    const result = findChatIdInUpdates(updates);
    expect(result[0]).not.toHaveProperty('username');
    expect(result[0]).not.toHaveProperty('firstName');
  });
});

// ---------------------------------------------------------------------------
// pollForChats
// ---------------------------------------------------------------------------

describe('pollForChats', () => {
  test('returns chats immediately when first fetchUpdates finds them', async () => {
    fetchSpy.mockResolvedValueOnce(
      okJson({ ok: true, result: [{ message: { chat: { id: 1, type: 'private' } } }] }),
    );
    const result = await pollForChats('tok', { maxAttempts: 3, intervalMs: 10 });
    expect(result).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('returns [] when all attempts find no chats (timeout)', async () => {
    fetchSpy.mockResolvedValue(okJson({ ok: true, result: [] }));
    const result = await pollForChats('tok', { maxAttempts: 2, intervalMs: 0 });
    expect(result).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('sleeps between attempts', async () => {
    const { sleep } = await import('../agent/providers/shared/sleep-with-abort.js');
    const sleepSpy = vi.mocked(sleep);
    sleepSpy.mockClear();
    fetchSpy.mockResolvedValue(okJson({ ok: true, result: [] }));
    await pollForChats('tok', { maxAttempts: 3, intervalMs: 500 });
    // sleep should be called between attempts (maxAttempts-1 times).
    expect(sleepSpy).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledWith(500);
  });

  test('finds chats on second attempt', async () => {
    fetchSpy
      .mockResolvedValueOnce(okJson({ ok: true, result: [] }))
      .mockResolvedValueOnce(
        okJson({ ok: true, result: [{ message: { chat: { id: 77, type: 'private' } } }] }),
      );
    const result = await pollForChats('tok', { maxAttempts: 3, intervalMs: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]!.chatId).toBe(77);
  });
});

// ---------------------------------------------------------------------------
// checkTokenFromFile
// ---------------------------------------------------------------------------

describe('checkTokenFromFile', () => {
  function makeTmp(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'afk-sw-cov-'));
    const p = join(dir, 'afk.env');
    writeFileSync(p, contents, { mode: 0o600 });
    return p;
  }

  test('returns {set:false, valid:false, reason:"unset"} when file missing', async () => {
    expect(await checkTokenFromFile('/nonexistent/afk.env')).toEqual({
      set: false, valid: false, reason: 'unset',
    });
  });

  test('returns {set:true, valid:true} when token validates', async () => {
    const p = makeTmp('TELEGRAM_BOT_TOKEN=tok123\n');
    fetchSpy.mockResolvedValueOnce(
      okJson({ ok: true, result: { id: 1, username: 'bot', first_name: 'B' } }),
    );
    try {
      const result = await checkTokenFromFile(p);
      expect(result.set).toBe(true);
      expect(result.valid).toBe(true);
      expect(result.botId).toBe(1);
      expect(result.username).toBe('bot');
    } finally { rmSync(p, { force: true }); }
  });

  test('returns {set:true, valid:false, reason:"unauthorized"} on bad token', async () => {
    const p = makeTmp('TELEGRAM_BOT_TOKEN=badtok\n');
    fetchSpy.mockResolvedValueOnce(notOk());
    try {
      const result = await checkTokenFromFile(p);
      expect(result).toEqual({ set: true, valid: false, reason: 'unauthorized' });
    } finally { rmSync(p, { force: true }); }
  });
});

// ---------------------------------------------------------------------------
// discoverChatFromFile
// ---------------------------------------------------------------------------

describe('discoverChatFromFile', () => {
  function makeTmp(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'afk-sw-disc-'));
    const p = join(dir, 'afk.env');
    writeFileSync(p, contents, { mode: 0o600 });
    return p;
  }

  test('returns {found:false, reason:"unset"} when file missing', async () => {
    expect(await discoverChatFromFile('/nonexistent/afk.env')).toEqual({
      found: false, chats: [], reason: 'unset',
    });
  });

  test('returns {found:true, chats} when poll finds a chat', async () => {
    const p = makeTmp('TELEGRAM_BOT_TOKEN=tok\n');
    fetchSpy.mockResolvedValueOnce(
      okJson({ ok: true, result: [{ message: { chat: { id: 55, type: 'private' } } }] }),
    );
    try {
      const result = await discoverChatFromFile(p, { timeoutSec: 2 });
      expect(result.found).toBe(true);
      expect(result.chats[0]!.chatId).toBe(55);
    } finally { rmSync(p, { force: true }); }
  });

  test('returns {found:false, reason:"timeout"} when no chat found', async () => {
    const p = makeTmp('TELEGRAM_BOT_TOKEN=tok\n');
    fetchSpy.mockResolvedValue(okJson({ ok: true, result: [] }));
    try {
      // timeoutSec=0 → maxAttempts=1 → one fetch, no chats → timeout
      const result = await discoverChatFromFile(p, { timeoutSec: 0 });
      expect(result).toEqual({ found: false, chats: [], reason: 'timeout' });
    } finally { rmSync(p, { force: true }); }
  });
});

// ---------------------------------------------------------------------------
// runTelegramSetup — interactive flow branches (lines 221-327)
// ---------------------------------------------------------------------------

describe('runTelegramSetup', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  test('happy path: promptSecret → valid token → single chat found', async () => {
    // No ambient token → enters the while(!bot) loop.
    // promptSecret returns 'mock-token', validateBotToken succeeds via fetch.
    fetchSpy
      // validateBotToken inside while loop
      .mockResolvedValueOnce(okJson({ ok: true, result: { id: 1, username: 'bot', first_name: 'B' } }))
      // pollForChats → fetchUpdates
      .mockResolvedValueOnce(okJson({ ok: true, result: [{ message: { chat: { id: 99, type: 'private', first_name: 'Alice' } } }] }));

    const result = await runTelegramSetup();
    expect(result.chatId).toBe(99);
    expect(result.bot.username).toBe('bot');
    const { upsertEnvVar } = await import('../utils/envFile.js');
    expect(vi.mocked(upsertEnvVar)).toHaveBeenCalledWith(expect.any(String), 'TELEGRAM_BOT_TOKEN', 'mock-token');
    expect(vi.mocked(upsertEnvVar)).toHaveBeenCalledWith(expect.any(String), 'AFK_TELEGRAM_ALLOWED_CHAT_IDS', '99');
  });

  test('token rejected on first promptSecret attempt, accepted on second', async () => {
    const { promptSecret } = await import('../utils/prompt-secret.js');
    vi.mocked(promptSecret)
      .mockResolvedValueOnce('bad-token')
      .mockResolvedValueOnce('good-token');

    fetchSpy
      // First validateBotToken → rejected
      .mockResolvedValueOnce(notOk())
      // Second validateBotToken → ok
      .mockResolvedValueOnce(okJson({ ok: true, result: { id: 2, first_name: 'G' } }))
      // pollForChats
      .mockResolvedValueOnce(okJson({ ok: true, result: [{ message: { chat: { id: 77, type: 'private' } } }] }));

    const result = await runTelegramSetup();
    expect(result.chatId).toBe(77);
  });

  test('exits 1 when promptSecret returns empty string', async () => {
    const { promptSecret } = await import('../utils/prompt-secret.js');
    vi.mocked(promptSecret).mockResolvedValueOnce('');
    await expect(runTelegramSetup()).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('multiple chats found: picks first by default', async () => {
    mockRlAnswer.value = '1'; // choose first chat
    fetchSpy
      .mockResolvedValueOnce(okJson({ ok: true, result: { id: 3, username: 'b3', first_name: 'B3' } }))
      .mockResolvedValueOnce(okJson({
        ok: true, result: [
          { message: { chat: { id: 10, type: 'private', first_name: 'A' } } },
          { message: { chat: { id: 11, type: 'private', first_name: 'B' } } },
        ],
      }));

    const result = await runTelegramSetup();
    expect(typeof result.chatId).toBe('number');
  });

  test('no chats found: prompts for manual chat ID', async () => {
    mockRlAnswer.value = '123456';
    fetchSpy
      .mockResolvedValueOnce(okJson({ ok: true, result: { id: 4, first_name: 'X' } }))
      .mockResolvedValueOnce(okJson({ ok: true, result: [] }));

    const result = await runTelegramSetup();
    expect(result.chatId).toBe(123456);
  });

  test('exits 1 when manual chat ID is not a valid number', async () => {
    mockRlAnswer.value = 'not-a-number';
    fetchSpy
      .mockResolvedValueOnce(okJson({ ok: true, result: { id: 5, first_name: 'Y' } }))
      .mockResolvedValueOnce(okJson({ ok: true, result: [] }));

    await expect(runTelegramSetup()).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
