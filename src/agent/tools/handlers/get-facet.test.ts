/**
 * Unit tests for the get_facet handler.
 *
 * Strategy: inject AFK_STATE_DIR and AFK_HOME env vars pointing to a tmp dir
 * so listSessionIds() / getOrDeriveFacet() resolve to synthetic fixtures.
 *
 * process.env mutation is intentional in tests (audit-env-access.ts skips *.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFacetHandler } from './get-facet.js';
import { writeRecord } from '../../outcomes/store.js';
import type { VerifiedOutcome } from '../../outcomes/schema.js';
import type { ToolHandlerContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;
let origStateDir: string | undefined;
let origHome: string | undefined;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `afk-facet-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpRoot, 'state', 'sessions'), { recursive: true });
  mkdirSync(join(tmpRoot, 'agent-framework', 'facets'), { recursive: true });
  mkdirSync(join(tmpRoot, 'agent-framework', 'outcomes'), { recursive: true });

  origStateDir = process.env['AFK_STATE_DIR'];
  origHome = process.env['AFK_HOME'];
  process.env['AFK_STATE_DIR'] = join(tmpRoot, 'state');
  process.env['AFK_HOME'] = tmpRoot;
});

afterEach(() => {
  // Restore env
  if (origStateDir === undefined) {
    delete process.env['AFK_STATE_DIR'];
  } else {
    process.env['AFK_STATE_DIR'] = origStateDir;
  }
  if (origHome === undefined) {
    delete process.env['AFK_HOME'];
  } else {
    process.env['AFK_HOME'] = origHome;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeSession(sessionId: string, overrides: Record<string, unknown> = {}): void {
  const session = {
    sessionId,
    model: 'claude-3-5-sonnet',
    startedAt: Date.now() - 5000,
    savedAt: Date.now(),
    totalTurns: 1,
    turns: [{ user: 'test', assistant: 'ok', toolEvents: [] }],
    ...overrides,
  };
  writeFileSync(
    join(tmpRoot, 'state', 'sessions', `${sessionId}.json`),
    JSON.stringify(session),
    'utf-8',
  );
}

/** The three resolution-context fields always appended to every response. */
const RESOLUTION_FIELDS = ['session_cwd', 'is_current_session', 'cwd_mismatch'] as const;

