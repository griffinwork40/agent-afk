import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { handleSearchMemory, handleGetHotMemory } from './routes.memory.js';

// ---- mocks -----------------------------------------------------------------

// Each method mock is a stable vi.fn() so `vi.clearAllMocks()` resets call
// history without destroying the function reference. The MemoryStore
// constructor is also a stable vi.fn() — see below.
const mockSearch = vi.fn();
const mockLoadHot = vi.fn();
const mockHotUsage = vi.fn();
const mockClose = vi.fn();

// The MemoryStore constructor mock is defined inside vi.mock (hoisted), so we
// use vi.hoisted to keep a stable reference to it across the hoist boundary.
const MockMemoryStore = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    search: mockSearch,
    loadHot: mockLoadHot,
    hotUsage: mockHotUsage,
    close: mockClose,
  })),
);

vi.mock('../agent/memory/memory-store.js', () => ({
  MemoryStore: MockMemoryStore,
}));

// ---- helpers ---------------------------------------------------------------

function makeRes(): { res: ServerResponse; json: () => { status: number; body: unknown } } {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
    },
    end(payload: string) {
      chunks.push(payload);
    },
  } as unknown as ServerResponse;
  return {
    res,
    json: () => ({ status, body: JSON.parse(chunks.join('')) as unknown }),
  };
}

function makeQuery(params: Record<string, string>): URLSearchParams {
  return new URLSearchParams(params);
}

// ---- tests -----------------------------------------------------------------

describe('routes.memory', () => {
  beforeEach(() => {
    // Reset call history for the per-method mocks (not the constructor mock,
    // as clearAllMocks would wipe its mockImplementation too).
    mockSearch.mockReset();
    mockLoadHot.mockReset();
    mockHotUsage.mockReset();
    mockClose.mockReset();
    MockMemoryStore.mockClear();
  });

  // --------------------------------------------------------------------------
  // handleSearchMemory
  // --------------------------------------------------------------------------

  describe('handleSearchMemory', () => {
    it('returns 400 when q is absent', async () => {
      const { res, json } = makeRes();
      await handleSearchMemory(res, makeQuery({}));
      const { status, body } = json();
      expect(status).toBe(400);
      expect((body as { error: string }).error).toBe('bad_request');
    });

    it('returns 400 when q is blank/whitespace', async () => {
      const { res, json } = makeRes();
      await handleSearchMemory(res, makeQuery({ q: '   ' }));
      expect(json().status).toBe(400);
    });

    it('returns 400 for an unknown category value', async () => {
      const { res, json } = makeRes();
      await handleSearchMemory(res, makeQuery({ q: 'test', category: 'bogus' }));
      const { status, body } = json();
      expect(status).toBe(400);
      expect((body as { error: string }).error).toBe('bad_request');
    });

    it('returns 200 with results for a valid query', async () => {
      const fakeResults = [{ id: 1, content: 'remembered thing', category: 'preference' }];
      mockSearch.mockReturnValue(fakeResults);

      const { res, json } = makeRes();
      await handleSearchMemory(res, makeQuery({ q: 'remembered' }));
      const { status, body } = json();
      expect(status).toBe(200);
      expect((body as { results: unknown[] }).results).toEqual(fakeResults);
      expect(mockSearch).toHaveBeenCalledWith('remembered', { limit: 20 });
    });

    it('passes a valid category filter through to MemoryStore.search', async () => {
      mockSearch.mockReturnValue([]);
      const { res } = makeRes();
      await handleSearchMemory(res, makeQuery({ q: 'pref', category: 'preference' }));
      expect(mockSearch).toHaveBeenCalledWith('pref', {
        category: 'preference',
        limit: 20,
      });
    });

    it('accepts all valid category values', async () => {
      const validCategories = ['preference', 'convention', 'decision', 'learning'] as const;
      for (const category of validCategories) {
        mockSearch.mockReturnValue([]);
        const { res, json } = makeRes();
        await handleSearchMemory(res, makeQuery({ q: 'x', category }));
        expect(json().status).toBe(200);
      }
    });

    it('returns 200 with empty results when no matches', async () => {
      mockSearch.mockReturnValue([]);
      const { res, json } = makeRes();
      await handleSearchMemory(res, makeQuery({ q: 'nothing here' }));
      const { status, body } = json();
      expect(status).toBe(200);
      expect((body as { results: unknown[] }).results).toEqual([]);
    });

    it('clamps limit to MAX_LIMIT (100) when above ceiling', async () => {
      mockSearch.mockReturnValue([]);
      const { res } = makeRes();
      await handleSearchMemory(res, makeQuery({ q: 'test', limit: '999' }));
      const call = mockSearch.mock.calls[0] as [string, { limit: number }];
      expect(call[1].limit).toBe(100);
    });

    it('uses DEFAULT_LIMIT when limit param is absent', async () => {
      mockSearch.mockReturnValue([]);
      const { res } = makeRes();
      await handleSearchMemory(res, makeQuery({ q: 'test' }));
      const call = mockSearch.mock.calls[0] as [string, { limit: number }];
      expect(call[1].limit).toBe(20);
    });

    it('uses DEFAULT_LIMIT when limit is non-numeric', async () => {
      mockSearch.mockReturnValue([]);
      const { res } = makeRes();
      await handleSearchMemory(res, makeQuery({ q: 'test', limit: 'abc' }));
      const call = mockSearch.mock.calls[0] as [string, { limit: number }];
      expect(call[1].limit).toBe(20);
    });

    it('closes the store even on success', async () => {
      mockSearch.mockReturnValue([]);
      const { res } = makeRes();
      await handleSearchMemory(res, makeQuery({ q: 'hello' }));
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('closes the store if search throws', async () => {
      mockSearch.mockImplementation(() => {
        throw new Error('db error');
      });
      const { res } = makeRes();
      await expect(handleSearchMemory(res, makeQuery({ q: 'boom' }))).rejects.toThrow('db error');
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // handleGetHotMemory
  // --------------------------------------------------------------------------

  describe('handleGetHotMemory', () => {
    it('returns 200 with content and usage', async () => {
      const fakeContent = '# HOT\nSome hot memory';
      const fakeUsage = { chars: 18, tokens: 5, budgetChars: 10_000, ratio: 0.002 };
      mockLoadHot.mockReturnValue(fakeContent);
      mockHotUsage.mockReturnValue(fakeUsage);

      const { res, json } = makeRes();
      await handleGetHotMemory(res);
      const { status, body } = json();
      expect(status).toBe(200);
      expect((body as { content: string }).content).toBe(fakeContent);
      expect((body as { usage: unknown }).usage).toEqual(fakeUsage);
    });

    it('returns null content when HOT.md does not exist', async () => {
      mockLoadHot.mockReturnValue(null);
      mockHotUsage.mockReturnValue({ chars: 0, tokens: 0, budgetChars: 10_000, ratio: 0 });

      const { res, json } = makeRes();
      await handleGetHotMemory(res);
      const { status, body } = json();
      expect(status).toBe(200);
      expect((body as { content: unknown }).content).toBeNull();
    });

    it('closes the store after reading', async () => {
      mockLoadHot.mockReturnValue(null);
      mockHotUsage.mockReturnValue({ chars: 0, tokens: 0, budgetChars: 10_000, ratio: 0 });

      const { res } = makeRes();
      await handleGetHotMemory(res);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('closes the store even if loadHot throws', async () => {
      mockLoadHot.mockImplementation(() => {
        throw new Error('fs error');
      });
      const { res } = makeRes();
      await expect(handleGetHotMemory(res)).rejects.toThrow('fs error');
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });
});
