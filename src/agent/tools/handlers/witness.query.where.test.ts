/**
 * Tests for the `where` filter, matchLimitReached honesty, and
 * current-session exclusion (witness.query.where.ts + its wiring into
 * witness.query.ts and the witness tool handlers).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { matchesWhere, parseWhere, WitnessWhereError, isCurrentSession, currentSessionRef } from './witness.query.where.js';
import { readSessionTrace, searchAcrossSessions, MAX_SEARCH_MATCHES } from './witness.query.js';
import { readWitnessHandler, searchWitnessHandler } from './witness.js';

const signal = new AbortController().signal;
let tmpHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'afk-witness-where-test-'));
  savedHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpHome;
  delete process.env['AFK_STATE_DIR'];
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedHome;
  await rm(tmpHome, { recursive: true, force: true }).catch(() => {});
});

function line(kind: string, seq: number, payload: Record<string, unknown>): string {
  return JSON.stringify({ kind, seq, ts: new Date().toISOString(), payload });
}

async function writeTrace(label: string, lines: string[]): Promise<string> {
  const dir = join(tmpHome, 'state', 'witness', label);
  await mkdir(dir, { recursive: true });
  const p = join(dir, 'trace.jsonl');
  await writeFile(p, lines.join('\n') + '\n', 'utf-8');
  return p;
}

const block = (seq: number) => line('hook_decision', seq, { hookEvent: 'PreToolUse', decision: 'block', reason: 'hook says no' });
const approve = (seq: number) => line('hook_decision', seq, { hookEvent: 'SessionStart', decision: 'approve', reason: 'hook ok' });

describe('parseWhere / matchesWhere', () => {
  const ev = { kind: 'hook_decision', seq: 1, payload: { hookEvent: 'PreToolUse', decision: 'block', nested: { n: 3, z: null } } };

  it('matches on exact scalar equality with AND semantics', () => {
    expect(matchesWhere(ev, parseWhere({ kind: 'hook_decision', 'payload.decision': 'block' }))).toBe(true);
    expect(matchesWhere(ev, parseWhere({ kind: 'hook_decision', 'payload.decision': 'approve' }))).toBe(false);
  });

  it('walks nested paths and compares numbers/null exactly', () => {
    expect(matchesWhere(ev, parseWhere({ 'payload.nested.n': 3 }))).toBe(true);
    expect(matchesWhere(ev, parseWhere({ 'payload.nested.n': '3' }))).toBe(false);
    expect(matchesWhere(ev, parseWhere({ 'payload.nested.z': null }))).toBe(true);
  });

  it('treats unresolved paths as a mismatch (including null-for-missing)', () => {
    expect(matchesWhere(ev, parseWhere({ 'payload.missing': null }))).toBe(false);
    expect(matchesWhere(ev, parseWhere({ 'payload.decision.deeper': 'x' }))).toBe(false);
  });

  it('does not walk inherited properties', () => {
    expect(matchesWhere(ev, parseWhere({ 'payload.toString': 'x' }))).toBe(false);
  });

  it.each(['__proto__', 'payload.constructor', 'payload.prototype.x'])('rejects forbidden segment in %s', (path) => {
    expect(() => parseWhere({ [path]: 'x' })).toThrow(WitnessWhereError);
  });

  it('rejects own __proto__ key created via JSON.parse', () => {
    expect(() => parseWhere(JSON.parse('{"__proto__": "x"}'))).toThrow(/forbidden segment/);
  });

  it('rejects non-object where, non-scalar values, empty segments', () => {
    expect(() => parseWhere('kind')).toThrow(WitnessWhereError);
    expect(() => parseWhere([])).toThrow(WitnessWhereError);
    expect(() => parseWhere({ kind: { a: 1 } })).toThrow(/must be a string/);
    expect(() => parseWhere({ 'payload..x': 1 })).toThrow(/empty segment/);
  });

  it('returns undefined when absent', () => {
    expect(parseWhere(undefined)).toBeUndefined();
  });
});

describe('searchAcrossSessions with where', () => {
  it('keeps only rows matching every where entry', async () => {
    await writeTrace('s1', [block(0), approve(1), line('tool_call', 2, { phase: 'completed', name: 'hook' })]);
    const res = await searchAcrossSessions({ query: 'hook', where: parseWhere({ 'payload.decision': 'block' }) });
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]?.event.payload).toMatchObject({ decision: 'block' });
    expect(res.matches[0]?.matchLine).toContain('"block"');
    expect(res.matchLimitReached).toBeUndefined();
  });

  it('read_witness supports where too', async () => {
    await writeTrace('s2', [block(0), approve(1)]);
    const res = await readSessionTrace({ session: 's2', where: parseWhere({ 'payload.hookEvent': 'SessionStart' }) });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]?.kind).toBe('hook_decision');
  });
});

describe('searchAcrossSessions matchLimitReached', () => {
  it('sets matchLimitReached + hint when the cap stops the scan', async () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_SEARCH_MATCHES + 5; i++) lines.push(block(i));
    await writeTrace('big', lines);
    const res = await searchAcrossSessions({ query: 'hook' });
    expect(res.matches).toHaveLength(MAX_SEARCH_MATCHES);
    expect(res.matchLimitReached).toBe(true);
    expect(res.hint).toMatch(/where/);
  });

  it('omits matchLimitReached when results fit under the cap', async () => {
    await writeTrace('small', [block(0)]);
    const res = await searchAcrossSessions({ query: 'hook' });
    expect(res).not.toHaveProperty('matchLimitReached');
    expect(res).not.toHaveProperty('hint');
  });
});

describe('current-session exclusion', () => {
  it('excludes the caller trace by path by default and reports it', async () => {
    await writeTrace('other', [block(0)]);
    const mine = await writeTrace('mine-label', [block(0), block(1)]);
    const res = await searchAcrossSessions({ query: 'hook', currentSession: { tracePath: mine } });
    expect(res.matches.map((m) => m.sessionId)).toEqual(['other']);
    expect(res.excludedCurrentSession).toBe(true);
  });

  it('excludes by sessionId when no path is known; opt-in includes it', async () => {
    await writeTrace('sid-1', [block(0)]);
    const excluded = await searchAcrossSessions({ query: 'hook', currentSession: { sessionId: 'sid-1' } });
    expect(excluded.matches).toHaveLength(0);
    const included = await searchAcrossSessions({
      query: 'hook',
      currentSession: { sessionId: 'sid-1' },
      includeCurrentSession: true,
    });
    expect(included.matches).toHaveLength(1);
    expect(included).not.toHaveProperty('excludedCurrentSession');
  });

  it('currentSessionRef ignores the in-memory sentinel path', () => {
    expect(currentSessionRef({ traceWriter: { getTracePath: () => 'in-memory://trace' } })).toBeUndefined();
    expect(currentSessionRef({ sessionId: 'abc' })).toEqual({ sessionId: 'abc' });
    expect(isCurrentSession({ sessionId: 'x', tracePath: '/a/x/trace.jsonl' }, undefined)).toBe(false);
  });
});

describe('witness handlers', () => {
  it('search_witness returns a tool error for a forbidden where segment', async () => {
    const res = await searchWitnessHandler({ query: 'hook', where: { 'payload.__proto__': 'x' } }, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/invalid where: .*forbidden segment "__proto__"/);
  });

  it('read_witness returns a tool error for a non-scalar where value', async () => {
    const res = await readWitnessHandler({ where: { kind: ['a'] } }, signal);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/invalid where/);
  });

  it('search_witness excludes the caller trace from handler context', async () => {
    await writeTrace('peer', [block(0)]);
    const mine = await writeTrace('self', [block(0)]);
    const res = await searchWitnessHandler({ query: 'hook' }, signal, {
      traceWriter: { getTracePath: () => mine, write: async () => {} },
    });
    const parsed = JSON.parse(res.content) as { matches: { sessionId: string }[]; excludedCurrentSession?: boolean };
    expect(parsed.matches.map((m) => m.sessionId)).toEqual(['peer']);
    expect(parsed.excludedCurrentSession).toBe(true);
  });
});