const ABORT = new AbortController().signal;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getFacetHandler', () => {
  it('session: "latest" → returns JSON with session fields, no internal provenance fields', async () => {
    writeSession('sess-abc', { savedAt: Date.now() });

    const result = await getFacetHandler({ session: 'latest' }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['session_id']).toBe('sess-abc');
    expect(parsed['model']).toBe('claude-3-5-sonnet');
    // Internal provenance fields must be excluded by default
    expect(parsed['facet_version']).toBeUndefined();
    expect(parsed['derived_at']).toBeUndefined();
    expect(parsed['source_session_path']).toBeUndefined();
    expect(parsed['derived_from']).toBeUndefined();
    expect(parsed['source_session_mtime_ms']).toBeUndefined();
    // Resolution-context fields always present
    expect('session_cwd' in parsed).toBe(true);
    expect('is_current_session' in parsed).toBe(true);
    expect('cwd_mismatch' in parsed).toBe(true);
  });

  it('missing session argument → defaults to "latest" behavior', async () => {
    writeSession('sess-def');

    const result = await getFacetHandler({}, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['session_id']).toBe('sess-def');
  });

  it('session: "unknown-id-xyz" → isError: true', async () => {
    const result = await getFacetHandler({ session: 'unknown-id-xyz' }, ABORT);
    expect(result.isError).toBe(true);
    expect(result.content as string).toContain('unknown-id-xyz');
  });

  it('fields allowlist → returns requested fields plus the 3 resolution-context fields', async () => {
    writeSession('sess-fields');

    const result = await getFacetHandler(
      { session: 'sess-fields', fields: ['session_id', 'model'] },
      ABORT,
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    // 2 requested + 3 resolution-context = 5
    expect(Object.keys(parsed)).toHaveLength(5);
    expect(parsed['session_id']).toBe('sess-fields');
    expect(parsed['model']).toBe('claude-3-5-sonnet');
    for (const f of RESOLUTION_FIELDS) {
      expect(f in parsed).toBe(true);
    }
  });

  it('fields: ["derived_at"] → explicitly requesting provenance returns it', async () => {
    writeSession('sess-prov');

    const result = await getFacetHandler({ session: 'sess-prov', fields: ['derived_at'] }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(typeof parsed['derived_at']).toBe('string');
  });

  it('no sessions → isError: true for "latest"', async () => {
    const result = await getFacetHandler({ session: 'latest' }, ABORT);
    expect(result.isError).toBe(true);
  });

  it('multiple sessions → "latest" resolves by sidecar mtime, not savedAt', async () => {
    // Contract: the O(N) loadStoredSession scan (sorting by savedAt) was replaced
    // by an mtime-based scan (statSync). This test verifies mtime wins even when
    // savedAt would say otherwise — the newer-mtime file must be returned.
    writeSession('sess-older', { savedAt: Date.now() + 99999 }); // higher savedAt, older mtime
    const olderPath = join(tmpRoot, 'state', 'sessions', 'sess-older.json');

    writeSession('sess-newer', { savedAt: Date.now() - 99999 }); // lower savedAt, newer mtime
    const newerPath = join(tmpRoot, 'state', 'sessions', 'sess-newer.json');

    // Stamp older file to 1 hour ago; newer file stays at now.
    const oneHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(olderPath, oneHourAgo, oneHourAgo);
    const now = new Date();
    utimesSync(newerPath, now, now);

    const result = await getFacetHandler({ session: 'latest' }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    // sess-newer has the higher mtime → must win, despite lower savedAt
    expect(parsed['session_id']).toBe('sess-newer');
  });
});

// ---------------------------------------------------------------------------
// verified_outcome join
// ---------------------------------------------------------------------------

describe('getFacetHandler – verified_outcome join', () => {
  it('omits verified_outcome key when no outcome record exists', async () => {
    writeSession('sess-no-outcome');
    const result = await getFacetHandler({ session: 'sess-no-outcome' }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect('verified_outcome' in parsed).toBe(false);
  });

  it('includes verified_outcome when a record exists', async () => {
    writeSession('sess-with-outcome');
    const outcome: VerifiedOutcome = {
      schema_version: 1,
      session_id: 'sess-with-outcome',
      label: 'succeeded',
      confidence: 1.0,
      state: 'settled',
      settles_after: null,
      session_kind: 'text',
      self_report: 'done',
      artifacts: { commits: [], prs: [], repo: null },
      votes: [{ lf: 'explicit_feedback', vote: 1, strength: 'strong', evidence: 'operator', observed_at: new Date().toISOString() }],
      history: [],
    };
    const outcomesDir = join(tmpRoot, 'agent-framework', 'outcomes');
    writeRecord(outcome, outcomesDir);

    const result = await getFacetHandler({ session: 'sess-with-outcome' }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['verified_outcome']).toBeDefined();
    const vo = parsed['verified_outcome'] as VerifiedOutcome;
    expect(vo.label).toBe('succeeded');
    expect(vo.confidence).toBe(1.0);
    expect(vo.state).toBe('settled');
  });

  it('returns verified_outcome plus resolution-context fields when explicitly requested via fields', async () => {
    writeSession('sess-field-vo');
    const outcome: VerifiedOutcome = {
      schema_version: 1,
      session_id: 'sess-field-vo',
      label: 'failed',
      confidence: 1.0,
      state: 'settled',
      settles_after: null,
      session_kind: 'text',
      self_report: 'none',
      artifacts: { commits: [], prs: [], repo: null },
      votes: [],
      history: [],
    };
    const outcomesDir = join(tmpRoot, 'agent-framework', 'outcomes');
    writeRecord(outcome, outcomesDir);

    const result = await getFacetHandler({ session: 'sess-field-vo', fields: ['verified_outcome'] }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    // 1 requested + 3 resolution-context = 4
    expect(Object.keys(parsed)).toHaveLength(4);
    const vo = parsed['verified_outcome'] as VerifiedOutcome;
    expect(vo.label).toBe('failed');
    for (const f of RESOLUTION_FIELDS) {
      expect(f in parsed).toBe(true);
    }
  });

  it('returns null for verified_outcome when field explicitly requested but no record', async () => {
    writeSession('sess-null-vo');
    const result = await getFacetHandler({ session: 'sess-null-vo', fields: ['verified_outcome'] }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['verified_outcome']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resolution-context fields: session_cwd, is_current_session, cwd_mismatch
// ---------------------------------------------------------------------------

describe('getFacetHandler – resolution-context fields', () => {
  it('session_cwd is null when sidecar has no cwd field', async () => {
    writeSession('sess-no-cwd');
    const result = await getFacetHandler({ session: 'sess-no-cwd' }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['session_cwd']).toBeNull();
  });

  it('session_cwd reflects the cwd field in the sidecar', async () => {
    writeSession('sess-cwd', { cwd: '/my/project' });
    const result = await getFacetHandler({ session: 'sess-cwd' }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['session_cwd']).toBe('/my/project');
  });

  it('is_current_session is false when no context is provided', async () => {
    writeSession('sess-nocontext');
    const result = await getFacetHandler({ session: 'sess-nocontext' }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['is_current_session']).toBe(false);
  });

  it('is_current_session is true when context.sessionId matches the resolved session', async () => {
    writeSession('sess-self');
    const ctx: ToolHandlerContext = { sessionId: 'sess-self' };
    const result = await getFacetHandler({ session: 'sess-self' }, ABORT, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['is_current_session']).toBe(true);
  });

  it('is_current_session is false when context.sessionId differs from resolved session', async () => {
    writeSession('sess-other');
    const ctx: ToolHandlerContext = { sessionId: 'sess-caller' };
    const result = await getFacetHandler({ session: 'sess-other' }, ABORT, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['is_current_session']).toBe(false);
  });

  it('cwd_mismatch is false when no context.resolveBase is provided', async () => {
    writeSession('sess-no-resolvebase', { cwd: '/some/dir' });
    const result = await getFacetHandler({ session: 'sess-no-resolvebase' }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['cwd_mismatch']).toBe(false);
  });

  it('cwd_mismatch is false when session_cwd matches context.resolveBase', async () => {
    writeSession('sess-cwd-match', { cwd: '/matched/dir' });
    const ctx: ToolHandlerContext = { resolveBase: '/matched/dir' };
    const result = await getFacetHandler({ session: 'sess-cwd-match' }, ABORT, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['cwd_mismatch']).toBe(false);
  });

  it('cwd_mismatch is true when session_cwd differs from context.resolveBase', async () => {
    writeSession('sess-cwd-mismatch', { cwd: '/other/project' });
    const ctx: ToolHandlerContext = { resolveBase: '/my/project' };
    const result = await getFacetHandler({ session: 'sess-cwd-mismatch' }, ABORT, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['cwd_mismatch']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// "latest" with cwd preference
// ---------------------------------------------------------------------------

describe('getFacetHandler – "latest" cwd-aware resolution', () => {
  it('prefers cwd-matching session over globally newest when context.resolveBase is set', async () => {
    // sess-global: newest globally but cwd does not match caller
    writeSession('sess-global', { cwd: '/other/project' });
    const globalPath = join(tmpRoot, 'state', 'sessions', 'sess-global.json');

    // sess-local: older globally but cwd matches caller
    writeSession('sess-local', { cwd: '/my/project' });
    const localPath = join(tmpRoot, 'state', 'sessions', 'sess-local.json');

    // sess-global gets the newest mtime
    const now = new Date();
    const oneHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(localPath, oneHourAgo, oneHourAgo);
    utimesSync(globalPath, now, now);

    const ctx: ToolHandlerContext = { resolveBase: '/my/project' };
    const result = await getFacetHandler({ session: 'latest' }, ABORT, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    // cwd-matching session wins despite older mtime
    expect(parsed['session_id']).toBe('sess-local');
    expect(parsed['cwd_mismatch']).toBe(false);
  });

  it('falls back to global newest when no session matches context.resolveBase', async () => {
    writeSession('sess-a', { cwd: '/proj/a' });
    const pathA = join(tmpRoot, 'state', 'sessions', 'sess-a.json');
    writeSession('sess-b', { cwd: '/proj/b' });
    const pathB = join(tmpRoot, 'state', 'sessions', 'sess-b.json');

    // sess-b is globally newest
    const now = new Date();
    const oneHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(pathA, oneHourAgo, oneHourAgo);
    utimesSync(pathB, now, now);

    // caller is in /proj/c — no match
    const ctx: ToolHandlerContext = { resolveBase: '/proj/c' };
    const result = await getFacetHandler({ session: 'latest' }, ABORT, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    // global fallback
    expect(parsed['session_id']).toBe('sess-b');
    expect(parsed['cwd_mismatch']).toBe(true);
  });

  it('without context.resolveBase, "latest" behaves as before (global newest)', async () => {
    writeSession('sess-x', { cwd: '/proj/x' });
    const pathX = join(tmpRoot, 'state', 'sessions', 'sess-x.json');
    writeSession('sess-y', { cwd: '/proj/y' });
    const pathY = join(tmpRoot, 'state', 'sessions', 'sess-y.json');

    const now = new Date();
    const oneHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(pathX, oneHourAgo, oneHourAgo);
    utimesSync(pathY, now, now);

    // No context — global newest
    const result = await getFacetHandler({ session: 'latest' }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['session_id']).toBe('sess-y');
    expect(parsed['cwd_mismatch']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// "current" / "self" resolution
// ---------------------------------------------------------------------------

describe('getFacetHandler – "current" / "self" resolution', () => {
  it('"current" resolves to the session identified by context.sessionId', async () => {
    writeSession('sess-current');
    writeSession('sess-other');
    // Make sess-other the globally newest
    const otherPath = join(tmpRoot, 'state', 'sessions', 'sess-other.json');
    utimesSync(otherPath, new Date(), new Date());

    const ctx: ToolHandlerContext = { sessionId: 'sess-current' };
    const result = await getFacetHandler({ session: 'current' }, ABORT, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['session_id']).toBe('sess-current');
    expect(parsed['is_current_session']).toBe(true);
  });

  it('"self" is an alias for "current"', async () => {
    writeSession('sess-self-alias');
    const ctx: ToolHandlerContext = { sessionId: 'sess-self-alias' };
    const result = await getFacetHandler({ session: 'self' }, ABORT, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['session_id']).toBe('sess-self-alias');
    expect(parsed['is_current_session']).toBe(true);
  });

  it('"current" falls back to "latest" semantics when context has no sessionId', async () => {
    writeSession('sess-fallback');
    // No context sessionId
    const result = await getFacetHandler({ session: 'current' }, ABORT);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(parsed['session_id']).toBe('sess-fallback');
  });

  it('"current" with no context and no sessions → isError: true', async () => {
    const result = await getFacetHandler({ session: 'current' }, ABORT);
    expect(result.isError).toBe(true);
  });

  it('"current" with a ctx.sessionId that matches no sidecar → falls back to latest, not isError', async () => {
    // Simulate the first-turn flush race: the caller has an SDK-assigned session id
    // that resolveSessionByName cannot find (no sidecar exists for it yet).
    // The handler must NOT return 'Session not found'; it must fall back to latest.
    writeSession('sess-latest-fallback');

    const ctx: ToolHandlerContext = { sessionId: 'sdk-unresolvable-id-xyz' };
    const result = await getFacetHandler({ session: 'current' }, ABORT, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    // Must resolve to the existing session via latest fallback
    expect(parsed['session_id']).toBe('sess-latest-fallback');
  });

  it('"current" resolves correctly when SDK id differs from sidecar filename stem', async () => {
    // Write a sidecar whose filename stem ('sess-current-sdk') differs from the
    // stored sessionId field ('sdk-id-abc'). This simulates an SDK-assigned id.
    const sidecarStem = 'sess-current-sdk';
    const sdkId = 'sdk-id-abc';
    const sidecar = {
      sessionId: sdkId, // SDK-assigned id — differs from filename stem
      model: 'claude-3-5-sonnet',
      startedAt: Date.now() - 5000,
      savedAt: Date.now(),
      totalTurns: 1,
      turns: [{ user: 'test', assistant: 'ok', toolEvents: [] }],
    };
    writeFileSync(
      join(tmpRoot, 'state', 'sessions', `${sidecarStem}.json`),
      JSON.stringify(sidecar),
      'utf-8',
    );

    // Also write a decoy session that is globally newest so we know "latest"
    // would NOT pick sess-current-sdk.
    writeSession('sess-decoy');
    const decoyPath = join(tmpRoot, 'state', 'sessions', 'sess-decoy.json');
    utimesSync(decoyPath, new Date(), new Date());

    // Caller presents the SDK id via context.sessionId.
    const ctx: ToolHandlerContext = { sessionId: sdkId };
    const result = await getFacetHandler({ session: 'current' }, ABORT, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    // Must resolve to the sidecar whose stored sessionId matches the SDK id.
    expect(parsed['session_id']).toBe(sdkId);
    // is_current_session must be true — it is the caller's own session.
    expect(parsed['is_current_session']).toBe(true);
  });
});
