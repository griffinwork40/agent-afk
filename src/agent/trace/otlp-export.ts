/**
 * Offline converter: AFK witness trace → OTLP/JSON spans (GenAI semantic conventions).
 *
 * Converts a parsed `trace.jsonl` into an OTLP ExportTraceServiceRequest JSON
 * payload that any OpenTelemetry-compatible collector can ingest. No OTel SDK
 * runtime dependency: this is a pure data transformation — read NDJSON, emit JSON.
 *
 * ## Span hierarchy
 *
 * One root span covers the whole session (`afk.session`). Each subagent fork
 * gets a child span (`agent.invoke`) attributed via `subagentId` / `parentId`.
 * Tool calls get leaf spans (`tool.invoke`). Events that cannot be attributed
 * to a specific actor (e.g. `session_phase`, `closure`) attach as span events
 * on the session root.
 *
 * ## GenAI semantic conventions used
 *
 * Spec: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *   gen_ai.system              — always "agent-afk"
 *   gen_ai.operation.name      — "chat" | "agent.invoke" | "tool.invoke"
 *   gen_ai.agent.id            — subagent id (forked child spans)
 *   gen_ai.agent.name          — resolved agent type / tool name
 *   gen_ai.request.model       — model string from subagent_lifecycle.started
 *   gen_ai.usage.input_tokens  — from session_sealed subagentTokens
 *   gen_ai.usage.output_tokens — from session_sealed subagentTokens
 *
 * Additional AFK-specific attributes use the `afk.` prefix:
 *   afk.session.id, afk.tool.name, afk.tool.result_bytes, afk.tool.is_error,
 *   afk.subagent.id, afk.subagent.parent_id, afk.trace.malformed, …
 *
 * @module agent/trace/otlp-export
 */

import type { TraceEvent, ToolCallStartedPayload, ToolCallCompletedPayload } from './types.js';

// ---------------------------------------------------------------------------
// OTLP JSON types (minimal subset for ExportTraceServiceRequest)
// ---------------------------------------------------------------------------

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean }
  | { doubleValue: number };

interface KeyValue { key: string; value: AnyValue }

/** Minimal OTLP span event (attached to a span). */
interface SpanEvent {
  timeUnixNano: string;
  name: string;
  attributes?: KeyValue[];
}

/** OTLP span status. */
interface SpanStatus { code: 0 | 1 | 2; message?: string }

/** Minimal OTLP Span. */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  events?: SpanEvent[];
  status: SpanStatus;
}

/** One ResourceSpans entry in the OTLP payload. */
export interface OtlpResourceSpans {
  resource: { attributes: KeyValue[] };
  scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
}

/** The top-level OTLP ExportTraceServiceRequest shape. */
export interface OtlpExportRequest {
  resourceSpans: OtlpResourceSpans[];
}

// ---------------------------------------------------------------------------
// Attribute builders
// ---------------------------------------------------------------------------

function strAttr(key: string, value: string): KeyValue { return { key, value: { stringValue: value } }; }
function intAttr(key: string, value: number): KeyValue { return { key, value: { intValue: String(Math.round(value)) } }; }
function boolAttr(key: string, value: boolean): KeyValue { return { key, value: { boolValue: value } }; }
function doubleAttr(key: string, value: number): KeyValue { return { key, value: { doubleValue: value } }; }

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

const SCOPE_NAME = 'agent-afk.witness';
const SCOPE_VERSION = '0.1.0';
const GEN_AI_SYSTEM = 'agent-afk';

function isoToNano(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '0' : (BigInt(ms) * 1_000_000n).toString();
}

function addDurationNano(startIso: string, durationMs: number): string {
  const ms = Date.parse(startIso);
  if (Number.isNaN(ms)) return isoToNano(startIso);
  return (BigInt(Math.round(ms + durationMs)) * 1_000_000n).toString();
}

/** Derive a 16-byte hex trace id from the session id (padded/truncated). */
function sessionToTraceId(sessionId: string): string {
  const hex = sessionId.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex.padEnd(32, '0').slice(0, 32);
}

