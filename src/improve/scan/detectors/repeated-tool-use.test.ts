/**
 * Tests for `improve/scan/detectors/repeated-tool-use.ts`.
 *
 * Coverage:
 *   - 4 identical tool calls in a row → detection.
 *   - Similar-but-not-identical (different inputBytes, different name) → no detection.
 *   - Calls split across subagents (different contexts) → not merged into one run.
 *   - Unpaired `started` (no `completed`) is dropped.
 *   - Slug stability across runs with same fingerprint.
 *   - Threshold honored (minRepeats parameter).
 *   - Severity ladder: low / medium / high boundaries.
 */

import { describe, it, expect } from 'vitest';
import { parseTraceContent, type SessionRead } from '../reader.js';
import {
  detectRepeatedToolUse,
  computeFingerprint,
  makeSlug,
  pairToolCalls,
  DEFAULT_MIN_REPEATS,
} from './repeated-tool-use.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface ToolCallSpec {
  toolUseId: string;
  name: string;
  inputBytes: number;
  resultBytes: number;
  isError?: boolean;
  subagentId?: string;
}

let seqCounter = 0;

function resetSeq(): void {
  seqCounter = 0;
}

function startedLine(spec: ToolCallSpec): string {
  return JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'tool_call',
    payload: {
      phase: 'started',
      toolUseId: spec.toolUseId,
      name: spec.name,
      inputBytes: spec.inputBytes,
      ...(spec.subagentId ? { subagentId: spec.subagentId } : {}),
    },
  });
}

function completedLine(spec: ToolCallSpec): string {
  return JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'tool_call',
    payload: {
      phase: 'completed',
      toolUseId: spec.toolUseId,
      name: spec.name,
      resultBytes: spec.resultBytes,
      isError: spec.isError ?? false,
      truncated: false,
      durationMs: 50,
      ...(spec.subagentId ? { subagentId: spec.subagentId } : {}),
    },
  });
}

function pairLines(spec: ToolCallSpec): string[] {
  return [startedLine(spec), completedLine(spec)];
}

function makeSessionRead(lines: string[]): SessionRead {
  return parseTraceContent({
    sessionId: 'sess-fix',
    tracePath: '/abs/witness/sess-fix/trace.jsonl',
    relativeTracePath: 'state/witness/sess-fix/trace.jsonl',
    content: lines.join('\n'),
    sessionMtimeMs: 1_700_000_000_000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeFingerprint', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeFingerprint({
      name: 'grep',
      inputBytes: 100,
      resultBytes: 200,
      isError: false,
      subagentId: undefined,
    });
    const b = computeFingerprint({
      name: 'grep',
      inputBytes: 100,
      resultBytes: 200,
      isError: false,
      subagentId: undefined,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs on any field change', () => {
    const base = {
      name: 'grep',
      inputBytes: 100,
      resultBytes: 200,
      isError: false,
      subagentId: undefined as string | undefined,
    };
    const baseHash = computeFingerprint(base);
    expect(computeFingerprint({ ...base, name: 'bash' })).not.toBe(baseHash);
    expect(computeFingerprint({ ...base, inputBytes: 101 })).not.toBe(baseHash);
    expect(computeFingerprint({ ...base, resultBytes: 201 })).not.toBe(baseHash);
    expect(computeFingerprint({ ...base, isError: true })).not.toBe(baseHash);
    expect(computeFingerprint({ ...base, subagentId: 'sub-1' })).not.toBe(baseHash);
  });
});

describe('makeSlug', () => {
  it('is stable for the same (toolName, fingerprint) across calls', () => {
    const fp = computeFingerprint({
      name: 'grep',
      inputBytes: 100,
      resultBytes: 200,
      isError: false,
      subagentId: undefined,
    });
    const a = makeSlug('grep', fp);
    const b = makeSlug('grep', fp);
    expect(a).toBe(b);
  });

  it('sanitizes non-alphanumeric chars in tool name', () => {
    const fp = '0'.repeat(64);
    expect(makeSlug('Some Tool/With_Spaces', fp)).toMatch(
      /^repeated-tool-some-tool-with-spaces-[0]{12}$/,
    );
  });

  it('falls back to "tool" for fully non-alphanumeric tool names', () => {
    const fp = '0'.repeat(64);
    expect(makeSlug('!!!', fp)).toMatch(/^repeated-tool-tool-/);
  });
});

