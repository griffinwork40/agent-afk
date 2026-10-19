/**
 * Sub-builders for the AFK witness trace → OTLP/JSON converter.
 *
 * Extracted to keep `otlp-export.ts` under the 350-line file ceiling.
 * These are pure functions with no I/O or SDK dependency.
 *
 * @module agent/trace/otlp-export.builders
 */

import type { TraceEvent, ToolCallStartedPayload, ToolCallCompletedPayload } from './types.js';
import type { OtlpSpan, SpanStatus, KeyValue, SpanEvent } from './otlp-export.js';

// ---------------------------------------------------------------------------
// Attribute builders (re-exported for use in the main module)
// ---------------------------------------------------------------------------

export function strAttr(key: string, value: string): KeyValue { return { key, value: { stringValue: value } }; }
export function intAttr(key: string, value: number): KeyValue { return { key, value: { intValue: String(Math.round(value)) } }; }
export function boolAttr(key: string, value: boolean): KeyValue { return { key, value: { boolValue: value } }; }
export function doubleAttr(key: string, value: number): KeyValue { return { key, value: { doubleValue: value } }; }

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

export const SCOPE_NAME = 'agent-afk.witness';
export const SCOPE_VERSION = '0.1.0';
export const GEN_AI_SYSTEM = 'agent-afk';

export function isoToNano(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '0' : (BigInt(ms) * 1_000_000n).toString();
}

export function addDurationNano(startIso: string, durationMs: number): string {
  const ms = Date.parse(startIso);
  if (Number.isNaN(ms)) return isoToNano(startIso);
  return (BigInt(Math.round(ms + durationMs)) * 1_000_000n).toString();
}

/** Derive a 16-byte hex trace id from the session id (padded/truncated). */
export function sessionToTraceId(sessionId: string): string {
  const hex = sessionId.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.padEnd(32, '0').slice(0, 32);
}

