/**
 * Unit tests for the read_journal handler.
 *
 * All filesystem / journal functions are mocked so tests exercise only the
 * handler logic: input validation, session resolution, mode dispatch, and
 * output formatting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readJournalHandler } from './journal.js';

// ---------------------------------------------------------------------------
// Mock journal reader modules
// ---------------------------------------------------------------------------

vi.mock('../../journal/reader.async.js', () => ({
  journalExistsAsync: vi.fn(),
  findToolResultAsync: vi.fn(),
}));

vi.mock('../../journal/reader.js', () => ({
  loadJournalMessages: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock the journal-native resolver internals (node:fs/promises)
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  stat: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock paths helpers used by the resolver
// ---------------------------------------------------------------------------

vi.mock('../../../paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../paths.js')>();
  return {
    ...actual,
    getSessionsDir: vi.fn(() => '/fake/sessions'),
    isSafeLedgerSessionId: actual.isSafeLedgerSessionId,
  };
});

// ---------------------------------------------------------------------------
// Mock session-name resolver
// ---------------------------------------------------------------------------

vi.mock('../../trace/session-name-resolver.js', () => ({
  resolveSessionByName: vi.fn(),
}));

import { journalExistsAsync, findToolResultAsync } from '../../journal/reader.async.js';
import { loadJournalMessages } from '../../journal/reader.js';
import { readdir, stat } from 'node:fs/promises';
import { resolveSessionByName } from '../../trace/session-name-resolver.js';
import type { JournalMessage, ToolResultLookup } from '../../journal/types.js';

const mockJournalExistsAsync = vi.mocked(journalExistsAsync);
const mockFindToolResultAsync = vi.mocked(findToolResultAsync);
const mockLoadJournalMessages = vi.mocked(loadJournalMessages);
const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);
const mockResolveSessionByName = vi.mocked(resolveSessionByName);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESS_A = 'sess-aaa111';
const SESS_B = 'sess-bbb222';

/** Make readdir + stat return a single session with a journal. */
function setupLatestSession(sessionId: string, mtimeMs = 1000): void {
  mockReaddir.mockResolvedValue([sessionId] as unknown as Awaited<ReturnType<typeof readdir>>);
  mockStat.mockResolvedValue({ isFile: () => true, mtimeMs } as unknown as Awaited<ReturnType<typeof stat>>);
}

/** Make readdir return nothing (empty sessions dir). */
function setupNoSessions(): void {
  mockReaddir.mockResolvedValue([] as unknown as Awaited<ReturnType<typeof readdir>>);
}

function makeToolResultLookup(text: string): ToolResultLookup {
  return {
    block: {
      type: 'tool_result',
      toolUseId: 'tu_abc',
      isError: false,
      content: [{ type: 'text', text }],
    },
  } as unknown as ToolResultLookup;
}

function makeMessages(count: number): JournalMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `Message ${i}` }],
  })) as unknown as JournalMessage[];
}

const signal = new AbortController().signal;

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('readJournalHandler — input validation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('null input → isError', async () => {
    const res = await readJournalHandler(null, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/invalid input/i);
  });

  it('string input → isError', async () => {
    const res = await readJournalHandler('latest' as unknown, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/invalid input/i);
  });

  it('number input → isError', async () => {
    const res = await readJournalHandler(42 as unknown, signal);
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R1.2: tool_use_id length cap
// ---------------------------------------------------------------------------

describe('readJournalHandler — tool_use_id length cap (R1.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupLatestSession(SESS_A);
  });

  it('tool_use_id of exactly 512 chars → allowed (delegates to findToolResultAsync)', async () => {
    const id512 = 'x'.repeat(512);
    mockFindToolResultAsync.mockResolvedValue(null);
    const res = await readJournalHandler({ tool_use_id: id512 }, signal);
    expect(res.isError).toBeUndefined();
    expect(mockFindToolResultAsync).toHaveBeenCalledWith(SESS_A, id512);
  });

  it('tool_use_id of 513 chars → isError before any journal read', async () => {
    const id513 = 'x'.repeat(513);
    const res = await readJournalHandler({ tool_use_id: id513 }, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/tool_use_id exceeds maximum length/);
    expect(mockFindToolResultAsync).not.toHaveBeenCalled();
  });

  it('tool_use_id of 1000 chars → isError', async () => {
    const res = await readJournalHandler({ tool_use_id: 'a'.repeat(1000) }, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/512/);
  });
});

// ---------------------------------------------------------------------------
// R1.1: Session resolution — "latest" uses journal-native resolver
// ---------------------------------------------------------------------------