describe('pairToolCalls', () => {
  it('drops unpaired started events (no completed)', () => {
    resetSeq();
    const lines = [
      startedLine({ toolUseId: 'a', name: 'grep', inputBytes: 100, resultBytes: 0 }),
      // No completed for 'a'.
      ...pairLines({ toolUseId: 'b', name: 'grep', inputBytes: 100, resultBytes: 200 }),
    ];
    const session = makeSessionRead(lines);
    const pairs = pairToolCalls(session.events);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.toolUseId).toBe('b');
  });

  it('drops orphan completed events (no started seen)', () => {
    resetSeq();
    const lines = [
      // completed for 'a' with no prior started.
      completedLine({ toolUseId: 'a', name: 'grep', inputBytes: 0, resultBytes: 200 }),
      ...pairLines({ toolUseId: 'b', name: 'grep', inputBytes: 100, resultBytes: 200 }),
    ];
    const session = makeSessionRead(lines);
    const pairs = pairToolCalls(session.events);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.toolUseId).toBe('b');
  });
});

describe('detectRepeatedToolUse', () => {
  it('flags 4 consecutive identical calls', () => {
    resetSeq();
    const lines = [
      ...pairLines({ toolUseId: '1', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '2', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '3', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '4', name: 'grep', inputBytes: 100, resultBytes: 200 }),
    ];
    const session = makeSessionRead(lines);
    const detections = detectRepeatedToolUse([session]);

    expect(detections).toHaveLength(1);
    const d = detections[0];
    expect(d?.pattern).toBe('repeated-tool-use');
    expect(d?.severity).toBe('medium'); // 4..9 = medium
    expect(d?.detail['runLength']).toBe(4);
    expect(d?.detail['toolName']).toBe('grep');
    expect(d?.detail['agentContext']).toBe('root');
    expect(d?.evidence[0]?.eventIndices).toHaveLength(4);
  });

  it('does NOT flag 3 consecutive identical calls (below threshold)', () => {
    resetSeq();
    const lines = [
      ...pairLines({ toolUseId: '1', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '2', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '3', name: 'grep', inputBytes: 100, resultBytes: 200 }),
    ];
    const session = makeSessionRead(lines);
    expect(detectRepeatedToolUse([session])).toHaveLength(0);
  });

  it('does NOT flag similar-but-not-identical calls (different inputBytes)', () => {
    resetSeq();
    const lines = [
      ...pairLines({ toolUseId: '1', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '2', name: 'grep', inputBytes: 101, resultBytes: 200 }),
      ...pairLines({ toolUseId: '3', name: 'grep', inputBytes: 102, resultBytes: 200 }),
      ...pairLines({ toolUseId: '4', name: 'grep', inputBytes: 103, resultBytes: 200 }),
    ];
    const session = makeSessionRead(lines);
    expect(detectRepeatedToolUse([session])).toHaveLength(0);
  });

  it('does NOT flag calls with different tool names', () => {
    resetSeq();
    const lines = [
      ...pairLines({ toolUseId: '1', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '2', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '3', name: 'bash', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '4', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '5', name: 'grep', inputBytes: 100, resultBytes: 200 }),
    ];
    // Run 1: 2 greps; bash breaks it. Run 2: 2 greps. Both below threshold.
    const session = makeSessionRead(lines);
    expect(detectRepeatedToolUse([session])).toHaveLength(0);
  });

  it('does NOT merge runs across different subagent contexts', () => {
    resetSeq();
    const lines = [
      ...pairLines({ toolUseId: '1', name: 'grep', inputBytes: 100, resultBytes: 200, subagentId: 'sub-A' }),
      ...pairLines({ toolUseId: '2', name: 'grep', inputBytes: 100, resultBytes: 200, subagentId: 'sub-B' }),
      ...pairLines({ toolUseId: '3', name: 'grep', inputBytes: 100, resultBytes: 200, subagentId: 'sub-A' }),
      ...pairLines({ toolUseId: '4', name: 'grep', inputBytes: 100, resultBytes: 200, subagentId: 'sub-B' }),
    ];
    // sub-A has 2 calls, sub-B has 2 calls — each below threshold and
    // fingerprints differ across contexts because subagentId is in the
    // fingerprint.
    const session = makeSessionRead(lines);
    expect(detectRepeatedToolUse([session])).toHaveLength(0);
  });

  it('flags a run inside a single subagent context', () => {
    resetSeq();
    const lines = [
      ...pairLines({ toolUseId: '1', name: 'grep', inputBytes: 100, resultBytes: 200, subagentId: 'sub-A' }),
      ...pairLines({ toolUseId: '2', name: 'grep', inputBytes: 100, resultBytes: 200, subagentId: 'sub-A' }),
      ...pairLines({ toolUseId: '3', name: 'grep', inputBytes: 100, resultBytes: 200, subagentId: 'sub-A' }),
      ...pairLines({ toolUseId: '4', name: 'grep', inputBytes: 100, resultBytes: 200, subagentId: 'sub-A' }),
    ];
    const session = makeSessionRead(lines);
    const detections = detectRepeatedToolUse([session]);
    expect(detections).toHaveLength(1);
    expect(detections[0]?.detail['agentContext']).toBe('sub-A');
  });

  it('honors a custom minRepeats threshold', () => {
    resetSeq();
    const lines = [
      ...pairLines({ toolUseId: '1', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '2', name: 'grep', inputBytes: 100, resultBytes: 200 }),
    ];
    const session = makeSessionRead(lines);
    expect(detectRepeatedToolUse([session], { minRepeats: 2 })).toHaveLength(1);
    expect(detectRepeatedToolUse([session], { minRepeats: 3 })).toHaveLength(0);
  });

  it('rejects nonsense thresholds', () => {
    expect(() => detectRepeatedToolUse([], { minRepeats: 1 })).toThrow();
    expect(() => detectRepeatedToolUse([], { minRepeats: 0 })).toThrow();
  });

  it('produces stable slugs across multiple sessions with the same loop', () => {
    function loopSession(sessionId: string): SessionRead {
      resetSeq();
      const lines = [
        ...pairLines({ toolUseId: '1', name: 'grep', inputBytes: 100, resultBytes: 200 }),
        ...pairLines({ toolUseId: '2', name: 'grep', inputBytes: 100, resultBytes: 200 }),
        ...pairLines({ toolUseId: '3', name: 'grep', inputBytes: 100, resultBytes: 200 }),
        ...pairLines({ toolUseId: '4', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ];
      return parseTraceContent({
        sessionId,
        tracePath: `/abs/witness/${sessionId}/trace.jsonl`,
        relativeTracePath: `state/witness/${sessionId}/trace.jsonl`,
        content: lines.join('\n'),
        sessionMtimeMs: 1_700_000_000_000,
      });
    }
    const d1 = detectRepeatedToolUse([loopSession('A')]);
    const d2 = detectRepeatedToolUse([loopSession('B')]);
    expect(d1[0]?.slug).toBe(d2[0]?.slug);
  });

  it('escalates severity to high on long runs (≥10)', () => {
    resetSeq();
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(...pairLines({ toolUseId: `t${i}`, name: 'grep', inputBytes: 100, resultBytes: 200 }));
    }
    const session = makeSessionRead(lines);
    const d = detectRepeatedToolUse([session]);
    expect(d[0]?.severity).toBe('high');
    expect(d[0]?.detail['runLength']).toBe(10);
  });

  it('uses DEFAULT_MIN_REPEATS when no threshold is supplied', () => {
    expect(DEFAULT_MIN_REPEATS).toBe(4);
  });

  it('handles two independent runs in the same session', () => {
    resetSeq();
    const lines = [
      // Run 1: 4× grep with fingerprint A
      ...pairLines({ toolUseId: '1', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '2', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '3', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      ...pairLines({ toolUseId: '4', name: 'grep', inputBytes: 100, resultBytes: 200 }),
      // Break the run with a different call
      ...pairLines({ toolUseId: '5', name: 'bash', inputBytes: 50, resultBytes: 80 }),
      // Run 2: 4× grep with fingerprint B (different inputBytes)
      ...pairLines({ toolUseId: '6', name: 'grep', inputBytes: 500, resultBytes: 600 }),
      ...pairLines({ toolUseId: '7', name: 'grep', inputBytes: 500, resultBytes: 600 }),
      ...pairLines({ toolUseId: '8', name: 'grep', inputBytes: 500, resultBytes: 600 }),
      ...pairLines({ toolUseId: '9', name: 'grep', inputBytes: 500, resultBytes: 600 }),
    ];
    const session = makeSessionRead(lines);
    const detections = detectRepeatedToolUse([session]);
    expect(detections).toHaveLength(2);
    // Slugs differ because fingerprints differ.
    expect(detections[0]?.slug).not.toBe(detections[1]?.slug);
  });
});
