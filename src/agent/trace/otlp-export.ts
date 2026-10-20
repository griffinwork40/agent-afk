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
 * Background agent jobs also get `agent.invoke` spans (indexed from
 * `background_agent` events). Tool calls get leaf spans (`tool.invoke`). Events
 * that cannot be attributed to a specific actor attach as span events on the
 * session root.
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
 * ## Security / privacy note
 *
 * `afk.tool.error_head` is **omitted by default** because OTLP output may be
 * forwarded to remote collectors and error text can contain secrets or PII.
 * Pass `includeErrorDetails: true` in {@link TraceToOtlpOptions} to re-enable
 * it for local/trusted pipelines only.
 *
 * @module agent/trace/otlp-export
 */

import type { TraceEvent } from './types.js';
import {
  strAttr, intAttr, doubleAttr,
  SCOPE_NAME, SCOPE_VERSION, GEN_AI_SYSTEM,
  isoToNano, sessionToTraceId, seedSpanId,
  indexSubagents, indexToolPairs,
  buildSubagentSpans, buildToolSpans, buildRootSpanEvents,
} from './otlp-export.builders.js';

// ---------------------------------------------------------------------------
// OTLP JSON types (minimal subset for ExportTraceServiceRequest)
// ---------------------------------------------------------------------------

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean }
  | { doubleValue: number };

/** @internal Subsystem-private OTLP wire type; do not import outside `src/agent/trace/`. */
export interface KeyValue { key: string; value: AnyValue }

/**
 * Minimal OTLP span event (attached to a span).
 * @internal Subsystem-private OTLP wire type; do not import outside `src/agent/trace/`.
 */
export interface SpanEvent {
  timeUnixNano: string;
  name: string;
  attributes?: KeyValue[];
}

/**
 * OTLP span status.
 * @internal Subsystem-private OTLP wire type; do not import outside `src/agent/trace/`.
 */
export interface SpanStatus { code: 0 | 1 | 2; message?: string }

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
// Public API
// ---------------------------------------------------------------------------

/** Options for {@link traceToOtlp}. */
export interface TraceToOtlpOptions {
  /** Session id — used to derive the traceId and as the root span attribute. */
  sessionId: string;
  /** Count of malformed lines from the parse pass (surfaced as an attribute). */
  malformed?: number;
  /**
   * When true, include `afk.tool.error_head` in tool spans.
   *
   * Off by default: `redactSecrets` is best-effort and OTLP output may be
   * forwarded to remote collectors where error text could expose secrets or PII.
   * Enable only for local / trusted-pipeline use.
   */
  includeErrorDetails?: boolean;
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
  const { sessionId, malformed = 0, includeErrorDetails = false } = opts;
  const traceId = sessionToTraceId(sessionId);

  // Derive session wall-clock bounds and sealed metadata.
  const firstTs = events.length > 0 ? events[0]!.ts : new Date().toISOString();
  let lastTs = firstTs;
  // Fix #4106 item 1: start UNSET (code 0); promote to OK only on
  // session_sealed with status === 'succeeded'. Unsealed / SIGKILL'd traces
  // remain UNSET rather than being falsely reported as successful.
  let sessionStatus: SpanStatus = { code: 0 };
  let sealedSeen = false;
  let finalCost: number | undefined;
  let finalTurns: number | undefined;
  let finalTokens: { input?: number; output?: number } | undefined;

  for (const ev of events) {
    if (ev.ts > lastTs) lastTs = ev.ts;
    if (ev.kind === 'session_sealed') {
      lastTs = ev.ts;
      sealedSeen = true;
      if (ev.payload.status === 'succeeded') {
        sessionStatus = { code: 1 };
      } else {
        sessionStatus = { code: 2, message: `session ${ev.payload.status}` };
      }
      finalCost = ev.payload.finalCostUsd;
      finalTurns = ev.payload.finalTurnCount;
      finalTokens = ev.payload.subagentTokens;
    }
  }
  void sealedSeen; // informational; status already captures the distinction

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
  const toolSpans = buildToolSpans(
    indexToolPairs(events), traceId, rootSpanId, subagentSpanIds, { includeErrorDetails },
  );
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