describe('readJournalHandler — session resolution (R1.1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('"latest" (omitted session) resolves to newest session with journal.jsonl', async () => {
    setupLatestSession(SESS_A);
    mockLoadJournalMessages.mockReturnValue(makeMessages(2));
    const res = await readJournalHandler({}, signal);
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content as string);
    expect(parsed.sessionId).toBe(SESS_A);
  });

  it('"latest" with two sessions returns the one with higher mtime', async () => {
    mockReaddir.mockResolvedValue([SESS_A, SESS_B] as unknown as Awaited<ReturnType<typeof readdir>>);
    // SESS_B has higher mtime
    mockStat
      .mockResolvedValueOnce({ isFile: () => true, mtimeMs: 500 } as unknown as Awaited<ReturnType<typeof stat>>)
      .mockResolvedValueOnce({ isFile: () => true, mtimeMs: 900 } as unknown as Awaited<ReturnType<typeof stat>>);
    mockLoadJournalMessages.mockReturnValue(makeMessages(1));
    const res = await readJournalHandler({ session: 'latest' }, signal);
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content as string);
    expect(parsed.sessionId).toBe(SESS_B);
  });

  it('no sessions → isError "No sessions found"', async () => {
    setupNoSessions();
    const res = await readJournalHandler({}, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/no sessions found/i);
  });

  it('sessions dir ENOENT → isError "No sessions found"', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReaddir.mockRejectedValue(err);
    const res = await readJournalHandler({}, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/no sessions found/i);
  });

  it('direct valid session ID with journal → resolves directly', async () => {
    mockJournalExistsAsync.mockResolvedValue(true);
    mockLoadJournalMessages.mockReturnValue(makeMessages(1));
    const res = await readJournalHandler({ session: SESS_A }, signal);
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content as string);
    expect(parsed.sessionId).toBe(SESS_A);
    // should NOT have called the latest resolver
    expect(mockReaddir).not.toHaveBeenCalled();
  });

  it('direct valid session ID with no journal → error about missing journal', async () => {
    mockJournalExistsAsync.mockResolvedValue(false);
    const res = await readJournalHandler({ session: SESS_A }, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/No message journal found/);
  });

  it('session name resolved via resolveSessionByName → uses resolved ID', async () => {
    // Use a raw value that isSafeLedgerSessionId rejects (contains a space)
    // so the handler falls through to the name-resolver branch.
    const humanName = 'my session with spaces';
    mockResolveSessionByName.mockReturnValue({
      sessionId: SESS_B,
      sidecarId: SESS_B,
      name: humanName,
    } as unknown as ReturnType<typeof resolveSessionByName>);
    mockJournalExistsAsync.mockResolvedValue(true);
    mockLoadJournalMessages.mockReturnValue(makeMessages(1));
    const res = await readJournalHandler({ session: humanName }, signal);
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content as string);
    expect(parsed.sessionId).toBe(SESS_B);
  });

  it('invalid session identifier → error', async () => {
    mockJournalExistsAsync.mockResolvedValue(false);
    mockResolveSessionByName.mockReturnValue(undefined);
    const res = await readJournalHandler({ session: '../../etc/passwd' }, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/invalid or unresolvable/i);
  });
});

// ---------------------------------------------------------------------------
// Tool-result lookup mode
// ---------------------------------------------------------------------------

