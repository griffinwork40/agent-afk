/**
 * Smoke tests for the production trace-writer factory.
 *
 * Three responsibilities the factory has, each gets a test:
 *
 *   1. Honors the AFK_TRACE_DISABLED=1 opt-out (returns null).
 *   2. Generates a unique trace directory under $AFK_HOME when the
 *      caller does not supply a label.
 *   3. End-to-end: when wired into a real AgentSession against the
 *      mock provider, a normal close() produces a parseable NDJSON
 *      trace file whose terminal record is `session_sealed` with
 *      status=succeeded. This is the production wiring contract --
 *      a normal AFK session leaves durable evidence on disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultTraceWriter } from './factory.js';
import { getTraceDir } from '../../paths.js';
import { createMockProvider, type MockProviderHandle } from '../__fixtures__/mock-provider.js';

vi.mock('../../utils/debug.js', () => ({
  debugLog: vi.fn(),
}));

import { AgentSession } from '../session.js';
import type { AgentConfig } from '../types.js';

let tmpHome: string;
let savedHome: string | undefined;
let savedDisabled: string | undefined;

beforeEach(async () => {
  tmpHome = await mkdtemp(join(tmpdir(), 'afk-trace-factory-'));
  savedHome = process.env['AFK_HOME'];
  savedDisabled = process.env['AFK_TRACE_DISABLED'];
  process.env['AFK_HOME'] = tmpHome;
  delete process.env['AFK_TRACE_DISABLED'];
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = savedHome;
  if (savedDisabled === undefined) delete process.env['AFK_TRACE_DISABLED'];
  else process.env['AFK_TRACE_DISABLED'] = savedDisabled;
  await rm(tmpHome, { recursive: true, force: true });
});

describe('createDefaultTraceWriter', () => {
  it('returns null when AFK_TRACE_DISABLED=1', () => {
    process.env['AFK_TRACE_DISABLED'] = '1';
    expect(createDefaultTraceWriter()).toBeNull();
  });

  it('returns a writer rooted at $AFK_HOME/state/witness/<label>/trace.jsonl', () => {
    const got = createDefaultTraceWriter();
    expect(got).not.toBeNull();
    if (!got) throw new Error('unreachable');
    expect(got.tracePath).toBe(join(getTraceDir(got.sessionLabel), 'trace.jsonl'));
    // Path is under tmpHome since AFK_HOME is set to it.
    expect(got.tracePath.startsWith(tmpHome)).toBe(true);
  });

  it('uses caller-supplied sessionLabel verbatim when provided', () => {
    const got = createDefaultTraceWriter({ sessionLabel: 'resumed-abc-123' });
    if (!got) throw new Error('unreachable');
    expect(got.sessionLabel).toBe('resumed-abc-123');
    expect(got.tracePath).toContain('resumed-abc-123');
  });

  it('generates distinct labels across calls when none is supplied', () => {
    const a = createDefaultTraceWriter();
    const b = createDefaultTraceWriter();
    if (!a || !b) throw new Error('unreachable');
    expect(a.sessionLabel).not.toBe(b.sessionLabel);
  });

  // ---------------------------------------------------------------------
  // Smoke test: real AgentSession + factory writer produces a trace file
  // ---------------------------------------------------------------------

  it('end-to-end: a normal AgentSession produces a parseable NDJSON trace ending in session_sealed', async () => {
    const trace = createDefaultTraceWriter();
    if (!trace) throw new Error('unreachable');

    const provider: MockProviderHandle = createMockProvider();
    const config: AgentConfig = {
      model: 'sonnet',
      apiKey: 'test-key',
      provider,
      traceWriter: trace.writer,
    };
    const session = new AgentSession(config);
    await session.waitForInitialization();
    await session.close();

    // File exists on disk.
    const fileStat = await stat(trace.tracePath);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.size).toBeGreaterThan(0);

    // Read the file. Each line must be valid JSON; the last must be the seal.
    const body = await readFile(trace.tracePath, 'utf8');
    const lines = body.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2); // at minimum: closure + session_sealed

    interface PersistedTraceLine {
      ts: string;
      seq: number;
      kind: string;
      payload: { status?: string };
    }
    const parsed: PersistedTraceLine[] = lines.map((l) => JSON.parse(l) as PersistedTraceLine);

    // Every line has the required envelope fields.
    for (const ev of parsed) {
      expect(typeof ev.ts).toBe('string');
      expect(typeof ev.seq).toBe('number');
      expect(typeof ev.kind).toBe('string');
      expect(typeof ev.payload).toBe('object');
    }

    // Sequence numbers are monotonically increasing.
    for (let i = 1; i < parsed.length; i++) {
      const a = parsed[i - 1];
      const b = parsed[i];
      if (!a || !b) throw new Error('unreachable');
      expect(b.seq).toBeGreaterThan(a.seq);
    }

    // The trace's penultimate record is `closure` (terminal classification)
    // and the final record is `session_sealed` (sealed-clean evidence).
    const last = parsed[parsed.length - 1];
    expect(last?.kind).toBe('session_sealed');
    expect(last?.payload.status).toBe('succeeded');
    const closureLine = parsed.find((p) => p.kind === 'closure');
    expect(closureLine).toBeDefined();
  });

  it('end-to-end: a session with AFK_TRACE_DISABLED=1 produces no trace directory', async () => {
    process.env['AFK_TRACE_DISABLED'] = '1';
    const trace = createDefaultTraceWriter();
    expect(trace).toBeNull();

    const provider = createMockProvider();
    const session = new AgentSession({
      model: 'sonnet',
      apiKey: 'test-key',
      provider,
    });
    await session.waitForInitialization();
    await session.close();

    // Witness directory should not have been created — no per-session
    // child dirs got materialized because no writer ever ran.
    const witnessRoot = join(tmpHome, 'state', 'witness');
    await expect(stat(witnessRoot)).rejects.toThrow();
  });
});
