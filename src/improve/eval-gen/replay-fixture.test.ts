/**
 * Tests for `improve/eval-gen/replay-fixture.ts`.
 *
 * Coverage:
 *   - sliceTracePrefix produces a byte-identical prefix of the source.
 *   - sliceLineCount and endLine match the source line carrying `endSeq`.
 *   - sliceSha256 is reproducible and matches hashed bytes.
 *   - Trailing-newline preservation: source-with-\\n → fixture-with-\\n;
 *     source-without-\\n on last line → fixture preserves that.
 *   - Defensive parse: malformed lines in source are skipped but counted.
 *   - Error codes: source-not-found / source-empty / seq-not-found /
 *     unsupported-window.
 *   - Real-corpus integration: the user's chosen card (synthetic of the
 *     production trace) — confirms the seq→line mapping the slicer expects.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EvalGenError, sha256Bytes, sliceTracePrefix } from './replay-fixture.js';

// ---------------------------------------------------------------------------
// Helpers — build synthetic source traces line-by-line
// ---------------------------------------------------------------------------

/** Build a JSONL string with one event per line. `trailingNewline` controls
 *  whether the final line gets a `\n`. Default: true (matches the runtime
 *  trace writer). */
function buildSourceTrace(
  events: ReadonlyArray<Record<string, unknown>>,
  options: { trailingNewline?: boolean } = {},
): string {
  const trailing = options.trailingNewline ?? true;
  const lines = events.map((e) => JSON.stringify(e));
  return lines.join('\n') + (trailing ? '\n' : '');
}

/** Build a 5-event trace where seq matches line index (1-based). */
function buildContiguousSeqTrace(eventCount: number): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (let seq = 0; seq < eventCount; seq++) {
    events.push({
      ts: `2026-05-24T00:00:${String(seq).padStart(2, '0')}.000Z`,
      seq,
      kind: 'tool_call',
      payload: { phase: 'completed', name: 'grep' },
    });
  }
  return events;
}

function writeTempTrace(content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'afk-slicer-test-'));
  const path = join(dir, 'trace.jsonl');
  writeFileSync(path, content);
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// sliceTracePrefix
// ---------------------------------------------------------------------------

