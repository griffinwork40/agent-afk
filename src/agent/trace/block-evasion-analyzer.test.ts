/**
 * Unit tests for block-evasion-analyzer.ts.
 *
 * Uses fixture trace-event arrays — no file I/O, no process.env.
 *
 * @module agent/trace/block-evasion-analyzer.test
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeBlockEvasion,
  buildBlockLedger,
  detectEvasions,
  detectLostWork,
  effectClassOf,
  formatBlockEvasionReport,
} from './block-evasion-analyzer.js';
import type { TraceEvent } from './types.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let seq = 0;
function nextSeq(): number { return seq++; }
function resetSeq(): void { seq = 0; }

function mkHardBlock(ts: string, blockedTool: string, reason = 'plan mode', subagentId?: string): TraceEvent {
  return {
    ts,
    seq: nextSeq(),
    kind: 'hook_decision',
    payload: {
      hookEvent: 'PreToolUse',
      decision: 'block',
      approvalOutcome: 'hard-block',
      blockedTool,
      reason,
      ...(subagentId != null ? { subagentId } : {}),
    },
  } as TraceEvent;
}

function mkPlainBlock(ts: string, blockedTool: string): TraceEvent {
  return {
    ts,
    seq: nextSeq(),
    kind: 'hook_decision',
    payload: {
      hookEvent: 'PreToolUse',
      decision: 'block',
      // No approvalOutcome — plain block, not hard-block
      blockedTool,
      reason: 'plain block',
    },
  } as TraceEvent;
}

function mkToolOk(ts: string, name: string, subagentId?: string): TraceEvent {
  return {
    ts,
    seq: nextSeq(),
    kind: 'tool_call',
    payload: {
      phase: 'completed',
      toolUseId: `tu-${seq}`,
      name,
      resultBytes: 100,
      isError: false,
      truncated: false,
      durationMs: 10,
      ...(subagentId != null ? { subagentId } : {}),
    },
  } as TraceEvent;
}

function mkToolErr(ts: string, name: string, subagentId?: string): TraceEvent {
  return {
    ts,
    seq: nextSeq(),
    kind: 'tool_call',
    payload: {
      phase: 'completed',
      toolUseId: `tu-${seq}`,
      name,
      resultBytes: 10,
      isError: true,
      truncated: false,
      durationMs: 5,
      ...(subagentId != null ? { subagentId } : {}),
    },
  } as TraceEvent;
}

function mkClosure(ts: string, reason = 'model_end_turn'): TraceEvent {
  return {
    ts,
    seq: nextSeq(),
    kind: 'closure',
    payload: { reason, finalTurnCount: 3, finalCostUsd: 0.01, finalTokens: {} },
  } as TraceEvent;
}

function mkSealed(ts: string, status = 'succeeded'): TraceEvent {
  return {
    ts,
    seq: nextSeq(),
    kind: 'session_sealed',
    payload: { status, finalCostUsd: 0.01, finalTurnCount: 3, closedAt: ts },
  } as TraceEvent;
}

function mkInitPhase(ts: string, origin: string): TraceEvent {
  return {
    ts,
    seq: nextSeq(),
    kind: 'session_phase',
    payload: { phase: 'session_init_start', model: 'sonnet', resolvedModel: 'claude-sonnet-4', origin },
  } as TraceEvent;
}

// ---------------------------------------------------------------------------
// effectClassOf
// ---------------------------------------------------------------------------

describe('effectClassOf', () => {
  it('maps write tools to write', () => {
    expect(effectClassOf('write_file')).toBe('write');
    expect(effectClassOf('edit_file')).toBe('write');
    expect(effectClassOf('patch_apply')).toBe('write');
  });

  it('maps bash to execute', () => {
    expect(effectClassOf('bash')).toBe('execute');
  });

  it('maps browser tools to web', () => {
    expect(effectClassOf('browser_open')).toBe('web');
    expect(effectClassOf('browser_act')).toBe('web');
    expect(effectClassOf('web_request')).toBe('web');
  });

  it('maps unknown tools to other', () => {
    expect(effectClassOf('read_file')).toBe('other');
    expect(effectClassOf('unknown_tool')).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// buildBlockLedger
// ---------------------------------------------------------------------------

describe('buildBlockLedger', () => {
  it('counts hard-block events and groups by week/surface/tool/reason', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan mode'),
      mkHardBlock('2026-10-14T11:00:00.000Z', 'write_file', 'plan mode'),
      mkHardBlock('2026-10-14T12:00:00.000Z', 'bash', 'read-only gate'),
    ];
    const rows = buildBlockLedger('s1', events, 'cli');
    expect(rows).toHaveLength(2);
    const writeRow = rows.find((r) => r.blockedTool === 'write_file');
    expect(writeRow?.count).toBe(2);
    expect(writeRow?.surface).toBe('cli');
    expect(writeRow?.reason).toBe('plan mode');
    const bashRow = rows.find((r) => r.blockedTool === 'bash');
    expect(bashRow?.count).toBe(1);
  });

  it('ignores plain block events (no approvalOutcome)', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkPlainBlock('2026-10-14T10:00:00.000Z', 'write_file'),
      mkHardBlock('2026-10-14T11:00:00.000Z', 'bash', 'plan'),
    ];
    const rows = buildBlockLedger('s2', events, 'cli');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blockedTool).toBe('bash');
  });

  it('returns empty array when no hard-blocks exist', () => {
    resetSeq();
    const rows = buildBlockLedger('s3', [], 'cli');
    expect(rows).toHaveLength(0);
  });

  it('sorts by week descending, then count descending', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-07T10:00:00.000Z', 'bash', 'r'),   // W41
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'r'), // W42
      mkHardBlock('2026-10-14T11:00:00.000Z', 'write_file', 'r'), // W42 (2nd)
    ];
    const rows = buildBlockLedger('s4', events, 'cli');
    // W42 write_file (count=2) should come before W41 bash (count=1).
    expect(rows[0]?.week).toBe('2026-W42');
    expect(rows[0]?.count).toBe(2);
    expect(rows[1]?.week).toBe('2026-W41');
  });
});

// ---------------------------------------------------------------------------
// detectEvasions
// ---------------------------------------------------------------------------

describe('detectEvasions', () => {
  it('detects a write_file block followed by edit_file success within window', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan mode'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'read_file'),
      mkToolOk('2026-10-14T10:00:02.000Z', 'edit_file'), // same class, different tool
    ];
    const candidates = detectEvasions('s5', events);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.differentTool).toBe('edit_file');
    expect(candidates[0]?.effectClass).toBe('write');
    expect(candidates[0]?.toolCallDistance).toBe(2);
    expect(candidates[0]?.targetMatchUnavailable).toBe(true);
  });

  it('does NOT flag the same blocked tool name as an evasion', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan mode'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'write_file'), // same tool — not an evasion
    ];
    const candidates = detectEvasions('s6', events);
    expect(candidates).toHaveLength(0);
  });

  it('does NOT flag a different tool in a different effect class', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan mode'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'bash'), // execute class, not write
    ];
    const candidates = detectEvasions('s7', events);
    expect(candidates).toHaveLength(0);
  });

  it('does NOT flag a failed tool call as an evasion', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'bash', 'read-only'),
      mkToolErr('2026-10-14T10:00:01.000Z', 'edit_file'), // error — not an evasion
    ];
    const candidates = detectEvasions('s8', events);
    expect(candidates).toHaveLength(0);
  });

  it('respects the windowSize limit', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'read_file'),
      mkToolOk('2026-10-14T10:00:02.000Z', 'read_file'),
      mkToolOk('2026-10-14T10:00:03.000Z', 'edit_file'), // at position 3 (1-indexed)
    ];
    // Window of 2 completed tool calls — edit_file is at distance 3, outside.
    const small = detectEvasions('s9', events, 2);
    expect(small).toHaveLength(0);
    // Window of 5 — should detect.
    const wide = detectEvasions('s9', events, 5);
    expect(wide).toHaveLength(1);
  });

  it('does NOT flag blocks on "other" effect class tools', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'read_file', 'plan'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'glob'), // both 'other'
    ];
    const candidates = detectEvasions('s10', events);
    expect(candidates).toHaveLength(0);
  });

  it('returns empty array when no hard-blocks exist', () => {
    resetSeq();
    const candidates = detectEvasions('s11', []);
    expect(candidates).toHaveLength(0);
  });

  it('scopes evasion matching to the blocked actor (subagentId)', () => {
    resetSeq();
    // Child A blocked on write_file, child B succeeds with edit_file
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan', 'child-A'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'edit_file', 'child-B'), // different actor
    ];
    const candidates = detectEvasions('s-scope', events);
    expect(candidates).toHaveLength(0);
  });

  it('detects evasion when same actor uses a different tool in same class', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan', 'child-A'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'edit_file', 'child-B'), // different actor — skip
      mkToolOk('2026-10-14T10:00:02.000Z', 'edit_file', 'child-A'), // same actor — evasion
    ];
    const candidates = detectEvasions('s-scope2', events);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.differentTool).toBe('edit_file');
  });

  it('scopes root-level blocks to root-level tool calls (no subagentId)', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan'), // root block
      mkToolOk('2026-10-14T10:00:01.000Z', 'edit_file', 'child-X'), // child — skip
      mkToolOk('2026-10-14T10:00:02.000Z', 'edit_file'),             // root — evasion
    ];
    const candidates = detectEvasions('s-root', events);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.toolCallDistance).toBe(1); // only root calls counted
  });

  it('excludes the blocked call own completion from the window count', () => {
    resetSeq();
    // block write_file, then the denied write_file completes (isError), then edit_file
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan'),
      mkToolErr('2026-10-14T10:00:00.500Z', 'write_file'), // denied completion
      mkToolOk('2026-10-14T10:00:01.000Z', 'edit_file'),   // same class, different tool
    ];
    // With window=1, if the denied completion consumed the slot, edit_file is missed
    const candidates = detectEvasions('s-excl', events, 1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.differentTool).toBe('edit_file');
    expect(candidates[0]?.toolCallDistance).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// detectLostWork
// ---------------------------------------------------------------------------

describe('detectLostWork', () => {
  it('flags a block with no subsequent successful same-class call', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'read_file'),
      mkClosure('2026-10-14T10:01:00.000Z', 'model_end_turn'),
      mkSealed('2026-10-14T10:01:01.000Z', 'succeeded'),
    ];
    const candidates = detectLostWork('s12', events);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.blockedTool).toBe('write_file');
    expect(candidates[0]?.closureReason).toBe('succeeded');
    expect(candidates[0]?.targetMatchUnavailable).toBe(true);
  });

  it('does NOT flag a block when a later successful same-class call exists', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'edit_file'), // recovered
      mkSealed('2026-10-14T10:01:00.000Z', 'succeeded'),
    ];
    const candidates = detectLostWork('s13', events);
    expect(candidates).toHaveLength(0);
  });

  it('uses the closure reason from the closure event', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'bash', 'read-only'),
      mkClosure('2026-10-14T10:01:00.000Z', 'abort'),
      mkSealed('2026-10-14T10:01:01.000Z', 'failed'),
    ];
    const candidates = detectLostWork('s14', events);
    expect(candidates).toHaveLength(1);
    // closure event takes precedence; sealed status also updates but last write wins.
    expect(['abort', 'failed']).toContain(candidates[0]?.closureReason);
  });

  it('skips blocks on "other" class tools', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'read_file', 'plan'),
      mkSealed('2026-10-14T10:01:00.000Z'),
    ];
    const candidates = detectLostWork('s15', events);
    expect(candidates).toHaveLength(0);
  });

  it('returns empty array with no events', () => {
    resetSeq();
    expect(detectLostWork('s16', [])).toHaveLength(0);
  });

  it('scopes lost-work detection to the blocked actor (subagentId)', () => {
    resetSeq();
    // Child A blocked on write_file, child B recovers with edit_file
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan', 'child-A'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'edit_file', 'child-B'), // different actor
      mkClosure('2026-10-14T10:01:00.000Z'),
      mkSealed('2026-10-14T10:01:01.000Z'),
    ];
    const candidates = detectLostWork('s-scope', events);
    // Child B's recovery does NOT clear child A's block
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.blockedTool).toBe('write_file');
  });

  it('clears lost-work when the same actor recovers', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan', 'child-A'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'edit_file', 'child-A'), // same actor
      mkSealed('2026-10-14T10:01:00.000Z'),
    ];
    const candidates = detectLostWork('s-scope2', events);
    expect(candidates).toHaveLength(0);
  });

  it('does NOT report lost work on a live trace (no terminal event)', () => {
    resetSeq();
    // Only a hard-block, no closure/sealed/abort
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'read_file'),
    ];
    const candidates = detectLostWork('s-live', events);
    expect(candidates).toHaveLength(0);
  });

  it('reports lost work once a terminal event is present', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'read_file'),
      mkSealed('2026-10-14T10:01:00.000Z'),
    ];
    const candidates = detectLostWork('s-term', events);
    expect(candidates).toHaveLength(1);
  });

  it('reports lost work on an abort-only terminal (no closure / session_sealed)', () => {
    resetSeq();
    // An abort event alone (user Ctrl-C, signal kill) is a valid terminal;
    // lost-work detection must fire even when no closure or session_sealed follows.
    const abortEvent: TraceEvent = {
      kind: 'abort',
      seq: nextSeq(),
      ts: '2026-10-14T10:01:00.000Z',
      payload: {},
    };
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan'),
      mkToolOk('2026-10-14T10:00:01.000Z', 'read_file'),
      abortEvent,
    ];
    const candidates = detectLostWork('s-abort-only', events);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.closureReason).toBe('abort');
  });
});

// ---------------------------------------------------------------------------
// analyzeBlockEvasion (integration)
// ---------------------------------------------------------------------------

describe('analyzeBlockEvasion', () => {
  it('derives surface from session_init_start origin', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkInitPhase('2026-10-14T10:00:00.000Z', 'daemon'),
      mkSealed('2026-10-14T10:01:00.000Z'),
    ];
    const report = analyzeBlockEvasion('sid', events);
    expect(report.surface).toBe('daemon');
  });

  it('falls back to "unknown" surface when no init phase', () => {
    resetSeq();
    const report = analyzeBlockEvasion('sid', []);
    expect(report.surface).toBe('unknown');
  });

  it('returns all three sub-reports', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkInitPhase('2026-10-14T10:00:00.000Z', 'cli'),
      mkHardBlock('2026-10-14T10:00:01.000Z', 'write_file', 'plan'),
      mkToolOk('2026-10-14T10:00:02.000Z', 'edit_file'),
      mkSealed('2026-10-14T10:01:00.000Z'),
    ];
    const report = analyzeBlockEvasion('sid', events);
    expect(report.blockLedger).toHaveLength(1);
    expect(report.evasions).toHaveLength(1);
    // write_file blocked, edit_file called → recovered → not lost work
    expect(report.lostWork).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatBlockEvasionReport
// ---------------------------------------------------------------------------

describe('formatBlockEvasionReport', () => {
  it('includes all three section headers', () => {
    resetSeq();
    const report = analyzeBlockEvasion('test-session', []);
    const out = formatBlockEvasionReport(report);
    expect(out).toContain('Block-Evasion Report');
    expect(out).toContain('§1  Block ledger');
    expect(out).toContain('§2  Evasion candidates');
    expect(out).toContain('§3  Lost-work candidates');
  });

  it('shows (no hard-blocks recorded) when ledger is empty', () => {
    resetSeq();
    const out = formatBlockEvasionReport(analyzeBlockEvasion('s', []));
    expect(out).toContain('(no hard-blocks recorded)');
    expect(out).toContain('(none detected)');
  });

  it('renders block ledger rows with week and count', () => {
    resetSeq();
    const events: TraceEvent[] = [
      mkHardBlock('2026-10-14T10:00:00.000Z', 'write_file', 'plan mode'),
    ];
    const out = formatBlockEvasionReport(analyzeBlockEvasion('s', events));
    expect(out).toContain('2026-W42');
    expect(out).toContain('write_file');
    expect(out).toContain('plan mode');
  });

  it('renders NOTE about target matching being unavailable', () => {
    resetSeq();
    const out = formatBlockEvasionReport(analyzeBlockEvasion('s', []));
    expect(out).toContain('target matching unavailable');
  });
});
