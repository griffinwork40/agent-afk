/**
 * Tests for `improve/scan/reader.ts`.
 *
 * Verifies:
 *   - parseDuration handles supported units, rejects garbage.
 *   - parseTraceContent skips invalid JSONL lines but counts them.
 *   - parseTraceContent skips lines that don't match TraceEventSchema.
 *   - parseTraceContent preserves event order and line numbers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDuration, parseTraceContent, scanWitness } from './reader.js';

describe('parseDuration', () => {
  it('parses days', () => {
    expect(parseDuration('7d')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('parses hours', () => {
    expect(parseDuration('24h')).toBe(24 * 60 * 60 * 1000);
  });

  it('parses minutes', () => {
    expect(parseDuration('30m')).toBe(30 * 60 * 1000);
  });

  it('parses seconds', () => {
    expect(parseDuration('3600s')).toBe(3600 * 1000);
  });

  it('tolerates whitespace and case', () => {
    expect(parseDuration('  7D  ')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('rejects unparseable input', () => {
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration('garbage')).toBeUndefined();
    expect(parseDuration('7')).toBeUndefined();
    expect(parseDuration('d7')).toBeUndefined();
    expect(parseDuration('0d')).toBeUndefined();
    expect(parseDuration('-1d')).toBeUndefined();
  });
});

describe('parseTraceContent', () => {
  const baseArgs = {
    sessionId: 'session-A',
    tracePath: '/abs/state/witness/session-A/trace.jsonl',
    relativeTracePath: 'state/witness/session-A/trace.jsonl',
    sessionMtimeMs: 1_700_000_000_000,
  };

  function event(
    seq: number,
    payload: Record<string, unknown>,
  ): string {
    const obj = {
      ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
      seq,
      kind: 'tool_call',
      payload,
    };
    return JSON.stringify(obj);
  }

  it('parses a clean trace, preserving order and line numbers', () => {
    const lines = [
      event(0, { phase: 'started', toolUseId: 'a', name: 'grep', inputBytes: 100, argsFingerprint: 'abcd1234'.repeat(8) }),
      event(1, {
        phase: 'completed',
        toolUseId: 'a',
        name: 'grep',
        resultBytes: 200,
        isError: false,
        truncated: false,
        durationMs: 50,
      }),
    ];
    const result = parseTraceContent({ ...baseArgs, content: lines.join('\n') });

    expect(result.invalidLineCount).toBe(0);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.lineNumber).toBe(1);
    expect(result.events[1]?.lineNumber).toBe(2);
    expect(result.events[0]?.event.seq).toBe(0);
    expect(result.events[1]?.event.seq).toBe(1);
    expect(result.events[0]?.sessionId).toBe('session-A');
    expect(result.events[0]?.relativeTracePath).toBe('state/witness/session-A/trace.jsonl');
  });

  it('skips invalid JSON lines but counts them', () => {
    const lines = [
      event(0, { phase: 'started', toolUseId: 'a', name: 'grep', inputBytes: 100, argsFingerprint: 'abcd1234'.repeat(8) }),
      '{ this is not valid json',
      event(1, {
        phase: 'completed',
        toolUseId: 'a',
        name: 'grep',
        resultBytes: 200,
        isError: false,
        truncated: false,
        durationMs: 50,
      }),
    ];
    const result = parseTraceContent({ ...baseArgs, content: lines.join('\n') });

    expect(result.invalidLineCount).toBe(1);
    expect(result.events).toHaveLength(2);
    // Line numbers reflect file position — invalid line was line 2.
    expect(result.events[0]?.lineNumber).toBe(1);
    expect(result.events[1]?.lineNumber).toBe(3);
  });

  it('skips schema-mismatch lines but counts them', () => {
    const lines = [
      event(0, { phase: 'started', toolUseId: 'a', name: 'grep', inputBytes: 100, argsFingerprint: 'abcd1234'.repeat(8) }),
      // Valid JSON, missing required fields — should fail TraceEventSchema.
      JSON.stringify({ ts: '2020-01-01T00:00:00Z', seq: 1, kind: 'tool_call' }),
      event(1, {
        phase: 'completed',
        toolUseId: 'a',
        name: 'grep',
        resultBytes: 200,
        isError: false,
        truncated: false,
        durationMs: 50,
      }),
    ];
    const result = parseTraceContent({ ...baseArgs, content: lines.join('\n') });

    expect(result.invalidLineCount).toBe(1);
    expect(result.events).toHaveLength(2);
  });

  it('ignores empty trailing lines', () => {
    const lines = [
      event(0, { phase: 'started', toolUseId: 'a', name: 'grep', inputBytes: 100, argsFingerprint: 'abcd1234'.repeat(8) }),
      '',
      '',
    ];
    const result = parseTraceContent({ ...baseArgs, content: lines.join('\n') });

    expect(result.invalidLineCount).toBe(0);
    expect(result.events).toHaveLength(1);
  });

  it('handles empty content', () => {
    const result = parseTraceContent({ ...baseArgs, content: '' });
    expect(result.events).toHaveLength(0);
    expect(result.invalidLineCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pathRelativeTo — tested via scanWitness with a filesystem fixture.
//
// The old string-prefix implementation had a sibling-prefix bug:
//   absolutePath = '/a/rootX/file', root = '/a/root'
//   '/a/rootX/file'.startsWith('/a/root') === true  ← wrong match
// The new relative()-based implementation rejects this case correctly.
// ---------------------------------------------------------------------------

describe('pathRelativeTo (via scanWitness)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'afk-reader-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Write a minimal valid trace.jsonl to sessionDir and return its tracePath. */
  function writeTrace(sessionDir: string): void {
    const ev = {
      ts: new Date().toISOString(),
      seq: 0,
      kind: 'session_phase',
      payload: { phase: 'start' },
    };
    writeFileSync(join(sessionDir, 'trace.jsonl'), JSON.stringify(ev) + '\n', 'utf8');
  }

  it('produces a relative path when tracePath is inside afkHome', () => {
    // witnessRoot = tmp/witness; afkHome = tmp
    const witnessRoot = join(tmp, 'witness');
    const sessionDir = join(witnessRoot, 'sess-A');
    mkdirSync(sessionDir, { recursive: true });
    writeTrace(sessionDir);

    const result = scanWitness({ witnessRoot, afkHome: tmp });
    expect(result.sessionsScanned).toBe(1);
    const session = result.sessions[0]!;
    // relativeTracePath should be relative, not absolute
    expect(session.relativeTracePath).not.toMatch(/^\//);
    expect(session.relativeTracePath).toContain('witness');
  });

  it('does not match a sibling-prefix path (the old bug)', () => {
    // afkHome = tmp/afk; witnessRoot = tmp/afkEVIL/witness
    // Old code: '/tmp/afkEVIL/...'.startsWith('/tmp/afk') === true → wrongly strips
    // New code: relative('/tmp/afk', '/tmp/afkEVIL/...') = '../afkEVIL/...' → keeps absolute
    const afkHome = join(tmp, 'afk');
    const witnessRoot = join(tmp, 'afkEVIL', 'witness');
    const sessionDir = join(witnessRoot, 'sess-B');
    mkdirSync(afkHome, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeTrace(sessionDir);

    const result = scanWitness({ witnessRoot, afkHome });
    expect(result.sessionsScanned).toBe(1);
    const session = result.sessions[0]!;
    // Must NOT have stripped the prefix; the path should still be absolute
    expect(session.relativeTracePath).toMatch(/^\//);
  });
});
