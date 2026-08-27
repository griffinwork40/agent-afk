/**
 * Unit tests for the witness handler adapter layer.
 *
 * The query module (`./witness.query`) is mocked so every test exercises only
 * the handler logic — input validation, argument extraction, delegation, and
 * error wrapping — without touching the filesystem or the real trace reader.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readWitnessHandler, searchWitnessHandler } from './witness.js';
import type { ReadWitnessResult, SearchWitnessResult } from './witness.query.js';

// ---------------------------------------------------------------------------
// Mock the query module — only these two functions matter for the handlers.
// ---------------------------------------------------------------------------

vi.mock('./witness.query.js', () => ({
  readSessionTrace: vi.fn(),
  searchAcrossSessions: vi.fn(),
}));

import { readSessionTrace, searchAcrossSessions } from './witness.query.js';

const mockReadSessionTrace = vi.mocked(readSessionTrace);
const mockSearchAcrossSessions = vi.mocked(searchAcrossSessions);

const signal = new AbortController().signal;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ReadWitnessResult for stub responses. */
function makeReadResult(partial?: Partial<ReadWitnessResult>): ReadWitnessResult {
  return {
    sessionId: 'sess-abc123',
    events: [],
    totalInTrace: 0,
    filtered: 0,
    ...partial,
  };
}

/** Build a minimal SearchWitnessResult for stub responses. */
function makeSearchResult(partial?: Partial<SearchWitnessResult>): SearchWitnessResult {
  return {
    query: 'test',
    sessionsAvailable: 0,
    sessionsSearched: 0,
    sessionsScanned: 0,
    matches: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Helper re-exports: asObj and asStringArray are private but their contract is
// observable through the handlers. We verify them indirectly below, but also
// surface the private API for direct coverage via a thin re-export shim.
// ---------------------------------------------------------------------------

// The helpers are not exported — test their observable contract through the
// handler calls (the handler tests below fully exercise every branch).

// ---------------------------------------------------------------------------
// asObj — tested through readWitnessHandler behaviour
// ---------------------------------------------------------------------------

describe('readWitnessHandler — input coercion (asObj branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('null input → isError', async () => {
    const result = await readWitnessHandler(null, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid input/i);
    expect(mockReadSessionTrace).not.toHaveBeenCalled();
  });

  it('string input → isError (non-object)', async () => {
    const result = await readWitnessHandler('latest' as unknown, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid input/i);
    expect(mockReadSessionTrace).not.toHaveBeenCalled();
  });

  it('number input → isError', async () => {
    const result = await readWitnessHandler(42 as unknown, signal);
    expect(result.isError).toBe(true);
    expect(mockReadSessionTrace).not.toHaveBeenCalled();
  });

  it('boolean false input → isError (falsy non-null)', async () => {
    const result = await readWitnessHandler(false as unknown, signal);
    expect(result.isError).toBe(true);
    expect(mockReadSessionTrace).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// readWitnessHandler — valid object paths
// ---------------------------------------------------------------------------

describe('readWitnessHandler — valid object input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadSessionTrace.mockResolvedValue(makeReadResult());
  });

  it('delegates to readSessionTrace with extracted params and returns JSON', async () => {
    const input = {
      session: 'sess-xyz',
      kinds: ['tool_call', 'subagent_lifecycle'],
      tool_name: 'bash',
      errors_only: true,
      limit: 20,
    };
    const expectedResult = makeReadResult({ sessionId: 'sess-xyz', filtered: 0 });
    mockReadSessionTrace.mockResolvedValue(expectedResult);

    const result = await readWitnessHandler(input, signal);

    expect(result.isError).toBeUndefined();
    expect(mockReadSessionTrace).toHaveBeenCalledOnce();
    expect(mockReadSessionTrace).toHaveBeenCalledWith({
      session: 'sess-xyz',
      kinds: ['tool_call', 'subagent_lifecycle'],
      toolName: 'bash',
      errorsOnly: true,
      limit: 20,
    });
    expect(result.content).toBe(JSON.stringify(expectedResult));
  });

  it('empty object → delegates with all-undefined/false defaults', async () => {
    const result = await readWitnessHandler({}, signal);

    expect(result.isError).toBeUndefined();
    expect(mockReadSessionTrace).toHaveBeenCalledWith({
      session: undefined,
      kinds: undefined,
      toolName: undefined,
      errorsOnly: false,
      limit: undefined,
    });
  });

  it('wrong-typed fields are coerced: non-string session → undefined', async () => {
    await readWitnessHandler({ session: 123, errors_only: 'yes', limit: 'all' }, signal);

    expect(mockReadSessionTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        session: undefined,
        errorsOnly: false,
        limit: undefined,
      }),
    );
  });

  it('asStringArray: mixed array → filters non-strings', async () => {
    await readWitnessHandler({ kinds: ['tool_call', 99, null, 'session_phase'] }, signal);

    expect(mockReadSessionTrace).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ['tool_call', 'session_phase'] }),
    );
  });

  it('asStringArray: non-array kinds value → undefined', async () => {
    await readWitnessHandler({ kinds: 'tool_call' }, signal);

    expect(mockReadSessionTrace).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: undefined }),
    );
  });

  it('asStringArray: valid string array passes through unchanged', async () => {
    await readWitnessHandler({ kinds: ['tool_call', 'compaction'] }, signal);

    expect(mockReadSessionTrace).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ['tool_call', 'compaction'] }),
    );
  });

  it('asStringArray: empty array → returns empty array', async () => {
    await readWitnessHandler({ kinds: [] }, signal);

    expect(mockReadSessionTrace).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: [] }),
    );
  });
});