/** Deterministic 8-byte span id (FNV-1a, two passes, concatenated). */
function seedSpanId(seed: string): string {
  let h1 = 2166136261;
  for (let i = 0; i < seed.length; i++) { h1 ^= seed.charCodeAt(i); h1 = (h1 * 16777619) >>> 0; }
  let h2 = 2166136261;
  for (let i = seed.length - 1; i >= 0; i--) { h2 ^= seed.charCodeAt(i) * 31; h2 = (h2 * 16777619) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Internal state types
// ---------------------------------------------------------------------------

interface SubagentInfo {
  parentId: string; model?: string; agentType?: string;
  startTs: string; endTs?: string;
  succeeded: boolean; failed: boolean;
  durationMs?: number; turnCount?: number; costUsd?: number;
}

interface ToolCallPair {
  started: { payload: ToolCallStartedPayload; ts: string };
  completed?: { payload: ToolCallCompletedPayload; ts: string };
}

// ---------------------------------------------------------------------------
// Sub-builders (each <200 lines, each takes explicit parameters)
// ---------------------------------------------------------------------------

/** Index subagent lifecycle events into a map by subagentId. */
function indexSubagents(events: readonly TraceEvent[]): Map<string, SubagentInfo> {
  const map = new Map<string, SubagentInfo>();
  for (const ev of events) {
    if (ev.kind !== 'subagent_lifecycle') continue;
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
  }
  return map;
}

/** Index tool_call started+completed pairs by toolUseId. */
function indexToolPairs(events: readonly TraceEvent[]): Map<string, ToolCallPair> {
  const map = new Map<string, ToolCallPair>();
  for (const ev of events) {
    if (ev.kind !== 'tool_call') continue;
    const p = ev.payload;
    if (p.phase === 'started') {
      map.set(p.toolUseId, { started: { payload: p, ts: ev.ts } });
    } else if (p.phase === 'completed') {
      const pair = map.get(p.toolUseId);
      if (pair) pair.completed = { payload: p, ts: ev.ts };
    }
  }
  return map;
}

/** Build one OTLP span per subagent fork. Returns spans + a subagentId→spanId map. */
function buildSubagentSpans(
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

/** Build one OTLP span per tool call pair. */
function buildToolSpans(
  toolPairs: Map<string, ToolCallPair>,
  traceId: string,
  rootSpanId: string,
  subagentSpanIds: Map<string, string>,
): OtlpSpan[] {
  const spans: OtlpSpan[] = [];
  for (const [toolUseId, pair] of toolPairs) {
    const { started, completed } = pair;
    const { payload: sp } = started;
    const parentSpanId = sp.subagentId
      ? (subagentSpanIds.get(sp.subagentId) ?? rootSpanId) : rootSpanId;

    const attrs: KeyValue[] = [
      strAttr('gen_ai.system', GEN_AI_SYSTEM),
      strAttr('gen_ai.operation.name', 'tool.invoke'),
      strAttr('afk.tool.name', sp.name),
      strAttr('afk.tool.use_id', toolUseId),
      intAttr('afk.tool.input_bytes', sp.inputBytes),
    ];
    if (sp.subagentId) attrs.push(strAttr('afk.subagent.id', sp.subagentId));

    let endNano: string;
    let status: SpanStatus;
    if (completed) {
      const cp = completed.payload;
      endNano = addDurationNano(started.ts, cp.durationMs);
      attrs.push(intAttr('afk.tool.result_bytes', cp.resultBytes));
      attrs.push(boolAttr('afk.tool.is_error', cp.isError));
      if (cp.failureClass) attrs.push(strAttr('afk.tool.failure_class', cp.failureClass));
      if (cp.errorHead) attrs.push(strAttr('afk.tool.error_head', cp.errorHead));
      if (cp.batchSize !== undefined && cp.batchSize > 1) {
        attrs.push(intAttr('afk.tool.batch_index', cp.batchIndex ?? 1));
        attrs.push(intAttr('afk.tool.batch_size', cp.batchSize));
      }
      status = cp.isError ? { code: 2, message: cp.failureClass ?? 'tool error' } : { code: 1 };
    } else {
      endNano = isoToNano(started.ts);
      status = { code: 0 };
    }

    spans.push({
      traceId, spanId: seedSpanId(`tool:${toolUseId}`),
      parentSpanId, name: `tool.invoke/${sp.name}`, kind: 1,
      startTimeUnixNano: isoToNano(started.ts), endTimeUnixNano: endNano,
      attributes: attrs, status,
    });
  }
  return spans;
}

/** Attach non-tool/subagent events as span events on the root span. */
function buildRootSpanEvents(events: readonly TraceEvent[]): SpanEvent[] {
  const result: SpanEvent[] = [];
  for (const ev of events) {
    if (ev.kind === 'tool_call' || ev.kind === 'subagent_lifecycle' ||
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options for {@link traceToOtlp}. */
export interface TraceToOtlpOptions {
  /** Session id — used to derive the traceId and as the root span attribute. */
  sessionId: string;
  /** Count of malformed lines from the parse pass (surfaced as an attribute). */
  malformed?: number;
}

/**
 * Convert a list of parsed trace events into an OTLP ExportTraceServiceRequest.
 *
 * Pure function: no I/O, no side effects, no SDK dependency.
 * Safe to call in tests without any OTel infrastructure.
 */
export function traceToOtlp(
  events: readonly TraceEvent[],
  opts: TraceToOtlpOptions,
): OtlpExportRequest {
  const { sessionId, malformed = 0 } = opts;
  const traceId = sessionToTraceId(sessionId);

  // Derive session wall-clock bounds and sealed metadata.
  const firstTs = events.length > 0 ? events[0]!.ts : new Date().toISOString();
  let lastTs = firstTs;
  let sessionStatus: SpanStatus = { code: 1 };
  let finalCost: number | undefined;
  let finalTurns: number | undefined;
  let finalTokens: { input?: number; output?: number } | undefined;

  for (const ev of events) {
    if (ev.ts > lastTs) lastTs = ev.ts;
    if (ev.kind === 'session_sealed') {
      lastTs = ev.ts;
      if (ev.payload.status !== 'succeeded') sessionStatus = { code: 2, message: `session ${ev.payload.status}` };
      finalCost = ev.payload.finalCostUsd;
      finalTurns = ev.payload.finalTurnCount;
      finalTokens = ev.payload.subagentTokens;
    }
  }

  // Root span attributes.
  const rootSpanId = seedSpanId(`session:${sessionId}`);
  const rootAttrs: KeyValue[] = [
    strAttr('gen_ai.system', GEN_AI_SYSTEM),
    strAttr('gen_ai.operation.name', 'chat'),
    strAttr('afk.session.id', sessionId),
  ];
  if (malformed > 0) rootAttrs.push(intAttr('afk.trace.malformed', malformed));
  if (finalCost !== undefined) rootAttrs.push(doubleAttr('gen_ai.usage.cost_usd', finalCost));
  if (finalTurns !== undefined) rootAttrs.push(intAttr('afk.session.turn_count', finalTurns));
  if (finalTokens?.input !== undefined) rootAttrs.push(intAttr('gen_ai.usage.input_tokens', finalTokens.input));
  if (finalTokens?.output !== undefined) rootAttrs.push(intAttr('gen_ai.usage.output_tokens', finalTokens.output));

  // Build child spans.
  const subagentMap = indexSubagents(events);
  const { spans: subagentSpans, spanIds: subagentSpanIds } =
    buildSubagentSpans(subagentMap, traceId, rootSpanId, lastTs);
  const toolSpans = buildToolSpans(indexToolPairs(events), traceId, rootSpanId, subagentSpanIds);
  const rootEvents = buildRootSpanEvents(events);

  const rootSpan: OtlpSpan = {
    traceId, spanId: rootSpanId, name: 'afk.session', kind: 1,
    startTimeUnixNano: isoToNano(firstTs), endTimeUnixNano: isoToNano(lastTs),
    attributes: rootAttrs, status: sessionStatus,
    ...(rootEvents.length > 0 ? { events: rootEvents } : {}),
  };

  return {
    resourceSpans: [{
      resource: { attributes: [
        strAttr('service.name', GEN_AI_SYSTEM),
        strAttr('service.version', SCOPE_VERSION),
      ]},
      scopeSpans: [{
        scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
        spans: [rootSpan, ...subagentSpans, ...toolSpans],
      }],
    }],
  };
}
