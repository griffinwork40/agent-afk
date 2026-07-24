import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the afk.config.json reader so the IO-wrapper tests are hermetic (they
// must not depend on the host's ~/.afk/config/afk.config.json).
vi.mock('../cli/config.js', () => ({
  loadTelegramConfig: vi.fn(() => ({})),
}));

import {
  resolveNotifyTargets,
  resolvePrimaryChatId,
  parseChatId,
  parseMode,
  loadNotifyConfig,
  resolveConfiguredNotifyTargets,
  resolveChatTarget,
  loadChatAliases,
  type TelegramNotifyConfig,
} from './notify-routing.js';
import { isChatAllowed, parseAllowedChatIds } from './allowlist.js';
import { loadTelegramConfig } from '../cli/config.js';

const mockLoadTelegramConfig = vi.mocked(loadTelegramConfig);

describe('resolveNotifyTargets (pure)', () => {
  describe('primary mode (default)', () => {
    it('defaults to the first private/DM (positive) chat in a mixed allowlist', () => {
      expect(resolveNotifyTargets(new Set([123, -100200]))).toEqual([123]);
    });

    it('picks the positive chat even when a group is listed first', () => {
      expect(resolveNotifyTargets(new Set([-100200, 456]))).toEqual([456]);
    });

    it('falls back to the first allowed id when the allowlist is group-only', () => {
      expect(resolveNotifyTargets(new Set([-100200, -100300]))).toEqual([-100200]);
    });

    it('returns the single chat for a single-entry allowlist', () => {
      expect(resolveNotifyTargets(new Set([42]))).toEqual([42]);
    });

    it('returns an empty list for an empty allowlist', () => {
      expect(resolveNotifyTargets(new Set())).toEqual([]);
    });

    it('honours an explicit primaryChatId over the heuristic', () => {
      expect(resolveNotifyTargets(new Set([111, 222]), { primaryChatId: 222 })).toEqual([222]);
    });

    it('allows an explicit primaryChatId outside the allowlist (announce target)', () => {
      expect(resolveNotifyTargets(new Set([111]), { primaryChatId: -100999 })).toEqual([-100999]);
    });
  });

  describe('broadcast mode', () => {
    it('fans out to every allowed chat in order', () => {
      expect(resolveNotifyTargets(new Set([111, 222, 333]), { mode: 'broadcast' })).toEqual([
        111, 222, 333,
      ]);
    });

    it('returns empty for an empty allowlist', () => {
      expect(resolveNotifyTargets(new Set(), { mode: 'broadcast' })).toEqual([]);
    });
  });

  describe('custom mode', () => {
    it('returns the explicit targets verbatim', () => {
      expect(resolveNotifyTargets(new Set([111]), { mode: 'custom', targets: [5, 6] })).toEqual([
        5, 6,
      ]);
    });

    it('de-duplicates targets', () => {
      expect(
        resolveNotifyTargets(new Set([111]), { mode: 'custom', targets: [5, 5, 6] }),
      ).toEqual([5, 6]);
    });

    it('allows targets not in the allowlist (announce-only channel)', () => {
      expect(
        resolveNotifyTargets(new Set([111]), { mode: 'custom', targets: [-1001234567890] }),
      ).toEqual([-1001234567890]);
    });

    it('falls back to primary resolution when targets are empty', () => {
      expect(resolveNotifyTargets(new Set([111, -100]), { mode: 'custom', targets: [] })).toEqual([
        111,
      ]);
    });

    it('falls back to primary resolution when targets are all invalid', () => {
      expect(
        resolveNotifyTargets(new Set([111]), { mode: 'custom', targets: [0, NaN] }),
      ).toEqual([111]);
    });
  });
});

describe('resolvePrimaryChatId (pure)', () => {
  it('returns an explicit valid id', () => {
    expect(resolvePrimaryChatId([111, 222], 222)).toBe(222);
  });
  it('ignores an explicit 0 and falls to the heuristic', () => {
    expect(resolvePrimaryChatId([111, 222], 0)).toBe(111);
  });
  it('returns the first positive id when no explicit id', () => {
    expect(resolvePrimaryChatId([-100, 222])).toBe(222);
  });
  it('returns the first id when all are negative', () => {
    expect(resolvePrimaryChatId([-100, -200])).toBe(-100);
  });
  it('returns undefined for an empty list', () => {
    expect(resolvePrimaryChatId([])).toBeUndefined();
  });
});

describe('parseChatId (pure)', () => {
  it.each([
    ['undefined', undefined, undefined],
    ['empty', '', undefined],
    ['positive', '123', 123],
    ['negative group', '-100200', -100200],
    ['whitespace-padded', ' 42 ', 42],
    ['non-numeric', 'abc', undefined],
    ['zero', '0', undefined],
    ['float', '12.5', undefined],
  ])('parses %s', (_label, input, expected) => {
    expect(parseChatId(input as string | undefined)).toBe(expected);
  });
});

describe('parseMode (pure)', () => {
  it.each([
    ['undefined', undefined, undefined],
    ['primary', 'primary', 'primary'],
    ['broadcast', 'broadcast', 'broadcast'],
    ['custom', 'custom', 'custom'],
    ['uppercase', 'BROADCAST', 'broadcast'],
    ['padded', ' primary ', 'primary'],
    ['bogus', 'all', undefined],
  ])('parses %s', (_label, input, expected) => {
    expect(parseMode(input as string | undefined)).toBe(expected);
  });
});

describe('loadNotifyConfig + resolveConfiguredNotifyTargets (IO)', () => {
  const ENV_KEYS = [
    'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
    'AFK_TELEGRAM_NOTIFY_MODE',
    'AFK_TELEGRAM_PRIMARY_CHAT_ID',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    mockLoadTelegramConfig.mockReturnValue({});
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.clearAllMocks();
  });

  it('reads mode + primary from env when the file config is empty', () => {
    process.env['AFK_TELEGRAM_NOTIFY_MODE'] = 'broadcast';
    process.env['AFK_TELEGRAM_PRIMARY_CHAT_ID'] = '42';
    expect(loadNotifyConfig()).toEqual({ mode: 'broadcast', primaryChatId: 42 });
  });

  it('lets the file config win over env on conflict', () => {
    mockLoadTelegramConfig.mockReturnValue({ notify: { mode: 'custom', primaryChatId: 7, targets: [9] } });
    process.env['AFK_TELEGRAM_NOTIFY_MODE'] = 'broadcast';
    process.env['AFK_TELEGRAM_PRIMARY_CHAT_ID'] = '42';
    expect(loadNotifyConfig()).toEqual({ mode: 'custom', primaryChatId: 7, targets: [9] });
  });

  it('defaults to the primary (DM) chat — no broadcast — for a multi-chat allowlist', () => {
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222';
    expect(resolveConfiguredNotifyTargets()).toEqual([111]);
  });

  it('broadcasts when AFK_TELEGRAM_NOTIFY_MODE=broadcast', () => {
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222';
    process.env['AFK_TELEGRAM_NOTIFY_MODE'] = 'broadcast';
    expect(resolveConfiguredNotifyTargets()).toEqual([111, 222]);
  });

  it('uses the file config telegram.notify block', () => {
    mockLoadTelegramConfig.mockReturnValue({ notify: { mode: 'broadcast' } });
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222,333';
    expect(resolveConfiguredNotifyTargets()).toEqual([111, 222, 333]);
  });

  it('returns empty when the allowlist is unset', () => {
    expect(resolveConfiguredNotifyTargets()).toEqual([]);
  });

  it('routes to an explicit env primary chat', () => {
    process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS'] = '111,222';
    process.env['AFK_TELEGRAM_PRIMARY_CHAT_ID'] = '222';
    expect(resolveConfiguredNotifyTargets()).toEqual([222]);
  });

  const _typecheck: TelegramNotifyConfig = { mode: 'primary' };
  void _typecheck;
});

