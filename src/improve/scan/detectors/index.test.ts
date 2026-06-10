/**
 * Tests for the detector registry.
 *
 * Coverage:
 *   - Registry lists all three detectors with matching FailurePattern names.
 *   - runAllDetectors iterates every entry by default.
 *   - enabledNames restricts execution.
 *   - Detector option keys are passed through correctly.
 *   - Result is the concatenation of all detector outputs.
 *   - Each detector ignores option keys it doesn't recognize.
 */

import { describe, it, expect } from 'vitest';
import { parseTraceContent, type SessionRead } from '../reader.js';
import {
  DETECTOR_REGISTRY,
  knownDetectorNames,
  runAllDetectors,
  defaultEnabledDetectorNames,
  disabledByDefaultDetectorNames,
  type DetectorOptions,
} from './index.js';
import { FailurePatternSchema } from '../../schemas.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let seqCounter = 0;
function resetSeq(): void {
  seqCounter = 0;
}

function closureLine(reason: string): string {
  return JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'closure',
    payload: {
      reason,
      finalTurnCount: 5,
      finalCostUsd: 0,
      finalTokens: { input: 100, output: 200 },
    },
  });
}

function blockLine(reason: string): string {
  return JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'hook_decision',
    payload: { hookEvent: 'SubagentStart', decision: 'block', reason },
  });
}

function toolPair(toolUseId: string, name: string): string[] {
  const started = JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'tool_call',
    payload: { phase: 'started', toolUseId, name, inputBytes: 100 },
  });
  const completed = JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'tool_call',
    payload: {
      phase: 'completed',
      toolUseId,
      name,
      resultBytes: 200,
      isError: false,
      truncated: false,
      durationMs: 50,
    },
  });
  return [started, completed];
}

