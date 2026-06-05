import { describe, test, expect, vi } from 'vitest';
import type { Context } from 'telegraf';
import {
  parseAllowedChatIds,
  createAllowlistMiddleware,
} from './allowlist';

function ctxWithChat(id: number | undefined): Context {
  return (id === undefined
    ? { chat: undefined }
    : { chat: { id, type: 'private' } }) as unknown as Context;
}

describe('parseAllowedChatIds', () => {
  test('undefined returns empty set (fail-closed)', () => {
    expect(parseAllowedChatIds(undefined).size).toBe(0);
  });

  test('empty string returns empty set', () => {
    expect(parseAllowedChatIds('').size).toBe(0);
  });

  test('whitespace-only string returns empty set', () => {
    expect(parseAllowedChatIds('   ,  ,').size).toBe(0);
  });

  test('single numeric ID', () => {
    const ids = parseAllowedChatIds('123');
    expect(ids).toEqual(new Set([123]));
  });

  test('multiple comma-separated IDs', () => {
    const ids = parseAllowedChatIds('123,456,789');
    expect(ids).toEqual(new Set([123, 456, 789]));
  });

  test('trims whitespace around commas', () => {
    const ids = parseAllowedChatIds(' 123 , 456 ');
    expect(ids).toEqual(new Set([123, 456]));
  });

  test('skips empty entries from stray commas', () => {
    const ids = parseAllowedChatIds('123,,456,');
    expect(ids).toEqual(new Set([123, 456]));
  });

  test('accepts negative IDs (group/channel chats)', () => {
    const ids = parseAllowedChatIds('-100987654321,123');
    expect(ids).toEqual(new Set([-100987654321, 123]));
  });

  test('deduplicates repeated IDs', () => {
    const ids = parseAllowedChatIds('123,123,456');
    expect(ids).toEqual(new Set([123, 456]));
  });

  test('skips non-numeric entries and logs a warning', () => {
    const log = vi.fn();
    const ids = parseAllowedChatIds('abc,123,12x', log);
    expect(ids).toEqual(new Set([123]));
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.any(String), 'abc');
    expect(log).toHaveBeenCalledWith(expect.any(String), '12x');
  });

  test('returns empty set when every entry is invalid (still fail-closed)', () => {
    const ids = parseAllowedChatIds('abc,xyz', () => {});
    expect(ids.size).toBe(0);
  });
});

describe('createAllowlistMiddleware', () => {
  test('calls next() for allowed chat ID', async () => {
    const mw = createAllowlistMiddleware(new Set([123]));
    const next = vi.fn(async () => {});
    await mw(ctxWithChat(123), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('drops update for disallowed chat ID (does not call next)', async () => {
    const mw = createAllowlistMiddleware(new Set([123]));
    const next = vi.fn(async () => {});
    await mw(ctxWithChat(999), next);
    expect(next).not.toHaveBeenCalled();
  });

  test('drops update when ctx.chat is undefined (fail-closed)', async () => {
    const mw = createAllowlistMiddleware(new Set([123]));
    const next = vi.fn(async () => {});
    await mw(ctxWithChat(undefined), next);
    expect(next).not.toHaveBeenCalled();
  });

  test('empty allowlist rejects every update', async () => {
    const mw = createAllowlistMiddleware(new Set<number>());
    const next = vi.fn(async () => {});
    await mw(ctxWithChat(123), next);
    await mw(ctxWithChat(-42), next);
    await mw(ctxWithChat(undefined), next);
    expect(next).not.toHaveBeenCalled();
  });

  test('supports negative IDs in the allowlist', async () => {
    const mw = createAllowlistMiddleware(new Set([-100987654321]));
    const next = vi.fn(async () => {});
    await mw(ctxWithChat(-100987654321), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('logs a line when rejecting', async () => {
    const log = vi.fn();
    const mw = createAllowlistMiddleware(new Set([123]), log);
    const next = vi.fn(async () => {});
    await mw(ctxWithChat(999), next);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.any(String), 999);
  });

  test('logs "<unknown>" when ctx.chat is missing', async () => {
    const log = vi.fn();
    const mw = createAllowlistMiddleware(new Set([123]), log);
    const next = vi.fn(async () => {});
    await mw(ctxWithChat(undefined), next);
    expect(log).toHaveBeenCalledWith(expect.any(String), '<unknown>');
  });

  test('does not send any reply when rejecting (silent drop)', async () => {
    const reply = vi.fn();
    const mw = createAllowlistMiddleware(new Set([123]));
    const ctx = {
      chat: { id: 999, type: 'private' },
      reply,
    } as unknown as Context;
    const next = vi.fn(async () => {});
    await mw(ctx, next);
    expect(reply).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