describe('readJournalHandler — tool-result lookup mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupLatestSession(SESS_A);
  });

  it('hit: returns result JSON with text and truncated:false', async () => {
    const lookup = makeToolResultLookup('hello world');
    mockFindToolResultAsync.mockResolvedValue(lookup);
    const res = await readJournalHandler({ tool_use_id: 'tu_abc' }, signal);
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content as string);
    expect(parsed.result).toBe('hello world');
    expect(parsed.truncated).toBe(false);
    expect(parsed.tool_use_id).toBe('tu_abc');
    expect(parsed.sessionId).toBe(SESS_A);
  });

  it('miss: returns null result with explanatory note', async () => {
    mockFindToolResultAsync.mockResolvedValue(null);
    const res = await readJournalHandler({ tool_use_id: 'tu_missing' }, signal);
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content as string);
    expect(parsed.result).toBeNull();
    expect(parsed.note).toMatch(/not found/i);
  });

  it('64 KB truncation: long result is capped with truncation marker', async () => {
    const longText = 'x'.repeat(70_000);
    mockFindToolResultAsync.mockResolvedValue(makeToolResultLookup(longText));
    const res = await readJournalHandler({ tool_use_id: 'tu_big' }, signal);
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content as string);
    expect(parsed.truncated).toBe(true);
    expect(parsed.result).toMatch(/truncated at 64 KB/);
    // Result text should be shorter than the original 70 000 chars
    expect((parsed.result as string).length).toBeLessThan(70_000);
  });

  it('R1.3: multi-byte char split at 64 KB boundary does not emit U+FFFD', async () => {
    // Build a string whose UTF-8 encoding puts a 3-byte character (€ = 0xE2 0x82 0xAC)
    // straddling the MAX_RESULT_BYTES (65536) boundary.
    // Fill with ASCII up to 65534 bytes, then append '€' (3 bytes: positions 65534–65536).
    // The subarray cut at 65536 lands exactly after the last byte of '€', so no split
    // actually occurs here — we also test the split case by sizing to 65535.
    const ASCII_FILL = 65_536 - 3; // 65533 bytes of ASCII
    // Pad so that '€' starts at byte 65533, ending at byte 65535 (0-indexed).
    // Then append more ASCII so total > 65536 to trigger truncation.
    const textWithMultibyte = 'a'.repeat(ASCII_FILL) + '€' + 'b'.repeat(100);
    // Verify our construction: the byte at index 65535 is the last byte of '€'.
    // subarray(0, 65536) keeps all 3 bytes → no split → no U+FFFD.
    mockFindToolResultAsync.mockResolvedValue(makeToolResultLookup(textWithMultibyte));
    const res = await readJournalHandler({ tool_use_id: 'tu_multibyte_ok' }, signal);
    const parsed = JSON.parse(res.content as string);
    expect(parsed.truncated).toBe(true);
    expect(parsed.result).not.toContain('\uFFFD');

    // Now test the split case: ASCII fill of 65534 puts '€' at bytes 65534–65536,
    // so subarray(0, 65536) cuts after the second byte → incomplete sequence → U+FFFD
    // without the fix. With the fix, U+FFFD must be stripped.
    const textSplitBoundary = 'a'.repeat(65_534) + '€' + 'b'.repeat(100);
    mockFindToolResultAsync.mockResolvedValue(makeToolResultLookup(textSplitBoundary));
    const res2 = await readJournalHandler({ tool_use_id: 'tu_multibyte_split' }, signal);
    const parsed2 = JSON.parse(res2.content as string);
    expect(parsed2.truncated).toBe(true);
    expect(parsed2.result).not.toContain('\uFFFD');
    expect(parsed2.result).toMatch(/truncated at 64 KB/);
  });

  it('R1.4: 4-byte char (😀 U+1F600) split at 64 KB boundary does not emit U+FFFD', async () => {
    // 😀 encodes to 4 UTF-8 bytes: 0xF0 0x9F 0x98 0x80.
    // Depending on the split position (after byte 1, 2, or 3 of the sequence)
    // Node can produce 1–3 U+FFFD replacement characters. The guard must strip
    // all of them regardless of split position.
    //
    // Case A: cut after byte 1 of 😀 (3 replacement chars possible)
    //   Fill 65535 ASCII bytes, then '😀' at bytes 65535–65538 → cut at 65536
    //   keeps only the first byte of the 4-byte sequence.
    const textSplit1 = 'a'.repeat(65_535) + '😀' + 'b'.repeat(100);
    mockFindToolResultAsync.mockResolvedValue(makeToolResultLookup(textSplit1));
    const res3 = await readJournalHandler({ tool_use_id: 'tu_4byte_split1' }, signal);
    const parsed3 = JSON.parse(res3.content as string);
    expect(parsed3.truncated).toBe(true);
    expect(parsed3.result).not.toContain('\uFFFD');
    expect(parsed3.result).toMatch(/truncated at 64 KB/);

    // Case B: cut after byte 2 of 😀 (2 replacement chars possible)
    //   Fill 65534 ASCII bytes → 😀 at bytes 65534–65537 → cut at 65536
    //   keeps the first two bytes of the 4-byte sequence.
    const textSplit2 = 'a'.repeat(65_534) + '😀' + 'b'.repeat(100);
    mockFindToolResultAsync.mockResolvedValue(makeToolResultLookup(textSplit2));
    const res4 = await readJournalHandler({ tool_use_id: 'tu_4byte_split2' }, signal);
    const parsed4 = JSON.parse(res4.content as string);
    expect(parsed4.truncated).toBe(true);
    expect(parsed4.result).not.toContain('\uFFFD');
    expect(parsed4.result).toMatch(/truncated at 64 KB/);

    // Case C: cut after byte 3 of 😀 (1 replacement char possible)
    //   Fill 65533 ASCII bytes → 😀 at bytes 65533–65536 → cut at 65536
    //   keeps the first three bytes of the 4-byte sequence.
    const textSplit3 = 'a'.repeat(65_533) + '😀' + 'b'.repeat(100);
    mockFindToolResultAsync.mockResolvedValue(makeToolResultLookup(textSplit3));
    const res5 = await readJournalHandler({ tool_use_id: 'tu_4byte_split3' }, signal);
    const parsed5 = JSON.parse(res5.content as string);
    expect(parsed5.truncated).toBe(true);
    expect(parsed5.result).not.toContain('\uFFFD');
    expect(parsed5.result).toMatch(/truncated at 64 KB/);
  });

  it('findToolResultAsync throws → isError with message', async () => {
    mockFindToolResultAsync.mockRejectedValue(new Error('disk read failed'));
    const res = await readJournalHandler({ tool_use_id: 'tu_err' }, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/read_journal failed/);
    expect(res.content).toMatch(/disk read failed/);
  });

  it('subagent result includes subagent_id field', async () => {
    const lookup: ToolResultLookup = {
      ...makeToolResultLookup('sub result'),
      subagentId: 'sub-xyz',
    } as unknown as ToolResultLookup;
    mockFindToolResultAsync.mockResolvedValue(lookup);
    const res = await readJournalHandler({ tool_use_id: 'tu_sub' }, signal);
    const parsed = JSON.parse(res.content as string);
    expect(parsed.subagent_id).toBe('sub-xyz');
  });
});