function makeSession(sessionId: string, lines: string[]): SessionRead {
  return parseTraceContent({
    sessionId,
    tracePath: `/abs/witness/${sessionId}/trace.jsonl`,
    relativeTracePath: `state/witness/${sessionId}/trace.jsonl`,
    content: lines.join('\n'),
    sessionMtimeMs: 1_700_000_000_000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DETECTOR_REGISTRY', () => {
  it('lists four detectors', () => {
    expect(DETECTOR_REGISTRY).toHaveLength(4);
  });

  it('all registry names match a value in FailurePatternSchema', () => {
    const enumValues = new Set<string>(FailurePatternSchema.options);
    for (const entry of DETECTOR_REGISTRY) {
      expect(enumValues.has(entry.name)).toBe(true);
    }
  });

  it('every entry has a non-empty description', () => {
    for (const entry of DETECTOR_REGISTRY) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('knownDetectorNames returns all registry names in order', () => {
    expect(knownDetectorNames()).toEqual([
      'repeated-tool-use',
      'closure-anomaly',
      'subagent-block',
      'tool-failure-density',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fixture: a session that triggers all four detectors at once.
// ---------------------------------------------------------------------------
function makeAllPatternSession(id: string): SessionRead {
  resetSeq();
  const lines: string[] = [];
  // 4 repeated tool calls → repeated-tool-use
  for (let i = 0; i < 4; i++) {
    lines.push(...toolPair(`tu-${i}`, 'grep'));
  }
  // 3 failing 'Bash' calls (100% rate, 3 failures) → tool-failure-density
  for (let i = 0; i < 3; i++) {
    lines.push(...toolPairWithError(`bf-${i}`, 'Bash'));
  }
  // 2 SubagentStart blocks with same reason → subagent-block
  lines.push(blockLine('test block reason'));
  lines.push(blockLine('test block reason'));
  // 1 budget_exceeded closure → closure-anomaly
  lines.push(closureLine('budget_exceeded'));
  return makeSession(id, lines);
}

/** Like `toolPair` but with `isError: true` on the completed event. */
function toolPairWithError(toolUseId: string, name: string): string[] {
  const started = JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'tool_call',
    payload: { phase: 'started', toolUseId, name, inputBytes: 100 },
  });
  const completed = JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'tool_call',
    payload: {
      phase: 'completed',
      toolUseId,
      name,
      resultBytes: 200,
      isError: true,
      truncated: false,
      durationMs: 50,
    },
  });
  return [started, completed];
}

describe('runAllDetectors', () => {
  it('default mode skips enabledByDefault:false detectors', () => {
    const session = makeAllPatternSession('s1');
    // No enabledNames, no includeDisabled → repeated-tool-use AND tool-failure-density
    // fire (both enabled-by-default); closure-anomaly + subagent-block stay opt-in.
    const results = runAllDetectors([session], {});
    const patterns = new Set(results.map((r) => r.pattern));
    expect(patterns).toEqual(new Set(['repeated-tool-use', 'tool-failure-density']));
    expect(patterns.has('closure-anomaly')).toBe(false);
    expect(patterns.has('subagent-block')).toBe(false);
    expect(patterns.has('tool-failure-density')).toBe(true);
  });

  it('includeDisabled:true runs every detector', () => {
    const session = makeAllPatternSession('s2');
    const results = runAllDetectors([session], {}, undefined, true);
    const patterns = new Set(results.map((r) => r.pattern));
    expect(patterns).toEqual(
      new Set([
        'repeated-tool-use',
        'closure-anomaly',
        'subagent-block',
        'tool-failure-density',
      ]),
    );
  });

  it('enabledNames overrides disabled-by-default — closure-anomaly runs when named', () => {
    resetSeq();
    const lines = [closureLine('budget_exceeded')];
    const session = makeSession('s3', lines);
    // closure-anomaly is disabled by default, but named explicitly → should run.
    const results = runAllDetectors([session], {}, new Set(['closure-anomaly']));
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.pattern === 'closure-anomaly')).toBe(true);
  });

  it('returns empty array on empty sessions', () => {
    expect(runAllDetectors([], {})).toEqual([]);
  });

  it('enabledNames restricts execution', () => {
    resetSeq();
    const lines: string[] = [];
    for (let i = 0; i < 4; i++) {
      lines.push(...toolPair(`tu-${i}`, 'grep'));
    }
    lines.push(closureLine('budget_exceeded'));
    const session = makeSession('s1', lines);

    const onlyClosure = runAllDetectors([session], {}, new Set(['closure-anomaly']));
    expect(onlyClosure.every((r) => r.pattern === 'closure-anomaly')).toBe(true);
    expect(onlyClosure.length).toBeGreaterThan(0);

    const onlyRepeated = runAllDetectors([session], {}, new Set(['repeated-tool-use']));
    expect(onlyRepeated.every((r) => r.pattern === 'repeated-tool-use')).toBe(true);
    expect(onlyRepeated.length).toBeGreaterThan(0);

    const none = runAllDetectors([session], {}, new Set(['nonexistent']));
    expect(none).toEqual([]);
  });

  it('option keys reach the correct detector', () => {
    resetSeq();
    // 3 SubagentStart blocks. minOccurrences=2 (default) fires; minOccurrences=5 does not.
    const lines = [
      blockLine('reason-1'),
      blockLine('reason-1'),
      blockLine('reason-1'),
    ];
    const session = makeSession('s1', lines);

    const opts1: DetectorOptions = { subagentBlockMinOccurrences: 2 };
    expect(
      runAllDetectors([session], opts1, new Set(['subagent-block'])).length,
    ).toBe(1);

    const opts2: DetectorOptions = { subagentBlockMinOccurrences: 5 };
    expect(
      runAllDetectors([session], opts2, new Set(['subagent-block'])).length,
    ).toBe(0);
  });

  it('unknown option keys are ignored', () => {
    resetSeq();
    const lines = [closureLine('budget_exceeded')];
    const session = makeSession('s1', lines);

    // Pass minRepeats (which belongs to repeated-tool-use) — closure-anomaly should ignore it.
    expect(
      runAllDetectors([session], { minRepeats: 99 }, new Set(['closure-anomaly'])).length,
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// defaultEnabledDetectorNames / disabledByDefaultDetectorNames
// ---------------------------------------------------------------------------

describe('defaultEnabledDetectorNames', () => {
  it('returns repeated-tool-use and tool-failure-density (registry order)', () => {
    expect(defaultEnabledDetectorNames()).toEqual([
      'repeated-tool-use',
      'tool-failure-density',
    ]);
  });
});

describe('disabledByDefaultDetectorNames', () => {
  it('contains closure-anomaly, subagent-block (in any order)', () => {
    const names = new Set(disabledByDefaultDetectorNames());
    expect(names).toEqual(new Set(['closure-anomaly', 'subagent-block']));
  });
});
