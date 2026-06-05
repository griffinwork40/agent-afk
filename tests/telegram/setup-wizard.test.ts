/**
 * Tests for the pure (non-prompt) pieces of the Telegram setup wizard.
 *
 * The interactive flow (`runTelegramSetup`) reads stdin and is exercised
 * manually via `afk telegram setup`; here we cover the helpers it composes:
 *   - validateBotToken: getMe round-trip
 *   - findChatIdInUpdates: parsing + dedup
 *   - pollForChats: early-stop behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateBotToken,
  findChatIdInUpdates,
  fetchUpdates,
  pollForChats,
} from '../../src/telegram/setup-wizard.js';

describe('setup-wizard helpers', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('validateBotToken', () => {
    it('returns identity on successful getMe', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { id: 12345, username: 'agent_afk_bot', first_name: 'Agent AFK' },
          }),
          { status: 200 },
        ),
      ) as unknown as typeof globalThis.fetch;

      const result = await validateBotToken('valid-token');
      expect(result).toEqual({
        id: 12345,
        username: 'agent_afk_bot',
        firstName: 'Agent AFK',
      });
    });

    it('returns null on non-OK HTTP status', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response('Unauthorized', { status: 401 }),
      ) as unknown as typeof globalThis.fetch;

      expect(await validateBotToken('bad-token')).toBeNull();
    });

    it('returns null when response ok=false', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ ok: false }), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      expect(await validateBotToken('bad-token')).toBeNull();
    });

    it('returns null on network error', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('ENETUNREACH');
      }) as unknown as typeof globalThis.fetch;

      expect(await validateBotToken('any-token')).toBeNull();
    });

    it('omits username when not present', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: { id: 1, first_name: 'Bot' },
          }),
          { status: 200 },
        ),
      ) as unknown as typeof globalThis.fetch;

      const result = await validateBotToken('t');
      expect(result).toEqual({ id: 1, firstName: 'Bot' });
      expect(result).not.toHaveProperty('username');
    });
  });

  describe('findChatIdInUpdates', () => {
    it('extracts chat from message', () => {
      const updates = [
        { message: { chat: { id: 999, type: 'private', username: 'alice' } } },
      ];
      expect(findChatIdInUpdates(updates)).toEqual([
        { chatId: 999, type: 'private', username: 'alice' },
      ]);
    });

    it('extracts chat from edited_message when message absent', () => {
      const updates = [
        { edited_message: { chat: { id: 888, type: 'private', first_name: 'Bob' } } },
      ];
      expect(findChatIdInUpdates(updates)).toEqual([
        { chatId: 888, type: 'private', firstName: 'Bob' },
      ]);
    });

    it('deduplicates by chatId, overwriting with the latest entry', () => {
      const updates = [
        { message: { chat: { id: 1, type: 'private', username: 'old' } } },
        { message: { chat: { id: 2, type: 'private', username: 'other' } } },
        { message: { chat: { id: 1, type: 'private', username: 'new' } } },
      ];
      const result = findChatIdInUpdates(updates);
      // Two unique chat IDs; the dedup overwrites id=1 with the newer
      // username. Map preserves first-insertion order, so iteration is
      // [1, 2]; after reverse() we get [2, 1] — most-recently-INSERTED
      // first. The username for id=1 reflects the latest overwrite.
      expect(result).toHaveLength(2);
      const byId = new Map(result.map((c) => [c.chatId, c]));
      expect(byId.get(1)?.username).toBe('new');
      expect(byId.get(2)?.username).toBe('other');
    });

    it('skips updates without a chat id', () => {
      const updates = [
        { message: { chat: {} } },
        { message: { chat: { id: 5, type: 'private' } } },
      ];
      const result = findChatIdInUpdates(updates);
      expect(result).toEqual([{ chatId: 5, type: 'private' }]);
    });

    it('returns empty array for empty input', () => {
      expect(findChatIdInUpdates([])).toEqual([]);
    });

    it('falls back to "unknown" type when missing', () => {
      const updates = [{ message: { chat: { id: 42 } } }];
      const result = findChatIdInUpdates(updates);
      expect(result[0]?.type).toBe('unknown');
    });
  });

  describe('fetchUpdates', () => {
    it('returns the result array on success', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: [{ message: { chat: { id: 7, type: 'private' } } }],
          }),
          { status: 200 },
        ),
      ) as unknown as typeof globalThis.fetch;

      const updates = await fetchUpdates('token');
      expect(updates).toHaveLength(1);
    });

    it('returns empty array on HTTP failure', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response('error', { status: 500 }),
      ) as unknown as typeof globalThis.fetch;

      expect(await fetchUpdates('token')).toEqual([]);
    });

    it('returns empty array when ok=false', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ ok: false }), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      expect(await fetchUpdates('token')).toEqual([]);
    });
  });

  describe('pollForChats', () => {
    it('stops early once chats are found', async () => {
      let call = 0;
      globalThis.fetch = vi.fn(async () => {
        call++;
        if (call < 3) {
          return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            result: [{ message: { chat: { id: 42, type: 'private' } } }],
          }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch;

      const chats = await pollForChats('token', { maxAttempts: 10, intervalMs: 5 });
      expect(chats).toHaveLength(1);
      expect(chats[0]?.chatId).toBe(42);
      expect(call).toBe(3);
    });

    it('returns empty array after exhausting attempts', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const chats = await pollForChats('token', { maxAttempts: 3, intervalMs: 5 });
      expect(chats).toEqual([]);
    });
  });
});