/** Deterministic 8-byte span id (FNV-1a, two passes, concatenated). */
export function seedSpanId(seed: string): string {
  let h1 = 2166136261;
  for (let i = 0; i < seed.length; i++) { h1 ^= seed.charCodeAt(i); h1 = (h1 * 16777619) >>> 0; }
  let h2 = 2166136261;
  for (let i = seed.length - 1; i >= 0; i--) { h2 ^= seed.charCodeAt(i) * 31; h2 = (h2 * 16777619) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

export interface SubagentInfo {
  parentId: string; model?: string; agentType?: string;
  startTs: string; endTs?: string;
  succeeded: boolean; failed: boolean;
  durationMs?: number; turnCount?: number; costUsd?: number;
}

export interface ToolCallPair {
  started?: { payload: ToolCallStartedPayload; ts: string };
  completed?: { payload: ToolCallCompletedPayload; ts: string };
  /** Tool name taken from completed when no started record exists. */
  bestEffortName?: string;
  /** toolUseId for span-id seeding when no started record exists. */
  toolUseId: string;
}

// ---------------------------------------------------------------------------
// Indexers
// ---------------------------------------------------------------------------

/**
 * Index subagent_lifecycle events (including background_agent) into a map.
 *
 * Fix #4106 item 4: background_agent events carry subagentId and model in
 * their `started` transition — index them so their tool calls get a span.
 */
export function indexSubagents(events: readonly TraceEvent[]): Map<string, SubagentInfo> {
  const map = new Map<string, SubagentInfo>();
  for (const ev of events) {
    if (ev.kind === 'subagent_lifecycle') {
      const p = ev.payload;
      if (p.transition === 'started') {
        map.set(p.subagentId, { parentId: p.parentId, model: p.model,
          agentType: p.agentType ?? p.resolvedAgentType, startTs: ev.ts,
          succeeded: false, failed: false });
      } else if (p.transition === 'succeeded') {
        const info = map.get(p.subagentId);
        if (info) { info.endTs = ev.ts; info.succeeded = true; info.durationMs = p.durationMs; info.turnCount = p.turnCount; info.costUsd = p.totalCostUsd; }
      } else if (p.transition === 'failed') {
        const info = map.get(p.subagentId);
        if (info) { info.endTs = ev.ts; info.failed = true; }
      } else if (p.transition === 'cancelled') {
        const info = map.get(p.subagentId);
        if (info && !info.endTs) { info.endTs = ev.ts; }
      }
    } else if (ev.kind === 'background_agent') {
      // Fix #4106 item 4: index background_agent events so tool calls
      // fired by background jobs are attributed to their own span.
      const p = ev.payload;
      if (p.transition === 'started') {
        map.set(p.subagentId, { parentId: 'root', model: p.model,
          agentType: `background/${p.label}`, startTs: ev.ts,
          succeeded: false, failed: false });
      } else if (p.transition === 'completed') {
        const info = map.get(p.subagentId);
        if (info) { info.endTs = ev.ts; info.succeeded = true; info.durationMs = p.durationMs; }
      } else if (p.transition === 'failed') {
        const info = map.get(p.subagentId);
        if (info) { info.endTs = ev.ts; info.failed = true; }
      } else if (p.transition === 'cancelled') {
        const info = map.get(p.subagentId);
        if (info && !info.endTs) { info.endTs = ev.ts; }
      }
    }
  }
  return map;
}

/**
 * Index tool_call started+completed pairs by toolUseId.
 *
 * Fix #4106 item 2: completed-only records (no matching started) are now
 * emitted as best-effort spans instead of being silently dropped.
 */
export function indexToolPairs(events: readonly TraceEvent[]): Map<string, ToolCallPair> {
  const map = new Map<string, ToolCallPair>();
  for (const ev of events) {
    if (ev.kind !== 'tool_call') continue;
    const p = ev.payload;
    if (p.phase === 'started') {
      const existing = map.get(p.toolUseId);
      if (existing) {
        existing.started = { payload: p, ts: ev.ts };
        existing.bestEffortName = undefined;
      } else {
        map.set(p.toolUseId, { started: { payload: p, ts: ev.ts }, toolUseId: p.toolUseId });
      }
    } else if (p.phase === 'completed') {
      const pair = map.get(p.toolUseId);
      if (pair) {
        pair.completed = { payload: p, ts: ev.ts };
      } else {
        // completed-only: emit best-effort span (fix #4106 item 2)
        map.set(p.toolUseId, {
          completed: { payload: p, ts: ev.ts },
          bestEffortName: p.name,
          toolUseId: p.toolUseId,
        });
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Span builders
// ---------------------------------------------------------------------------

/** Build one OTLP span per subagent fork. Returns spans + a subagentId→spanId map. */
export function buildSubagentSpans(
  subagentMap: Map<string, SubagentInfo>,
  traceId: string,
  rootSpanId: string,
  lastTs: string,
): { spans: OtlpSpan[]; spanIds: Map<string, string> } {
  const spanIds = new Map<string, string>();
  const spans: OtlpSpan[] = [];

  for (const [subId, info] of subagentMap) {
    const spanId = seedSpanId(`subagent:${subId}`);
    spanIds.set(subId, spanId);
    const parentSpanId = subagentMap.has(info.parentId)
      ? (spanIds.get(info.parentId) ?? rootSpanId) : rootSpanId;

    const attrs: KeyValue[] = [
      strAttr('gen_ai.system', GEN_AI_SYSTEM),
      strAttr('gen_ai.operation.name', 'agent.invoke'),
      strAttr('afk.subagent.id', subId),
      strAttr('afk.subagent.parent_id', info.parentId),
      strAttr('gen_ai.agent.id', subId),
    ];
    if (info.model) attrs.push(strAttr('gen_ai.request.model', info.model));
    if (info.agentType) attrs.push(strAttr('gen_ai.agent.name', info.agentType));
    if (info.turnCount !== undefined) attrs.push(intAttr('afk.subagent.turn_count', info.turnCount));
    if (info.costUsd !== undefined) attrs.push(doubleAttr('gen_ai.usage.cost_usd', info.costUsd));

    const status: SpanStatus = info.failed ? { code: 2, message: 'subagent failed' }
      : info.succeeded ? { code: 1 } : { code: 0 };

    spans.push({
      traceId, spanId, parentSpanId,
      name: info.agentType ? `agent.invoke/${info.agentType}` : 'agent.invoke',
      kind: 1,
      startTimeUnixNano: isoToNano(info.startTs),
      endTimeUnixNano: isoToNano(info.endTs ?? lastTs),
      attributes: attrs, status,
    });
  }
  return { spans, spanIds };
}

/**
 * Build one OTLP span per tool call pair.
 *
 * Fix #4106 item 2: completed-only pairs (no started) emit a best-effort span
 * anchored at the completed timestamp with UNSET start and a best-effort flag.
 * Fix #4106 item 3: errorHead is omitted unless opts.includeErrorDetails is true.
 */
export function buildToolSpans(
  toolPairs: Map<string, ToolCallPair>,
  traceId: string,
  rootSpanId: string,
  subagentSpanIds: Map<string, string>,
  opts: { includeErrorDetails?: boolean } = {},
): OtlpSpan[] {
  const spans: OtlpSpan[] = [];
  for (const [toolUseId, pair] of toolPairs) {
    const { started, completed } = pair;

    // Determine parent span id from whichever record has a subagentId.
    const subagentId = started?.payload.subagentId ?? completed?.payload.subagentId;
    const parentSpanId = subagentId
      ? (subagentSpanIds.get(subagentId) ?? rootSpanId) : rootSpanId;

    // Tool name: prefer started, fall back to completed (best-effort).
    const toolName = started?.payload.name ?? completed?.payload.name ?? 'unknown';

    const attrs: KeyValue[] = [
      strAttr('gen_ai.system', GEN_AI_SYSTEM),
      strAttr('gen_ai.operation.name', 'tool.invoke'),
      strAttr('afk.tool.name', toolName),
      strAttr('afk.tool.use_id', toolUseId),
    ];
    if (started) attrs.push(intAttr('afk.tool.input_bytes', started.payload.inputBytes));
    if (subagentId) attrs.push(strAttr('afk.subagent.id', subagentId));
    if (!started) attrs.push(boolAttr('afk.tool.best_effort', true));

    let startNano: string;
    let endNano: string;
    let status: SpanStatus;

    if (completed) {
      const cp = completed.payload;
      // For best-effort (no started), use completed ts as both start and end.
      startNano = started ? isoToNano(started.ts) : isoToNano(completed.ts);
      endNano = started ? addDurationNano(started.ts, cp.durationMs) : isoToNano(completed.ts);
      attrs.push(intAttr('afk.tool.result_bytes', cp.resultBytes));
      attrs.push(boolAttr('afk.tool.is_error', cp.isError));
      if (cp.failureClass) attrs.push(strAttr('afk.tool.failure_class', cp.failureClass));
      // Fix #4106 item 3: omit errorHead by default; include only when opted in.
      if (opts.includeErrorDetails && cp.errorHead) {
        attrs.push(strAttr('afk.tool.error_head', cp.errorHead));
      }
      if (cp.batchSize !== undefined && cp.batchSize > 1) {
        attrs.push(intAttr('afk.tool.batch_index', cp.batchIndex ?? 1));
        attrs.push(intAttr('afk.tool.batch_size', cp.batchSize));
      }
      status = cp.isError ? { code: 2, message: cp.failureClass ?? 'tool error' } : { code: 1 };
    } else {
      // started-only (orphan)
      startNano = isoToNano(started!.ts);
      endNano = startNano;
      status = { code: 0 };
    }

    spans.push({
      traceId, spanId: seedSpanId(`tool:${toolUseId}`),
      parentSpanId, name: `tool.invoke/${toolName}`, kind: 1,
      startTimeUnixNano: startNano, endTimeUnixNano: endNano,
      attributes: attrs, status,
    });
  }
  return spans;
}

/** Attach non-tool/subagent events as span events on the root span. */
export function buildRootSpanEvents(events: readonly TraceEvent[]): SpanEvent[] {
  const result: SpanEvent[] = [];
  for (const ev of events) {
    if (ev.kind === 'tool_call' || ev.kind === 'subagent_lifecycle' ||
        ev.kind === 'background_agent' ||
        ev.kind === 'session_sealed' || ev.kind === 'hook_summary') continue;

    const evAttrs: KeyValue[] = [];
    if (ev.kind === 'closure') {
      evAttrs.push(strAttr('afk.closure.reason', ev.payload.reason));
      evAttrs.push(intAttr('afk.closure.turn_count', ev.payload.finalTurnCount));
      evAttrs.push(doubleAttr('afk.closure.cost_usd', ev.payload.finalCostUsd));
    } else if (ev.kind === 'budget') {
      evAttrs.push(doubleAttr('afk.budget.running_cost_usd', ev.payload.runningCostUsd));
      evAttrs.push(doubleAttr('afk.budget.max_budget_usd', ev.payload.maxBudgetUsd));
    } else if (ev.kind === 'abort') {
      evAttrs.push(strAttr('afk.abort.origin', ev.payload.origin));
    } else if (ev.kind === 'hook_decision') {
      if (ev.payload.decision) evAttrs.push(strAttr('afk.hook.decision', ev.payload.decision));
      evAttrs.push(strAttr('afk.hook.event', ev.payload.hookEvent));
      if (ev.payload.blockedTool) evAttrs.push(strAttr('afk.hook.blocked_tool', ev.payload.blockedTool));
    } else if (ev.kind === 'session_phase') {
      evAttrs.push(strAttr('afk.phase.name', ev.payload.phase));
      if ('durationMs' in ev.payload && typeof ev.payload.durationMs === 'number') {
        evAttrs.push(intAttr('afk.phase.duration_ms', ev.payload.durationMs));
      }
    } else if (ev.kind === 'claim') {
      evAttrs.push(strAttr('afk.claim.source', ev.payload.source));
      evAttrs.push(doubleAttr('afk.claim.confidence', ev.payload.confidence));
    }

    result.push({ timeUnixNano: isoToNano(ev.ts), name: ev.kind,
      ...(evAttrs.length > 0 ? { attributes: evAttrs } : {}) });
  }
  return result;
}