describe('sliceTracePrefix — byte fidelity', () => {
  it('produces a byte-identical prefix of the source through the line carrying endSeq', () => {
    const events = buildContiguousSeqTrace(5);
    const content = buildSourceTrace(events);
    const { path, cleanup } = writeTempTrace(content);
    try {
      const result = sliceTracePrefix(path, { endSeq: 2 });
      const sourceBytes = readFileSync(path);

      // Slice must equal sourceBytes[0..endByteOffset] byte-for-byte.
      const expectedSlice = sourceBytes.subarray(0, result.bytes.length);
      expect(Buffer.compare(result.bytes, expectedSlice)).toBe(0);

      // Hash check.
      const expectedHash = createHash('sha256').update(expectedSlice).digest('hex');
      expect(result.sliceSha256).toBe(expectedHash);
      expect(result.sliceSha256).toBe(sha256Bytes(result.bytes));
    } finally {
      cleanup();
    }
  });

  it('endLine matches the 1-based line carrying endSeq', () => {
    const events = buildContiguousSeqTrace(5);
    const content = buildSourceTrace(events);
    const { path, cleanup } = writeTempTrace(content);
    try {
      // seq 0 → line 1; seq 4 → line 5.
      expect(sliceTracePrefix(path, { endSeq: 0 }).endLine).toBe(1);
      expect(sliceTracePrefix(path, { endSeq: 2 }).endLine).toBe(3);
      expect(sliceTracePrefix(path, { endSeq: 4 }).endLine).toBe(5);
    } finally {
      cleanup();
    }
  });

  it('sliceLineCount equals endLine in Sprint 3 (startLine is always 1)', () => {
    const events = buildContiguousSeqTrace(10);
    const content = buildSourceTrace(events);
    const { path, cleanup } = writeTempTrace(content);
    try {
      const result = sliceTracePrefix(path, { endSeq: 7 });
      expect(result.sliceLineCount).toBe(result.endLine);
      expect(result.startLine).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('sourceLineCount reports the full source line count, not the slice length', () => {
    const events = buildContiguousSeqTrace(10);
    const content = buildSourceTrace(events);
    const { path, cleanup } = writeTempTrace(content);
    try {
      const result = sliceTracePrefix(path, { endSeq: 3 });
      expect(result.endLine).toBe(4);
      expect(result.sourceLineCount).toBe(10);
    } finally {
      cleanup();
    }
  });

  it('preserves the trailing newline when the source has one', () => {
    const content = buildSourceTrace(buildContiguousSeqTrace(3), { trailingNewline: true });
    const { path, cleanup } = writeTempTrace(content);
    try {
      const result = sliceTracePrefix(path, { endSeq: 2 });
      // Slicing through the LAST line of a fully-terminated source should give
      // the entire file's bytes back.
      const sourceBytes = readFileSync(path);
      expect(result.bytes.length).toBe(sourceBytes.length);
      expect(result.bytes[result.bytes.length - 1]).toBe(0x0a);
    } finally {
      cleanup();
    }
  });

  it('preserves byte fidelity when the source last line has NO trailing newline', () => {
    // seq 0..2, with line 3 (seq 2) missing its trailing \n.
    const content = buildSourceTrace(buildContiguousSeqTrace(3), { trailingNewline: false });
    const { path, cleanup } = writeTempTrace(content);
    try {
      const sourceBytes = readFileSync(path);

      // Slicing through seq 1 (line 2) keeps line 2's trailing \n.
      const r1 = sliceTracePrefix(path, { endSeq: 1 });
      const line1End = sourceBytes.indexOf(0x0a);
      const line2End = sourceBytes.indexOf(0x0a, line1End + 1);
      expect(r1.bytes.length).toBe(line2End + 1);
      expect(r1.bytes[r1.bytes.length - 1]).toBe(0x0a);

      // Slicing through seq 2 (line 3, no trailing \n) keeps source byte-for-byte.
      const r2 = sliceTracePrefix(path, { endSeq: 2 });
      expect(r2.bytes.length).toBe(sourceBytes.length);
      expect(Buffer.compare(r2.bytes, sourceBytes)).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('preserves non-trace whitespace and weird-but-valid bytes verbatim', () => {
    // Inject a line with a unicode payload and a tab. The slicer must keep
    // the bytes exactly as-is.
    const events = [
      { ts: '2026-05-24T00:00:00.000Z', seq: 0, kind: 'tool_call' },
      { ts: '2026-05-24T00:00:01.000Z', seq: 1, kind: 'closure', payload: { reason: 'héllo\tworld' } },
      { ts: '2026-05-24T00:00:02.000Z', seq: 2, kind: 'tool_call' },
    ];
    const content = buildSourceTrace(events);
    const { path, cleanup } = writeTempTrace(content);
    try {
      const sourceBytes = readFileSync(path);
      const result = sliceTracePrefix(path, { endSeq: 2 });
      expect(Buffer.compare(result.bytes, sourceBytes)).toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe('sliceTracePrefix — defensive parse', () => {
  it('skips malformed lines but still counts them toward line numbers', () => {
    // Line 2 (1-based) is garbage; seq 1 lives on line 3.
    const malformedContent =
      '{"ts":"2026-05-24T00:00:00.000Z","seq":0,"kind":"tool_call"}\n' +
      '{not json — should be skipped\n' +
      '{"ts":"2026-05-24T00:00:01.000Z","seq":1,"kind":"tool_call"}\n';
    const { path, cleanup } = writeTempTrace(malformedContent);
    try {
      const result = sliceTracePrefix(path, { endSeq: 1 });
      // endLine is 1-based; the seq-1 line is line 3 in the source.
      expect(result.endLine).toBe(3);
      // sourceLineCount counts all lines, including the malformed one.
      expect(result.sourceLineCount).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('skips a line whose top-level seq value does not match (e.g., nested seq inside payload)', () => {
    // Line 1 has seq 0 but ALSO carries an inner `payload.seq: 99`. Naive
    // regex-only scanning would match 99 on this line; JSON-parse must not.
    const events = [
      { ts: '2026-05-24T00:00:00.000Z', seq: 0, kind: 'subagent_lifecycle', payload: { seq: 99 } },
      { ts: '2026-05-24T00:00:01.000Z', seq: 99, kind: 'tool_call' },
    ];
    const content = buildSourceTrace(events);
    const { path, cleanup } = writeTempTrace(content);
    try {
      const result = sliceTracePrefix(path, { endSeq: 99 });
      // The endLine is the line whose TOP-LEVEL seq is 99 = line 2, not line 1.
      expect(result.endLine).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe('sliceTracePrefix — error codes', () => {
  it('throws source-not-found when the path does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'afk-slicer-test-'));
    try {
      expect(() => sliceTracePrefix(join(dir, 'missing.jsonl'), { endSeq: 0 })).toThrowError(
        EvalGenError,
      );
      try {
        sliceTracePrefix(join(dir, 'missing.jsonl'), { endSeq: 0 });
      } catch (err) {
        expect(err).toBeInstanceOf(EvalGenError);
        expect((err as EvalGenError).code).toBe('source-not-found');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws source-empty when the file is zero bytes', () => {
    const { path, cleanup } = writeTempTrace('');
    try {
      try {
        sliceTracePrefix(path, { endSeq: 0 });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EvalGenError);
        expect((err as EvalGenError).code).toBe('source-empty');
      }
    } finally {
      cleanup();
    }
  });

  it('throws seq-not-found when no parseable line carries the requested seq', () => {
    const content = buildSourceTrace(buildContiguousSeqTrace(3)); // seq 0..2
    const { path, cleanup } = writeTempTrace(content);
    try {
      try {
        sliceTracePrefix(path, { endSeq: 999 });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EvalGenError);
        expect((err as EvalGenError).code).toBe('seq-not-found');
        expect((err as EvalGenError).message).toContain('999');
      }
    } finally {
      cleanup();
    }
  });

  it('throws unsupported-window when startLine !== 1', () => {
    const content = buildSourceTrace(buildContiguousSeqTrace(3));
    const { path, cleanup } = writeTempTrace(content);
    try {
      try {
        sliceTracePrefix(path, { endSeq: 2, startLine: 2 });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(EvalGenError);
        expect((err as EvalGenError).code).toBe('unsupported-window');
      }
    } finally {
      cleanup();
    }
  });
});

describe('sliceTracePrefix — sha256 stability', () => {
  it('repeated calls produce identical sha256', () => {
    const content = buildSourceTrace(buildContiguousSeqTrace(7));
    const { path, cleanup } = writeTempTrace(content);
    try {
      const a = sliceTracePrefix(path, { endSeq: 4 });
      const b = sliceTracePrefix(path, { endSeq: 4 });
      expect(a.sliceSha256).toBe(b.sliceSha256);
      expect(a.endLine).toBe(b.endLine);
      expect(a.sliceLineCount).toBe(b.sliceLineCount);
    } finally {
      cleanup();
    }
  });

  it('different endSeq values produce different sha256', () => {
    const content = buildSourceTrace(buildContiguousSeqTrace(7));
    const { path, cleanup } = writeTempTrace(content);
    try {
      const r1 = sliceTracePrefix(path, { endSeq: 2 });
      const r2 = sliceTracePrefix(path, { endSeq: 4 });
      expect(r1.sliceSha256).not.toBe(r2.sliceSha256);
    } finally {
      cleanup();
    }
  });
});

describe('sliceTracePrefix — real-corpus shape', () => {
  it('mirrors the production trace shape: seq N lives on line N+1', () => {
    // This mirrors the user's chosen card's session shape — seq 0..194 on
    // 195 lines, where seq 47 → line 48 and seq 48 → line 49.
    const events = buildContiguousSeqTrace(195);
    const content = buildSourceTrace(events);
    const { path, cleanup } = writeTempTrace(content);
    try {
      const result = sliceTracePrefix(path, { endSeq: 48 });
      expect(result.endLine).toBe(49);
      expect(result.sliceLineCount).toBe(49);
      expect(result.sourceLineCount).toBe(195);
    } finally {
      cleanup();
    }
  });
});