// ---------------------------------------------------------------------------
// readWitnessHandler — thrown error path
// ---------------------------------------------------------------------------

describe('readWitnessHandler — thrown error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Error instance → isError with message', async () => {
    mockReadSessionTrace.mockRejectedValue(new Error('trace file corrupt'));

    const result = await readWitnessHandler({ session: 'bad-sess' }, signal);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/read_witness failed/);
    expect(result.content).toMatch(/trace file corrupt/);
  });

  it('non-Error thrown value → isError with stringified message', async () => {
    mockReadSessionTrace.mockRejectedValue('oops string error');

    const result = await readWitnessHandler({}, signal);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/read_witness failed/);
    expect(result.content).toMatch(/oops string error/);
  });
});

// ---------------------------------------------------------------------------
// searchWitnessHandler — input coercion (asObj branch)
// ---------------------------------------------------------------------------

describe('searchWitnessHandler — input coercion (asObj branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('null input → isError', async () => {
    const result = await searchWitnessHandler(null, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/invalid input/i);
    expect(mockSearchAcrossSessions).not.toHaveBeenCalled();
  });

  it('non-object input → isError', async () => {
    const result = await searchWitnessHandler(42 as unknown, signal);
    expect(result.isError).toBe(true);
    expect(mockSearchAcrossSessions).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// searchWitnessHandler — missing / empty query
// ---------------------------------------------------------------------------

describe('searchWitnessHandler — query validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('missing query field → isError', async () => {
    const result = await searchWitnessHandler({}, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/query/i);
    expect(mockSearchAcrossSessions).not.toHaveBeenCalled();
  });

  it('empty string query → isError', async () => {
    const result = await searchWitnessHandler({ query: '' }, signal);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/query/i);
    expect(mockSearchAcrossSessions).not.toHaveBeenCalled();
  });

  it('non-string query → isError', async () => {
    const result = await searchWitnessHandler({ query: 123 }, signal);
    expect(result.isError).toBe(true);
    expect(mockSearchAcrossSessions).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// searchWitnessHandler — valid input
// ---------------------------------------------------------------------------

describe('searchWitnessHandler — valid input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchAcrossSessions.mockResolvedValue(makeSearchResult());
  });

  it('delegates with extracted params and returns JSON', async () => {
    const input = {
      query: 'forkbomb',
      sessions: 10,
      kinds: ['subagent_lifecycle'],
      since: '2024-01-01T00:00:00Z',
      tool_name: 'bash',
    };
    const expectedResult = makeSearchResult({ query: 'forkbomb', sessionsAvailable: 10, sessionsSearched: 10, sessionsScanned: 10 });
    mockSearchAcrossSessions.mockResolvedValue(expectedResult);

    const result = await searchWitnessHandler(input, signal);

    expect(result.isError).toBeUndefined();
    expect(mockSearchAcrossSessions).toHaveBeenCalledOnce();
    expect(mockSearchAcrossSessions).toHaveBeenCalledWith({
      query: 'forkbomb',
      sessions: 10,
      kinds: ['subagent_lifecycle'],
      since: '2024-01-01T00:00:00Z',
      toolName: 'bash',
    });
    expect(result.content).toBe(JSON.stringify(expectedResult));
  });

  it('minimal input — only query field — delegates with undefined optionals', async () => {
    const result = await searchWitnessHandler({ query: 'error' }, signal);

    expect(result.isError).toBeUndefined();
    expect(mockSearchAcrossSessions).toHaveBeenCalledWith({
      query: 'error',
      sessions: undefined,
      kinds: undefined,
      since: undefined,
      toolName: undefined,
    });
  });

  it('tool_name string → toolName passed through; non-string → undefined', async () => {
    await searchWitnessHandler({ query: 'x', tool_name: 'edit_file' }, signal);
    expect(mockSearchAcrossSessions).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'edit_file' }),
    );

    vi.clearAllMocks();
    mockSearchAcrossSessions.mockResolvedValue(makeSearchResult());
    await searchWitnessHandler({ query: 'x', tool_name: 42 }, signal);
    expect(mockSearchAcrossSessions).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: undefined }),
    );
  });

  it('wrong-typed optional fields coerced: non-number sessions → undefined', async () => {
    await searchWitnessHandler({ query: 'x', sessions: 'all', since: 42 }, signal);

    expect(mockSearchAcrossSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        sessions: undefined,
        since: undefined,
      }),
    );
  });

  it('asStringArray on kinds: mixed array → string-only members', async () => {
    await searchWitnessHandler({ query: 'x', kinds: ['tool_call', 7, 'closure'] }, signal);

    expect(mockSearchAcrossSessions).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: ['tool_call', 'closure'] }),
    );
  });

  it('asStringArray on kinds: undefined kinds → undefined passed through', async () => {
    await searchWitnessHandler({ query: 'x' }, signal);

    expect(mockSearchAcrossSessions).toHaveBeenCalledWith(
      expect.objectContaining({ kinds: undefined }),
    );
  });
});

// ---------------------------------------------------------------------------
// searchWitnessHandler — thrown error path
// ---------------------------------------------------------------------------

describe('searchWitnessHandler — thrown error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Error instance → isError with message', async () => {
    mockSearchAcrossSessions.mockRejectedValue(new Error('index scan failed'));

    const result = await searchWitnessHandler({ query: 'crash' }, signal);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/search_witness failed/);
    expect(result.content).toMatch(/index scan failed/);
  });

  it('non-Error thrown value → isError with stringified message', async () => {
    mockSearchAcrossSessions.mockRejectedValue({ code: 'ENOENT' });

    const result = await searchWitnessHandler({ query: 'x' }, signal);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/search_witness failed/);
  });
});
