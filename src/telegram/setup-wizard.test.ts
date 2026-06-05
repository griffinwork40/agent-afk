/**
 * Tests for the pure/file-based helpers in setup-wizard.ts.
 *
 * The interactive `runTelegramSetup()` is not tested here — it owns stdin
 * via readline and the `prompt`/`pollForChats` helpers are exercised
 * elsewhere. Coverage focuses on the secret-isolation contract:
 *
 *   - `readEnvVarFromFile`: parses dotenv-style files; never throws on
 *     missing/empty files.
 *   - `checkTokenFromFile`: emits `{set, valid, ...}` shapes without ever
 *     returning the token itself.
 *   - `discoverChatFromFile`: emits `{found, chats, ...}` shapes without
 *     ever returning the token.
 *
 * These are the contracts the `telegram-setup` skill's prompt relies on for
 * L1 (architectural) secret isolation.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readEnvVarFromFile,
  checkTokenFromFile,
  discoverChatFromFile,
} from './setup-wizard.js';

function makeTmpEnv(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'afk-setup-wizard-test-'));
  const path = join(dir, 'afk.env');
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

describe('readEnvVarFromFile', () => {
  test('returns undefined when file does not exist', () => {
    expect(readEnvVarFromFile('/nonexistent/path/afk.env', 'FOO')).toBeUndefined();
  });

  test('returns undefined when key is absent', () => {
    const path = makeTmpEnv('OTHER=value\n');
    try {
      expect(readEnvVarFromFile(path, 'TELEGRAM_BOT_TOKEN')).toBeUndefined();
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('reads a simple unquoted value', () => {
    const path = makeTmpEnv('TELEGRAM_BOT_TOKEN=123:abc-def\n');
    try {
      expect(readEnvVarFromFile(path, 'TELEGRAM_BOT_TOKEN')).toBe('123:abc-def');
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('strips surrounding double quotes', () => {
    const path = makeTmpEnv('TELEGRAM_BOT_TOKEN="123:abc"\n');
    try {
      expect(readEnvVarFromFile(path, 'TELEGRAM_BOT_TOKEN')).toBe('123:abc');
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('strips surrounding single quotes', () => {
    const path = makeTmpEnv("TELEGRAM_BOT_TOKEN='abc'\n");
    try {
      expect(readEnvVarFromFile(path, 'TELEGRAM_BOT_TOKEN')).toBe('abc');
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('skips comments and blank lines', () => {
    const contents = [
      '# a comment',
      '',
      '   # indented comment (treated as comment after trim)',
      'TELEGRAM_BOT_TOKEN=tok',
      '',
    ].join('\n');
    const path = makeTmpEnv(contents);
    try {
      expect(readEnvVarFromFile(path, 'TELEGRAM_BOT_TOKEN')).toBe('tok');
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('first matching key wins (no late-write override)', () => {
    const path = makeTmpEnv('TELEGRAM_BOT_TOKEN=first\nTELEGRAM_BOT_TOKEN=second\n');
    try {
      expect(readEnvVarFromFile(path, 'TELEGRAM_BOT_TOKEN')).toBe('first');
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe('checkTokenFromFile (L1 secret-isolation contract)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns set:false when token absent', async () => {
    const path = makeTmpEnv('OTHER=x\n');
    try {
      const result = await checkTokenFromFile(path);
      expect(result).toEqual({ set: false, valid: false, reason: 'unset' });
      // Critical: the token field must never appear in any shape.
      expect(JSON.stringify(result)).not.toMatch(/token/i);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('returns set:true valid:false when getMe rejects', async () => {
    const path = makeTmpEnv('TELEGRAM_BOT_TOKEN=bad-token\n');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );
    try {
      const result = await checkTokenFromFile(path);
      expect(result).toEqual({ set: true, valid: false, reason: 'unauthorized' });
      // The token must not appear in the serialized output.
      expect(JSON.stringify(result)).not.toContain('bad-token');
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('returns username + botId on success, never the token', async () => {
    const path = makeTmpEnv('TELEGRAM_BOT_TOKEN=123:abcsecret\n');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: { id: 42, username: 'FooBot', first_name: 'Foo' },
        }),
        { status: 200 },
      ),
    );
    try {
      const result = await checkTokenFromFile(path);
      expect(result).toEqual({
        set: true,
        valid: true,
        botId: 42,
        username: 'FooBot',
      });
      expect(JSON.stringify(result)).not.toContain('abcsecret');
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('returns set:true valid:false on network failure', async () => {
    const path = makeTmpEnv('TELEGRAM_BOT_TOKEN=any\n');
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ENOTFOUND'));
    try {
      const result = await checkTokenFromFile(path);
      expect(result.set).toBe(true);
      expect(result.valid).toBe(false);
      // unauthorized is the catchall reason since validateBotToken returns null
      // on any non-2xx OR thrown fetch — both look the same to callers.
      expect(result.reason).toBe('unauthorized');
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe('discoverChatFromFile (L1 secret-isolation contract)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns found:false reason:unset when token absent', async () => {
    const path = makeTmpEnv('');
    try {
      const result = await discoverChatFromFile(path, { timeoutSec: 1 });
      expect(result).toEqual({ found: false, chats: [], reason: 'unset' });
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('returns chats from getUpdates, never the token', async () => {
    const path = makeTmpEnv('TELEGRAM_BOT_TOKEN=123:secrettoken\n');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              message: {
                chat: { id: 9001, type: 'private', username: 'alice', first_name: 'Alice' },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    try {
      const result = await discoverChatFromFile(path, { timeoutSec: 1 });
      expect(result.found).toBe(true);
      expect(result.chats).toHaveLength(1);
      expect(result.chats[0]).toMatchObject({ chatId: 9001, username: 'alice' });
      expect(JSON.stringify(result)).not.toContain('secrettoken');
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('returns found:false reason:timeout when no chats arrive', async () => {
    const path = makeTmpEnv('TELEGRAM_BOT_TOKEN=any\n');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
    );
    try {
      // 1-second timeout → 1 attempt at most (we ceil 1000/2000 = 1).
      const result = await discoverChatFromFile(path, { timeoutSec: 1 });
      expect(result).toEqual({ found: false, chats: [], reason: 'timeout' });
    } finally {
      rmSync(path, { force: true });
    }
  });
});


