/**
 * Fixture-based tests for the AFK witness trace → OTLP/JSON converter.
 *
 * Tests cover:
 *   - Empty trace produces a valid root-only span.
 *   - Tool call pair produces a child span with correct GenAI attributes.
 *   - Subagent lifecycle events produce a child span attributed via subagentId.
 *   - Tool call attributed to a subagent becomes a grandchild of that subagent span.
 *   - Failed tool call sets span status ERROR.
 *   - session_sealed drives session root attributes (cost, turn count).
 *   - Non-tool/subagent events attach as span events on the root.
 *   - Malformed count surfaces as afk.trace.malformed attribute.
 *   - Orphaned started event (no completed) does not crash.
 *
 * @module agent/trace/otlp-export.test
 */

import { describe, it, expect } from 'vitest';
import { traceToOtlp } from './otlp-export.js';
import type { TraceEvent } from './types.js';
import type { OtlpSpan } from './otlp-export.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

type EventObj = Partial<TraceEvent> & { ts: string; seq: number; kind: string; payload: Record<string, unknown> };

function ev(obj: EventObj): TraceEvent {
  return obj as unknown as TraceEvent;
}

const SESSION_ID = 'abc123def456abc1';

function findSpan(spans: OtlpSpan[], namePart: string): OtlpSpan | undefined {
  return spans.find((s) => s.name.includes(namePart));
}

function attr(span: OtlpSpan, key: string): unknown {
  const kv = span.attributes.find((a) => a.key === key);
  if (!kv) return undefined;
  const v = kv.value;
  if ('stringValue' in v) return v.stringValue;
  if ('intValue' in v) return v.intValue;
  if ('boolValue' in v) return v.boolValue;
  if ('doubleValue' in v) return v.doubleValue;
  return undefined;
}