describe('resolveChatTarget (pure)', () => {
  const aliases = { ops: -1001234567890, family: 999, zero: 0 } as Record<string, number>;

  it('accepts a positive numeric chat id verbatim', () => {
    expect(resolveChatTarget(42)).toEqual({ ok: true, id: 42 });
  });

  it('accepts a negative numeric chat id (group/channel)', () => {
    expect(resolveChatTarget(-100200)).toEqual({ ok: true, id: -100200 });
  });

  it('rejects a zero numeric chat id', () => {
    const r = resolveChatTarget(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it('rejects a non-finite numeric chat id', () => {
    const r = resolveChatTarget(Number.NaN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it('parses a numeric string as a raw chat id', () => {
    expect(resolveChatTarget('-100987654321')).toEqual({ ok: true, id: -100987654321 });
  });

  it('parses a whitespace-padded numeric string', () => {
    expect(resolveChatTarget('  42  ')).toEqual({ ok: true, id: 42 });
  });

  it('rejects an empty string', () => {
    const r = resolveChatTarget('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it('resolves a known alias name to its chat id', () => {
    expect(resolveChatTarget('ops', aliases)).toEqual({ ok: true, id: -1001234567890 });
  });

  it('resolves a positive-id alias', () => {
    expect(resolveChatTarget('family', aliases)).toEqual({ ok: true, id: 999 });
  });

  it('rejects an unknown alias and lists available names', () => {
    const r = resolveChatTarget('nope', aliases);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unknown-alias');
      expect(r.message).toMatch(/Unknown chat alias "nope"/);
      expect(r.message).toMatch(/ops/);
      expect(r.message).toMatch(/family/);
    }
  });

  it('rejects an alias mapped to zero (defensive; treated as unknown)', () => {
    const r = resolveChatTarget('zero', aliases);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown-alias');
  });

  it('reports no configured aliases when the map is empty', () => {
    const r = resolveChatTarget('ops', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/No chat aliases are configured/);
  });

  it('does not treat a numeric-looking value as an alias even if a same-named alias exists', () => {
    // "999" is numeric → parsed as chat id 999, NOT looked up as alias name.
    expect(resolveChatTarget('999', { '999': -1 })).toEqual({ ok: true, id: 999 });
  });
});

describe('isChatAllowed (pure)', () => {
  it('returns true for a member of the allowlist', () => {
    expect(isChatAllowed(123, new Set([123, 456]))).toBe(true);
  });

  it('returns false for a non-member', () => {
    expect(isChatAllowed(789, new Set([123, 456]))).toBe(false);
  });

  it('fails closed on an empty allowlist', () => {
    expect(isChatAllowed(123, new Set())).toBe(false);
  });

  it('handles negative (group/channel) ids', () => {
    expect(isChatAllowed(-100200, new Set([-100200]))).toBe(true);
    expect(isChatAllowed(-100200, new Set([-100999]))).toBe(false);
  });

  it('composes with parseAllowedChatIds end-to-end', () => {
    const allowlist = parseAllowedChatIds('111, 222 ,-100333');
    expect(isChatAllowed(222, allowlist)).toBe(true);
    expect(isChatAllowed(-100333, allowlist)).toBe(true);
    expect(isChatAllowed(444, allowlist)).toBe(false);
  });
});

describe('loadChatAliases (IO)', () => {
  beforeEach(() => {
    mockLoadTelegramConfig.mockReturnValue({});
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns {} when no aliases are configured', () => {
    expect(loadChatAliases()).toEqual({});
  });

  it('returns the configured alias map', () => {
    mockLoadTelegramConfig.mockReturnValue({ chatAliases: { ops: -100123, me: 42 } });
    expect(loadChatAliases()).toEqual({ ops: -100123, me: 42 });
  });
});
