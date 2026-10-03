/**
 * Summary aggregation and full-report formatting for `afk trace show`.
 *
 * Contains the `summarize` (aggregate event counters) and `formatTrace`
 * (build the header + event lines + footer string) concerns extracted from
 * `trace.ts` to keep each module within the 350-line budget.
 *
 * @module cli/commands/trace-summary-render
 */

import { fmtUsd } from './trace-format.js';
import { renderEvent, withToolResult } from './trace-event-render.js';
import type { RenderContext } from './trace-event-render.js';
import type { TraceEvent } from '../../agent/trace/index.js';

/** Inlined to avoid a circular import with trace.ts (which re-exports ParsedTrace). */
interface ParsedTrace {
  events: TraceEvent[];
  malformed: number;
}

// ---------------------------------------------------------------------------
// Summary aggregation
// ---------------------------------------------------------------------------

interface TraceSummary {
  total: number;
  toolCalls: number;
  toolErrors: number;
  subagents: number;
  claims: number;
  blocks: number;
  /** Count of rate_limit events (429/503/529 backoff). */
  throttles: number;
  /** Count of ttfb_timeout events (our client-side watchdog re-drove a stalled request). */
  ttfbStalls: number;
  /** Count of boot_warning events (agent-registry builtin-shadow, MCP config; #754). */
  bootWarnings: number;
  sealStatus: string | null;
  finalCostUsd: number | null;
  /** Operator-typed model for the root session (from session_init_start). */
  model: string | null;
  /** Resolved wire id for the root session, when it differs from `model`. */
  resolvedModel: string | null;
}

function summarize(events: TraceEvent[]): TraceSummary {
  let toolCalls = 0;
  let toolErrors = 0;
  let subagents = 0;
  let claims = 0;
  let blocks = 0;
  let throttles = 0;
  let ttfbStalls = 0;
  let bootWarnings = 0;
  let sealStatus: string | null = null;
  let finalCostUsd: number | null = null;
  let model: string | null = null;
  let resolvedModel: string | null = null;

  for (const e of events) {
    switch (e.kind) {
      case 'tool_call':
        if (e.payload.phase === 'completed') {
          toolCalls++;
          if (e.payload.isError) toolErrors++;
        }
        break;
      case 'session_phase':
        if (e.payload.phase === 'rate_limit') throttles++;
        if (e.payload.phase === 'ttfb_timeout') ttfbStalls++;
        if (e.payload.phase === 'boot_warning') bootWarnings++;
        // Root-session model provenance lives on session_init_start (the
        // earliest, always-emitted phase). First occurrence wins.
        if (e.payload.phase === 'session_init_start') {
          if (model === null && e.payload.model !== undefined) model = e.payload.model;
          if (resolvedModel === null && e.payload.resolvedModel !== undefined) {
            resolvedModel = e.payload.resolvedModel;
          }
        }
        break;
      case 'subagent_lifecycle':
        if (e.payload.transition === 'started') subagents++;
        break;
      case 'claim':
        claims++;
        break;
      case 'hook_decision':
        if (e.payload.decision === 'block') blocks++;
        break;
      case 'session_sealed':
        sealStatus = e.payload.status;
        finalCostUsd = e.payload.finalCostUsd;
        break;
      case 'closure':
        if (finalCostUsd === null) finalCostUsd = e.payload.finalCostUsd;
        break;
      default:
        break;
    }
  }

  return {
    total: events.length,
    toolCalls,
    toolErrors,
    subagents,
    claims,
    blocks,
    throttles,
    ttfbStalls,
    bootWarnings,
    sealStatus,
    finalCostUsd,
    model,
    resolvedModel,
  };
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export interface FormatTraceOptions {
  showAll?: boolean;
  /** Show only the last N rendered events. */
  limit?: number;
  /**
   * `--results`: rendered full-result block for a completed tool call (from
   * the message journal), printed under its row. See trace-results.ts.
   */
  resultFor?: (toolUseId: string) => string | null;
  /** Header line explaining where results came from (or why there are none). */
  resultsNote?: string;
}

/**
 * Build the full human-readable report (header + event lines + footer) for
 * a parsed trace. Returned as a single string ending in a newline.
 */
export function formatTrace(
  sessionId: string,
  tracePath: string,
  parsed: ParsedTrace,
  options: FormatTraceOptions = {},
): string {
  const { events, malformed } = parsed;
  const summary = summarize(events);

  const completedToolIds = new Set<string>();
  for (const e of events) {
    if (e.kind === 'tool_call' && e.payload.phase === 'completed') {
      completedToolIds.add(e.payload.toolUseId);
    }
  }
  const ctx: RenderContext = { completedToolIds, showAll: options.showAll ?? false };

  const status =
    summary.sealStatus !== null
      ? `sealed (${summary.sealStatus})`
      : 'unsealed (live or crashed)';
  const costPart = summary.finalCostUsd !== null ? ` · ${fmtUsd(summary.finalCostUsd)}` : '';
  const throttlePart = summary.throttles > 0 ? ` · ${summary.throttles} throttled` : '';
  // Surfaced separately from `throttled`: a ttfb stall is dead wall-clock our own
  // watchdog spent, and folding it into the throttle count is what hid it.
  const ttfbPart = summary.ttfbStalls > 0 ? ` · ${summary.ttfbStalls} ttfb-stall` : '';
  // Boot warnings are already rendered as individual `boot-warn` lines (safety
  // signal, DEFAULT view — see renderEvent), but a header count lets an
  // operator confirm the total at a glance without counting lines, same as
  // `throttled` above (#754).
  const bootWarningPart =
    summary.bootWarnings > 0 ? ` · ${summary.bootWarnings} boot-warn` : '';

  const out: string[] = [];
  out.push(`Trace  ${sessionId}`);
  out.push(`File   ${tracePath}`);
  if (summary.model !== null) {
    const resolvedBit =
      summary.resolvedModel !== null && summary.resolvedModel !== summary.model
        ? ` → ${summary.resolvedModel}`
        : '';
    out.push(`Model  ${summary.model}${resolvedBit}`);
  }
  out.push(
    `       ${status} · ${summary.total} events · ${summary.toolCalls} tool calls` +
      ` (${summary.toolErrors} err) · ${summary.subagents} subagents · ${summary.claims} claims` +
      ` · ${summary.blocks} blocks${throttlePart}${ttfbPart}${bootWarningPart}${costPart}`,
  );
  if (options.resultsNote !== undefined) out.push(options.resultsNote);
  out.push('');

  let rendered: string[] = [];
  for (const e of events) {
    const r = renderEvent(e, ctx);
    if (r !== null) rendered.push(withToolResult(r, e, options.resultFor));
  }

  const hiddenByLimit =
    options.limit !== undefined && options.limit >= 0 && rendered.length > options.limit
      ? rendered.length - options.limit
      : 0;
  if (hiddenByLimit > 0) {
    rendered = rendered.slice(-(options.limit as number));
    out.push(`  … ${hiddenByLimit} earlier event(s) hidden (raise --limit to see them)`);
  }

  if (rendered.length === 0) {
    out.push('  (no events to display — try --all, or --json for the raw record)');
  } else {
    out.push(...rendered);
  }

  out.push('');
  const footerBits: string[] = [];
  if (malformed > 0) footerBits.push(`${malformed} malformed line(s) skipped`);
  if (!ctx.showAll) footerBits.push('use --all for phase/started events, --json for raw');
  if (footerBits.length > 0) out.push(footerBits.join(' · '));

  return out.join('\n') + '\n';
}


