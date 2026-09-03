/**
 * Unit tests for the get_facet handler.
 *
 * Strategy: inject AFK_STATE_DIR and AFK_HOME env vars pointing to a tmp dir
 * so listSessionIds() / getOrDeriveFacet() resolve to synthetic fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFacetHandler } from './get-facet.js';

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

  it('fields allowlist → returns only requested fields', async () => {
    writeSession('sess-fields');

    const result = await getFacetHandler(
      { session: 'sess-fields', fields: ['session_id', 'model'] },
      ABORT,
    );
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(2);
    expect(parsed['session_id']).toBe('sess-fields');
    expect(parsed['model']).toBe('claude-3-5-sonnet');
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
});