function allSpans(result: ReturnType<typeof traceToOtlp>): OtlpSpan[] {
  return result.resourceSpans.flatMap((rs) =>
    rs.scopeSpans.flatMap((ss) => ss.spans),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('traceToOtlp', () => {
  it('empty trace produces exactly one root span', () => {
    const result = traceToOtlp([], { sessionId: SESSION_ID });
    const spans = allSpans(result);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('afk.session');
    expect(spans[0]!.parentSpanId).toBeUndefined();
  });

  it('root span carries gen_ai.system and afk.session.id', () => {
    const result = traceToOtlp([], { sessionId: SESSION_ID });
    const [root] = allSpans(result);
    expect(attr(root!, 'gen_ai.system')).toBe('agent-afk');
    expect(attr(root!, 'afk.session.id')).toBe(SESSION_ID);
    expect(attr(root!, 'gen_ai.operation.name')).toBe('chat');
  });

  it('malformed count appears as afk.trace.malformed when > 0', () => {
    const result = traceToOtlp([], { sessionId: SESSION_ID, malformed: 3 });
    const [root] = allSpans(result);
    expect(attr(root!, 'afk.trace.malformed')).toBe('3');
  });

  it('malformed=0 omits the attribute', () => {
    const result = traceToOtlp([], { sessionId: SESSION_ID, malformed: 0 });
    const [root] = allSpans(result);
    expect(root!.attributes.find((a) => a.key === 'afk.trace.malformed')).toBeUndefined();
  });

  it('tool call pair produces a tool.invoke child span', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:00.000Z', seq: 0, kind: 'tool_call', payload: { phase: 'started', toolUseId: 'tu1', name: 'read_file', inputBytes: 50 } }),
      ev({ ts: '2026-01-01T00:00:01.000Z', seq: 1, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'tu1', name: 'read_file', resultBytes: 200, isError: false, truncated: false, durationMs: 45 } }),
    ];
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const spans = allSpans(result);
    expect(spans).toHaveLength(2); // root + tool
    const tool = findSpan(spans, 'read_file');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('tool.invoke/read_file');
    expect(attr(tool!, 'afk.tool.name')).toBe('read_file');
    expect(attr(tool!, 'afk.tool.result_bytes')).toBe('200');
    expect(attr(tool!, 'afk.tool.is_error')).toBe(false);
    expect(attr(tool!, 'gen_ai.operation.name')).toBe('tool.invoke');
  });

  it('tool span is a child of the root span when no subagentId', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:00.000Z', seq: 0, kind: 'tool_call', payload: { phase: 'started', toolUseId: 'tu1', name: 'bash', inputBytes: 10 } }),
      ev({ ts: '2026-01-01T00:00:01.000Z', seq: 1, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'tu1', name: 'bash', resultBytes: 100, isError: false, truncated: false, durationMs: 500 } }),
    ];
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const spans = allSpans(result);
    const root = findSpan(spans, 'afk.session')!;
    const tool = findSpan(spans, 'bash')!;
    expect(tool.parentSpanId).toBe(root.spanId);
  });

  it('failed tool call sets span status ERROR', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:00.000Z', seq: 0, kind: 'tool_call', payload: { phase: 'started', toolUseId: 'tu2', name: 'write_file', inputBytes: 20 } }),
      ev({ ts: '2026-01-01T00:00:01.000Z', seq: 1, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'tu2', name: 'write_file', resultBytes: 50, isError: true, truncated: false, durationMs: 10, failureClass: 'permission-denied' } }),
    ];
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const spans = allSpans(result);
    const tool = findSpan(spans, 'write_file')!;
    expect(tool.status.code).toBe(2);
    expect(attr(tool, 'afk.tool.failure_class')).toBe('permission-denied');
    expect(attr(tool, 'afk.tool.is_error')).toBe(true);
  });

  it('subagent lifecycle events produce an agent.invoke child span', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:00.000Z', seq: 0, kind: 'subagent_lifecycle', payload: { transition: 'started', subagentId: 'sub1', parentId: 'root', model: 'claude-sonnet', agentType: 'research-agent' } }),
      ev({ ts: '2026-01-01T00:01:00.000Z', seq: 1, kind: 'subagent_lifecycle', payload: { transition: 'succeeded', subagentId: 'sub1', durationMs: 60000, turnCount: 5, outputBytes: 1000 } }),
    ];
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const spans = allSpans(result);
    expect(spans).toHaveLength(2); // root + subagent
    const sub = findSpan(spans, 'research-agent')!;
    expect(sub).toBeDefined();
    expect(sub.name).toBe('agent.invoke/research-agent');
    expect(attr(sub, 'gen_ai.operation.name')).toBe('agent.invoke');
    expect(attr(sub, 'gen_ai.request.model')).toBe('claude-sonnet');
    expect(attr(sub, 'gen_ai.agent.id')).toBe('sub1');
    expect(attr(sub, 'afk.subagent.id')).toBe('sub1');
    expect(attr(sub, 'afk.subagent.parent_id')).toBe('root');
    expect(attr(sub, 'afk.subagent.turn_count')).toBe('5');
    expect(sub.status.code).toBe(1); // OK
  });

  it('failed subagent span has ERROR status', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:00.000Z', seq: 0, kind: 'subagent_lifecycle', payload: { transition: 'started', subagentId: 'sub2', parentId: 'root', model: 'haiku' } }),
      ev({ ts: '2026-01-01T00:00:30.000Z', seq: 1, kind: 'subagent_lifecycle', payload: { transition: 'failed', subagentId: 'sub2', errorClass: 'TimeoutError', errorMessage: 'timed out', partialOutputBytes: 0 } }),
    ];
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const spans = allSpans(result);
    const sub = spans.find((s) => s.name.startsWith('agent.invoke'))!;
    expect(sub.status.code).toBe(2);
  });

  it('tool call attributed to a subagent becomes a grandchild of subagent span', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:00.000Z', seq: 0, kind: 'subagent_lifecycle', payload: { transition: 'started', subagentId: 'sub1', parentId: 'root', model: 'sonnet' } }),
      ev({ ts: '2026-01-01T00:00:01.000Z', seq: 1, kind: 'tool_call', payload: { phase: 'started', toolUseId: 'tu3', name: 'glob', inputBytes: 15, subagentId: 'sub1' } }),
      ev({ ts: '2026-01-01T00:00:02.000Z', seq: 2, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'tu3', name: 'glob', resultBytes: 300, isError: false, truncated: false, durationMs: 80, subagentId: 'sub1' } }),
      ev({ ts: '2026-01-01T00:01:00.000Z', seq: 3, kind: 'subagent_lifecycle', payload: { transition: 'succeeded', subagentId: 'sub1', durationMs: 60000, turnCount: 2, outputBytes: 500 } }),
    ];
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const spans = allSpans(result);
    expect(spans).toHaveLength(3); // root + subagent + tool

    const root = findSpan(spans, 'afk.session')!;
    const sub = spans.find((s) => s.name.startsWith('agent.invoke'))!;
    const tool = findSpan(spans, 'glob')!;

    expect(sub.parentSpanId).toBe(root.spanId);
    expect(tool.parentSpanId).toBe(sub.spanId);
    expect(attr(tool, 'afk.subagent.id')).toBe('sub1');
  });

  it('session_sealed drives root span attributes', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:00.000Z', seq: 0, kind: 'closure', payload: { reason: 'model_end_turn', finalTurnCount: 3, finalCostUsd: 0.05, finalTokens: {} } }),
      ev({ ts: '2026-01-01T00:00:01.000Z', seq: 1, kind: 'session_sealed', payload: { status: 'succeeded', finalCostUsd: 0.05, finalTurnCount: 3, closedAt: '2026-01-01T00:00:01.000Z', subagentCount: 0 } }),
    ];
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const [root] = allSpans(result);
    expect(attr(root!, 'gen_ai.usage.cost_usd')).toBe(0.05);
    expect(attr(root!, 'afk.session.turn_count')).toBe('3');
    expect(root!.status.code).toBe(1); // succeeded → OK
  });

  it('failed session_sealed sets root span status ERROR', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:01.000Z', seq: 0, kind: 'session_sealed', payload: { status: 'failed', finalCostUsd: 0, finalTurnCount: 0, closedAt: '2026-01-01T00:00:01.000Z' } }),
    ];
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const [root] = allSpans(result);
    expect(root!.status.code).toBe(2);
  });

  it('non-tool/subagent events attach as span events on the root', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:00.000Z', seq: 0, kind: 'closure', payload: { reason: 'iteration_cap', finalTurnCount: 10, finalCostUsd: 0.1, finalTokens: {} } }),
      ev({ ts: '2026-01-01T00:00:01.000Z', seq: 1, kind: 'abort', payload: { origin: 'budget', cascadedTo: [] } }),
    ];
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const [root] = allSpans(result);
    expect(root!.events).toBeDefined();
    const evNames = (root!.events ?? []).map((e) => e.name);
    expect(evNames).toContain('closure');
    expect(evNames).toContain('abort');
    const closureEv = root!.events!.find((e) => e.name === 'closure')!;
    const closureAttr = (key: string) => {
      const kv = closureEv.attributes?.find((a) => a.key === key);
      if (!kv) return undefined;
      const v = kv.value;
      if ('stringValue' in v) return v.stringValue;
      if ('intValue' in v) return v.intValue;
      if ('doubleValue' in v) return v.doubleValue;
      return undefined;
    };
    expect(closureAttr('afk.closure.reason')).toBe('iteration_cap');
  });

  it('hook_decision block events attach as span events', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:00.000Z', seq: 0, kind: 'hook_decision', payload: { hookEvent: 'PreToolUse', decision: 'block', blockedTool: 'write_file' } }),
    ];
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const [root] = allSpans(result);
    const hookEv = root!.events?.find((e) => e.name === 'hook_decision');
    expect(hookEv).toBeDefined();
    const hAttr = (key: string) => {
      const kv = hookEv!.attributes?.find((a) => a.key === key);
      if (!kv) return undefined;
      const v = kv.value;
      if ('stringValue' in v) return v.stringValue;
      return undefined;
    };
    expect(hAttr('afk.hook.decision')).toBe('block');
    expect(hAttr('afk.hook.blocked_tool')).toBe('write_file');
  });

  it('orphaned started event (no completed) does not crash and has UNSET status', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:00.000Z', seq: 0, kind: 'tool_call', payload: { phase: 'started', toolUseId: 'orphan1', name: 'bash', inputBytes: 5 } }),
    ];
    expect(() => traceToOtlp(events, { sessionId: SESSION_ID })).not.toThrow();
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const spans = allSpans(result);
    const tool = findSpan(spans, 'bash')!;
    expect(tool).toBeDefined();
    expect(tool.status.code).toBe(0); // UNSET
  });

  it('all spans share the same traceId derived from sessionId', () => {
    const events: TraceEvent[] = [
      ev({ ts: '2026-01-01T00:00:00.000Z', seq: 0, kind: 'subagent_lifecycle', payload: { transition: 'started', subagentId: 'sub1', parentId: 'root', model: 'sonnet' } }),
      ev({ ts: '2026-01-01T00:00:01.000Z', seq: 1, kind: 'tool_call', payload: { phase: 'started', toolUseId: 'tu1', name: 'read_file', inputBytes: 10 } }),
      ev({ ts: '2026-01-01T00:00:02.000Z', seq: 2, kind: 'tool_call', payload: { phase: 'completed', toolUseId: 'tu1', name: 'read_file', resultBytes: 50, isError: false, truncated: false, durationMs: 30 } }),
      ev({ ts: '2026-01-01T00:01:00.000Z', seq: 3, kind: 'subagent_lifecycle', payload: { transition: 'succeeded', subagentId: 'sub1', durationMs: 60000, turnCount: 1, outputBytes: 100 } }),
    ];
    const result = traceToOtlp(events, { sessionId: SESSION_ID });
    const spans = allSpans(result);
    const traceIds = new Set(spans.map((s) => s.traceId));
    expect(traceIds.size).toBe(1);
  });

  it('resource attributes include service.name=agent-afk', () => {
    const result = traceToOtlp([], { sessionId: SESSION_ID });
    const resourceAttrs = result.resourceSpans[0]!.resource.attributes;
    const svcName = resourceAttrs.find((a) => a.key === 'service.name');
    expect(svcName).toBeDefined();
    expect('stringValue' in svcName!.value && svcName!.value.stringValue).toBe('agent-afk');
  });

  it('scope has name agent-afk.witness', () => {
    const result = traceToOtlp([], { sessionId: SESSION_ID });
    const scope = result.resourceSpans[0]!.scopeSpans[0]!.scope;
    expect(scope.name).toBe('agent-afk.witness');
  });

  it('deterministic span ids are stable across calls', () => {
    const r1 = traceToOtlp([], { sessionId: SESSION_ID });
    const r2 = traceToOtlp([], { sessionId: SESSION_ID });
    expect(allSpans(r1)[0]!.spanId).toBe(allSpans(r2)[0]!.spanId);
  });
});
