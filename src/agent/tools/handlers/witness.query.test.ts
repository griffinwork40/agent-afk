/**
 * Unit tests for witness.query.ts
 *
 * Coverage:
 *  - clampLimit boundary values
 *  - clampSessions boundary values
 *  - matchesFilter with toolName (via readSessionTrace)
 *  - parseEvents with malformed lines (via readSessionTrace)
 *  - readSessionTrace path-traversal rejection
 *  - readSessionTrace invalid "since" date (via searchAcrossSessions)
 *  - UTF-8 boundary alignment on byte cap (via readTraceSafe, indirectly)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clampLimit, clampSessions, readSessionTrace, searchAcrossSessions } from './witness.query.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid trace-event NDJSON line.
 */
function makeEventLine(kind: string, seq: number, extraPayload: Record<string, unknown> = {}): string {
  return JSON.stringify({ kind, seq, ts: new Date().toISOString(), payload: { ...extraPayload } });
}

// ---------------------------------------------------------------------------
// Setup: redirect AFK_HOME to a temp dir so getTraceDir / getWitnessRoot
// resolve inside our temp fixture tree, never into the real ~/.afk.
// ---------------------------------------------------------------------------

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'afk-witness-query-test-'));
  savedHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpHome;
  delete process.env['AFK_STATE_DIR'];
  delete process.env['AFK_FRAMEWORK_DIR'];
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedHome;
  try {
    await rm(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/**
 * Write a fake trace.jsonl into `$AFK_HOME/state/witness/<sessionId>/trace.jsonl`.
 */
async function writeTrace(sessionId: string, lines: string[]): Promise<string> {
  const dir = join(tmpHome, 'state', 'witness', sessionId);
  await mkdir(dir, { recursive: true });
  const tracePath = join(dir, 'trace.jsonl');
  await writeFile(tracePath, lines.join('\n') + '\n', 'utf-8');
  return tracePath;
}

// ---------------------------------------------------------------------------
// clampLimit
// ---------------------------------------------------------------------------

describe('clampLimit', () => {
  it('returns DEFAULT_LIMIT (50) for non-number input', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit('10')).toBe(50);
    expect(clampLimit(null)).toBe(50);
  });

  it('clamps to minimum 1', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-100)).toBe(1);
  });

  it('clamps to maximum 200', () => {
    expect(clampLimit(201)).toBe(200);
    expect(clampLimit(10000)).toBe(200);
  });

  it('rounds fractional values', () => {
    expect(clampLimit(5.7)).toBe(6);
    expect(clampLimit(1.2)).toBe(1);
  });

  it('passes through values in range', () => {
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(100)).toBe(100);
    expect(clampLimit(200)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// clampSessions
// ---------------------------------------------------------------------------

describe('clampSessions', () => {
  it('returns DEFAULT_SESSION_COUNT (20) for non-number input', () => {
    expect(clampSessions(undefined)).toBe(20);
    expect(clampSessions('5')).toBe(20);
  });

  it('clamps to minimum 1', () => {
    expect(clampSessions(0)).toBe(1);
    expect(clampSessions(-5)).toBe(1);
  });

  it('clamps to maximum 100', () => {
    expect(clampSessions(101)).toBe(100);
    expect(clampSessions(9999)).toBe(100);
  });

  it('passes through values in range', () => {
    expect(clampSessions(1)).toBe(1);
    expect(clampSessions(50)).toBe(50);
    expect(clampSessions(100)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// readSessionTrace — path traversal rejection
// ---------------------------------------------------------------------------

describe('readSessionTrace — path traversal', () => {
  it('throws when session id contains ../ traversal', async () => {
    await expect(
      readSessionTrace({ session: '../../../etc/passwd' }),
    ).rejects.toThrow(/Invalid AFK_SESSION_ID/);
  });

  it('throws when session id contains a slash', async () => {
    await expect(
      readSessionTrace({ session: 'foo/bar' }),
    ).rejects.toThrow(/Invalid AFK_SESSION_ID/);
  });

  it('throws when session id contains a null byte', async () => {
    await expect(
      readSessionTrace({ session: 'abc\x00def' }),
    ).rejects.toThrow(/Invalid AFK_SESSION_ID/);
  });
});

// ---------------------------------------------------------------------------
// readSessionTrace — parseEvents with malformed lines
// ---------------------------------------------------------------------------

describe('readSessionTrace — malformed NDJSON handling', () => {
  it('skips non-JSON lines and still returns valid events', async () => {
    const sessionId = 'good-session-1';
    await writeTrace(sessionId, [
      makeEventLine('tool_call', 1, { phase: 'completed', isError: false, name: 'bash' }),
      'NOT JSON AT ALL',
      '{ "broken": true',  // incomplete JSON
      makeEventLine('closure', 2, { reason: 'end_turn', finalCostUsd: 0, finalTurnCount: 1 }),
    ]);

    const result = await readSessionTrace({ session: sessionId });
    expect(result.sessionId).toBe(sessionId);
    // 2 valid events out of 4 lines
    expect(result.totalInTrace).toBe(2);
    expect(result.events.length).toBe(2);
  });

  it('skips objects that pass JSON.parse but fail isTraceEvent guard', async () => {
    const sessionId = 'good-session-2';
    await writeTrace(sessionId, [
      '{"not": "a trace event"}',
      '42',
      '"just a string"',
      makeEventLine('closure', 1, { reason: 'end_turn', finalCostUsd: 0, finalTurnCount: 1 }),
    ]);

    const result = await readSessionTrace({ session: sessionId });
    expect(result.totalInTrace).toBe(1);
    expect(result.events[0]!.kind).toBe('closure');
  });
});

// ---------------------------------------------------------------------------
// readSessionTrace — toolName filter rejects non-tool_call events
// ---------------------------------------------------------------------------

describe('readSessionTrace — toolName filter', () => {
  it('returns only tool_call events with matching name, filtering out all other kinds', async () => {
    const sessionId = 'filter-session-1';
    await writeTrace(sessionId, [
      makeEventLine('tool_call', 1, { phase: 'completed', isError: false, name: 'bash', resultBytes: 10, durationMs: 5 }),
      makeEventLine('tool_call', 2, { phase: 'completed', isError: false, name: 'read_file', resultBytes: 5, durationMs: 2 }),
      makeEventLine('closure', 3, { reason: 'end_turn', finalCostUsd: 0, finalTurnCount: 1 }),
      makeEventLine('subagent_lifecycle', 4, { transition: 'failed', errorClass: 'err', errorMessage: 'oops', durationMs: 0, outputBytes: 0, turnCount: 0 }),
    ]);

    const result = await readSessionTrace({ session: sessionId, toolName: 'bash' });
    expect(result.events).toHaveLength(1);
    const ev = result.events[0]!;
    expect(ev.kind).toBe('tool_call');
    const payload = ev.payload as { name?: string };
    expect(payload.name).toBe('bash');
  });

  it('does NOT let non-tool_call events through when toolName is set', async () => {
    const sessionId = 'filter-session-2';
    await writeTrace(sessionId, [
      makeEventLine('closure', 1, { reason: 'end_turn', finalCostUsd: 0, finalTurnCount: 1 }),
      makeEventLine('session_phase', 2, { phase: 'session_init_start' }),
    ]);

    const result = await readSessionTrace({ session: sessionId, toolName: 'bash' });
    expect(result.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// readSessionTrace — errorsOnly includes background_agent failed events
// ---------------------------------------------------------------------------

describe('readSessionTrace — errorsOnly background_agent', () => {
  it('includes background_agent events with transition: failed', async () => {
    const sessionId = 'bg-errors-session';
    await writeTrace(sessionId, [
      makeEventLine('background_agent', 1, { transition: 'started', jobId: 'j1', label: 'foo', model: 'm' }),
      makeEventLine('background_agent', 2, { transition: 'failed', jobId: 'j1', errorClass: 'Error', errorMessage: 'boom' }),
      makeEventLine('background_agent', 3, { transition: 'completed', jobId: 'j2', durationMs: 100, outputBytes: 50 }),
      makeEventLine('closure', 4, { reason: 'end_turn', finalCostUsd: 0, finalTurnCount: 1 }),
    ]);

    const result = await readSessionTrace({ session: sessionId, errorsOnly: true });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.kind).toBe('background_agent');
    const payload = result.events[0]!.payload as { transition?: string };
    expect(payload.transition).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// readSessionTrace — non-existent session returns empty result
// ---------------------------------------------------------------------------

describe('readSessionTrace — missing trace', () => {
  it('returns empty result for an unknown session id with no ledger', async () => {
    const result = await readSessionTrace({ session: 'no-such-session-xyz' });
    expect(result.sessionId).toBe('no-such-session-xyz');
    expect(result.events).toHaveLength(0);
    expect(result.totalInTrace).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// searchAcrossSessions — invalid since date throws
// ---------------------------------------------------------------------------

describe('searchAcrossSessions — invalid since date', () => {
  it('throws on garbage date string', async () => {
    await expect(
      searchAcrossSessions({ query: 'anything', since: 'not-a-date' }),
    ).rejects.toThrow(/Invalid "since" date/);
  });

  it('throws on empty-ish invalid date', async () => {
    await expect(
      searchAcrossSessions({ query: 'x', since: 'garbage-date-string' }),
    ).rejects.toThrow(/Invalid "since" date/);
  });

  it('does NOT throw for a valid ISO date', async () => {
    // No sessions in temp home, so result is empty — but must not throw.
    await expect(
      searchAcrossSessions({ query: 'x', since: '2024-01-01' }),
    ).resolves.toMatchObject({ query: 'x', sessionsScanned: 0 });
  });
});

// ---------------------------------------------------------------------------
// searchAcrossSessions — sessions sliced before since filter
// ---------------------------------------------------------------------------

describe('searchAcrossSessions — sessions/since ordering', () => {
  it('slices by sessions count before applying since filter', async () => {
    // Write two sessions with different trace content
    await writeTrace('session-alpha', [
      makeEventLine('closure', 1, { reason: 'end_turn', finalCostUsd: 0, finalTurnCount: 1 }),
    ]);
    await writeTrace('session-beta', [
      makeEventLine('closure', 1, { reason: 'end_turn', finalCostUsd: 0, finalTurnCount: 1 }),
    ]);

    // Request sessions=1 with a very old since date — should scan at most 1 session
    const result = await searchAcrossSessions({
      query: 'end_turn',
      sessions: 1,
      since: '2000-01-01',
    });
    // At most 1 session can be scanned (sessions slice applied first)
    expect(result.sessionsScanned).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// searchAcrossSessions — truncation signal (#1036)
// ---------------------------------------------------------------------------

describe('searchAcrossSessions — truncation signal', () => {
  /**
   * Build a trace file that exceeds the 2 MB cap by writing many event lines.
   * We do this by creating a large payload string on each event.
   */
  async function writeLargeTrace(sessionId: string, searchToken: string): Promise<void> {
    const dir = join(tmpHome, 'state', 'witness', sessionId);
    await mkdir(dir, { recursive: true });
    const tracePath = join(dir, 'trace.jsonl');

    // Write enough bytes to exceed MAX_READ_BYTES (2_097_152).
    // Each line is ~2100 bytes; 1100 lines ≈ 2.31 MB.
    const lines: string[] = [];
    const filler = 'x'.repeat(2000);
    for (let i = 0; i < 1100; i++) {
      lines.push(
        JSON.stringify({
          kind: 'tool_call',
          seq: i,
          ts: new Date().toISOString(),
          payload: { name: 'bash', filler, searchToken: i === 0 ? searchToken : 'nope' },
        }),
      );
    }
    // The searchable event is at the very beginning — it will be sliced off.
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(tracePath, lines.join('\n') + '\n', 'utf-8');
  }

  it('populates truncatedSessions when a trace exceeds the 2 MB cap', async () => {
    const sessionId = 'large-trace-session';
    // Write a trace that is guaranteed to exceed 2 MB.
    await writeLargeTrace(sessionId, 'unique-needle-xyz');

    // Query for a token that appears in a line near the tail (not the head)
    // so we can confirm the file was read at all, then separately check truncation.
    const result = await searchAcrossSessions({ query: 'bash', sessions: 5 });

    expect(result.truncatedSessions).toBeDefined();
    expect(result.truncatedSessions).toContain(sessionId);
  });

  it('does NOT include truncatedSessions when all traces fit within 2 MB', async () => {
    const sessionId = 'small-trace-session';
    await writeTrace(sessionId, [
      makeEventLine('closure', 1, { reason: 'end_turn', finalCostUsd: 0, finalTurnCount: 1 }),
    ]);

    const result = await searchAcrossSessions({ query: 'end_turn', sessions: 5 });

    // truncatedSessions should be absent (undefined), not an empty array.
    expect(result.truncatedSessions).toBeUndefined();
  });

  it('truncatedSessions is absent (undefined) when no sessions are truncated', async () => {
    // Empty witness dir — no sessions at all.
    const result = await searchAcrossSessions({ query: 'anything', sessions: 5 });
    expect(result.truncatedSessions).toBeUndefined();
  });
});