// ---------------------------------------------------------------------------
// Conversation messages mode
// ---------------------------------------------------------------------------

describe('readJournalHandler — conversation messages mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupLatestSession(SESS_A);
  });

  it('returns message summaries with correct structure', async () => {
    mockLoadJournalMessages.mockReturnValue(makeMessages(3));
    const res = await readJournalHandler({}, signal);
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content as string);
    expect(parsed.sessionId).toBe(SESS_A);
    expect(Array.isArray(parsed.messages)).toBe(true);
    expect(parsed.returned).toBe(3);
    expect(parsed.total).toBe(3);
  });

  it('limit clamping: limit>100 is clamped to 100', async () => {
    mockLoadJournalMessages.mockReturnValue(makeMessages(100));
    const res = await readJournalHandler({ limit: 999 }, signal);
    const parsed = JSON.parse(res.content as string);
    expect(parsed.returned).toBeLessThanOrEqual(100);
  });

  it('limit clamping: limit<1 is clamped to 1', async () => {
    mockLoadJournalMessages.mockReturnValue(makeMessages(5));
    const res = await readJournalHandler({ limit: 0 }, signal);
    const parsed = JSON.parse(res.content as string);
    expect(parsed.returned).toBe(1);
  });

  it('default limit is 20: returns at most 20 messages', async () => {
    mockLoadJournalMessages.mockReturnValue(makeMessages(50));
    const res = await readJournalHandler({}, signal);
    const parsed = JSON.parse(res.content as string);
    expect(parsed.returned).toBe(20);
    expect(parsed.total).toBe(50);
    expect(parsed.note).toMatch(/showing last 20/i);
  });

  it('kinds filtering: only matching messages returned', async () => {
    const msgs: JournalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ] as unknown as JournalMessage[];
    mockLoadJournalMessages.mockReturnValue(msgs);
    const res = await readJournalHandler({ kinds: ['user'] }, signal);
    const parsed = JSON.parse(res.content as string);
    expect(parsed.returned).toBe(1);
    expect(parsed.messages[0].role).toBe('user');
  });

  it('invalid kinds values are filtered out (non-strings ignored)', async () => {
    mockLoadJournalMessages.mockReturnValue(makeMessages(2));
    // kinds contains non-string entries and unknown kind — should still work
    const res = await readJournalHandler({ kinds: [42, 'user', null, 'unknown_kind'] }, signal);
    expect(res.isError).toBeUndefined();
  });

  it('empty journal → returns empty messages array with note', async () => {
    mockLoadJournalMessages.mockReturnValue(null);
    const res = await readJournalHandler({}, signal);
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content as string);
    expect(parsed.messages).toEqual([]);
    expect(parsed.returned).toBe(0);
    expect(parsed.note).toMatch(/empty|absent|disabled/i);
  });

  it('loadJournalMessages throws → isError with message', async () => {
    mockLoadJournalMessages.mockImplementation(() => { throw new Error('corrupt journal'); });
    const res = await readJournalHandler({}, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/read_journal failed/);
    expect(res.content).toMatch(/corrupt journal/);
  });
});
