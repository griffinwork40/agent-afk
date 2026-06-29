/**
 * Read-only run-receipt generator — the first slice of the verification
 * lifecycle surface.
 *
 * After a session's witness trace is sealed (see the SessionEnd ordering in
 * `src/agent/session/agent-session.ts` — closure → seal → SessionEnd hook),
 * this module reads the sealed `trace.jsonl` and emits a human- and
 * machine-readable summary of what happened: tool-call and failure counts,
 * terminal status, cost, notable failure metadata, and an explicit
 * human-review verdict with reasons.
 *
 * Invariant: strictly READ-ONLY. This never injects context into a running
 * model, never mutates session control flow, and runs only AFTER the trace is
 * sealed. A receipt-write failure is swallowed and must never break teardown.
 *
 * Provenance honesty: the trace records tool-call METADATA (name, isError,
 * failureClass, durationMs, timestamps) — NOT raw tool output. The receipt
 * therefore summarizes metadata and points to the trace as evidence; it never
 * fabricates output it does not have. This is stated in `limitations`.
 *
 * @module agent/trace/receipt
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { getReceiptsDir } from '../../paths.js';
import { env } from '../../config/env.js';
import type { HookHandler } from '../hooks.js';
import type {
  ClosureReason,
  ToolFailureClass,
  TraceEvent,
  TraceEventKind,
} from './types.js';

export const RECEIPT_SCHEMA_VERSION = 1 as const;

// Invariant: mirrors the "system correctly said no" set documented on
// {@link ToolFailureClass} in `./types.ts` and applied by the
// `tool-failure-density` detector. These failure classes are EXPECTED
// outcomes (a gate / policy / human correctly refused), so they are counted
// but do NOT trip the human-review flag on their own. Note `'timeout'` and
// unclassified failures are deliberately NOT exempt — they still warrant review.
const REVIEW_EXEMPT_FAILURE_CLASSES: ReadonlySet<ToolFailureClass> = new Set([
  'policy-refusal',
  'permission-denied',
  'hook-block',
  'abort',
  'elicitation-declined',
]);

// Invariant: the subset of exempt classes that represent a GATE refusing a
// tool call — an allowlist/`canUseTool` deny (`permission-denied`), a
// PreToolUse hook block (`hook-block`), or a policy refusal (`policy-refusal`).
// These are "the system denylisted this call". Deliberately EXCLUDES `abort`
// (user/cascade cancellation) and `elicitation-declined` (no handler) — those
// are not denials. Surfaced as the receipt's `toolCalls.refused` tally so
// restrictive sub-agent/skill allowlists (e.g. /diagnose, /audit-fit) get a
// per-session count instead of being buried in `byFailureClass`.
const GATE_REFUSAL_FAILURE_CLASSES: readonly ToolFailureClass[] = [
  'permission-denied',
  'hook-block',
  'policy-refusal',
];

/** A single failed tool call, summarized from trace metadata (no raw output). */
export interface ReceiptToolFailure {
  toolUseId: string;
  name: string;
  failureClass?: ToolFailureClass;
  durationMs: number;
  ts: string;
  truncated: boolean;
  /** True when `failureClass` is an expected refusal ("system correctly said no"). */
  exempt: boolean;
  subagentId?: string;
}

/** The machine-readable run receipt. Written to `<receipts>/<label>.json`. */
export interface RunReceipt {
  schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  generatedAt: string;
  /** Witness-trace directory name — the stable correlation key for this run. */
  witnessLabel: string;
  /** Absolute path to the sealed `trace.jsonl` this receipt summarizes. */
  tracePath: string;
  /** Logical session id, when the session exposed one (may be absent). */
  sessionId?: string;
  /** SessionEnd reason that triggered this receipt ('close' | 'reset' | 'error'). */
  endReason?: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  closureReason?: ClosureReason;
  lastStopReason?: string;
  guidance?: string;
  /** True when the trace was sealed by the synchronous process-exit backstop. */
  incomplete: boolean;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  toolCalls: {
    total: number;
    succeeded: number;
    errored: number;
    /** `errored` minus the expected-refusal (exempt) classes. */
    erroredNotable: number;
    /**
     * Count of tool calls a gate denylisted: `permission-denied` (allowlist /
     * `canUseTool` deny) + `hook-block` (PreToolUse hook) + `policy-refusal`.
     * A subset of `errored`; per-class detail is in `byFailureClass`. Divide by
     * `total` for the refusal rate. Surfaces denials that `erroredNotable`
     * deliberately excludes — the per-session "how often was a call denied" tally.
     */
    refused: number;
    circuitBreakerHits: number;
    byTool: Record<string, { total: number; errored: number }>;
    byFailureClass: Record<string, number>;
  };
  events: {
    total: number;
    byKind: Partial<Record<TraceEventKind, number>>;
  };
  subagents: {
    started: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  };
  cost: {
    finalCostUsd?: number;
    turnCount?: number;
    tokens?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheCreation?: number;
    };
  };
  failures: ReceiptToolFailure[];
  humanReviewRequired: boolean;
  humanReviewReasons: string[];
  limitations: string[];
}

/** Inputs to {@link generateReceipt} that are not derivable from the events. */
export interface ReceiptMeta {
  tracePath: string;
  witnessLabel: string;
  sessionId?: string;
  endReason?: string;
  /** Override "now" for deterministic tests. */
  now?: Date;
}

/**
 * Parse NDJSON trace content into events, tolerantly: blank lines and lines
 * that fail to parse (e.g. a half-written final line after a crash) are
 * skipped rather than thrown, so a partially-corrupt trace still yields a
 * receipt from the events that ARE intact.
 */
export function parseTraceJsonl(raw: string): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isTraceEvent(parsed)) out.push(parsed);
    } catch {
      // Skip malformed line — tolerance is the point.
    }
  }
  return out;
}

function isTraceEvent(v: unknown): v is TraceEvent {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['kind'] === 'string' && typeof o['ts'] === 'string' && 'payload' in o;
}

/**
 * Derive the receipt file paths from a trace path. The witness dir is
 * `<state>/witness/<label>/trace.jsonl`; the parent-dir name is the trace's
 * session label, which we reuse as the receipt key so a receipt sits 1:1 with
 * the trace it summarizes.
 */
export function receiptPathsFor(tracePath: string): {
  label: string;
  jsonPath: string;
  mdPath: string;
} {
  const label = basename(dirname(tracePath));
  const dir = getReceiptsDir();
  return {
    label,
    jsonPath: join(dir, `${label}.json`),
    mdPath: join(dir, `${label}.md`),
  };
}

/** Build a {@link RunReceipt} from parsed trace events. Pure — no I/O. */
export function generateReceipt(events: TraceEvent[], meta: ReceiptMeta): RunReceipt {
  const byKind: Partial<Record<TraceEventKind, number>> = {};
  const byTool: Record<string, { total: number; errored: number }> = {};
  const byFailureClass: Record<string, number> = {};
  const failures: ReceiptToolFailure[] = [];

  let total = 0;
  let succeeded = 0;
  let errored = 0;
  let circuitBreakerHits = 0;
  const subagents = { started: 0, succeeded: 0, failed: 0, cancelled: 0 };

  let closureReason: ClosureReason | undefined;
  let lastStopReason: string | undefined;
  let guidance: string | undefined;
  let closureTokens: RunReceipt['cost']['tokens'];
  let closureCostUsd: number | undefined;
  let closureTurnCount: number | undefined;

  let sealedStatus: 'succeeded' | 'failed' | 'cancelled' | undefined;
  let sealedCostUsd: number | undefined;
  let sealedTurnCount: number | undefined;
  let sealedClosedAt: string | undefined;
  let incomplete = false;

  for (const ev of events) {
    byKind[ev.kind] = (byKind[ev.kind] ?? 0) + 1;
    switch (ev.kind) {
      case 'tool_call': {
        const p = ev.payload;
        if (p.phase !== 'completed') break;
        // Synthetic circuit-breaker completions are not real dispatches; the
        // failure-density detector excludes them, so we count them separately.
        if (p.circuitBreaker === true) {
          circuitBreakerHits++;
          break;
        }
        total++;
        const bucket = byTool[p.name] ?? { total: 0, errored: 0 };
        bucket.total++;
        if (p.isError === true) {
          errored++;
          bucket.errored++;
          const cls = p.failureClass;
          const key = cls ?? 'unclassified';
          byFailureClass[key] = (byFailureClass[key] ?? 0) + 1;
          failures.push({
            toolUseId: p.toolUseId,
            name: p.name,
            ...(cls !== undefined ? { failureClass: cls } : {}),
            durationMs: p.durationMs,
            ts: ev.ts,
            truncated: p.truncated === true,
            exempt: cls !== undefined && REVIEW_EXEMPT_FAILURE_CLASSES.has(cls),
            ...(p.subagentId !== undefined ? { subagentId: p.subagentId } : {}),
          });
        } else {
          succeeded++;
        }
        byTool[p.name] = bucket;
        break;
      }
      case 'subagent_lifecycle': {
        const t = ev.payload.transition;
        if (t === 'started') subagents.started++;
        else if (t === 'succeeded') subagents.succeeded++;
        else if (t === 'failed') subagents.failed++;
        else if (t === 'cancelled') subagents.cancelled++;
        break;
      }
      case 'closure': {
        const p = ev.payload;
        closureReason = p.reason;
        lastStopReason = p.lastStopReason;
        guidance = p.guidance;
        closureCostUsd = p.finalCostUsd;
        closureTurnCount = p.finalTurnCount;
        if (p.finalTokens !== undefined) closureTokens = p.finalTokens;
        break;
      }
      case 'session_sealed': {
        const p = ev.payload;
        sealedStatus = p.status;
        sealedCostUsd = p.finalCostUsd;
        sealedTurnCount = p.finalTurnCount;
        sealedClosedAt = p.closedAt;
        if (p.incomplete === true) incomplete = true;
        break;
      }
      default:
        break;
    }
  }

  const erroredNotable = failures.filter((f) => !f.exempt).length;
  const refused = GATE_REFUSAL_FAILURE_CLASSES.reduce(
    (n, cls) => n + (byFailureClass[cls] ?? 0),
    0,
  );
  const status = sealedStatus ?? 'unknown';

  const startedAt = events[0]?.ts;
  const endedAt = sealedClosedAt ?? (events.length > 0 ? events[events.length - 1]?.ts : undefined);
  let durationMs: number | undefined;
  if (startedAt !== undefined && endedAt !== undefined) {
    const d = Date.parse(endedAt) - Date.parse(startedAt);
    if (Number.isFinite(d) && d >= 0) durationMs = d;
  }

  const finalCostUsd = sealedCostUsd ?? closureCostUsd;
  const turnCount = sealedTurnCount ?? closureTurnCount;

  const reasons: string[] = [];
  if (status === 'failed') reasons.push('Session sealed with status "failed".');
  else if (status === 'cancelled') reasons.push('Session was cancelled.');
  else if (status === 'unknown')
    reasons.push(
      'No terminal session_sealed record found — the trace may be truncated or was read before the session sealed.',
    );
  if (incomplete)
    reasons.push(
      'Trace was sealed by the process-exit backstop, indicating an abnormal exit (crash, early EOF, or process.exit()).',
    );
  if (closureReason !== undefined && closureReason !== 'model_end_turn')
    reasons.push(`Closure reason "${closureReason}" is not a clean completion.`);
  if (erroredNotable > 0)
    reasons.push(
      `${erroredNotable} tool call(s) returned an error (excluding expected policy/permission refusals).`,
    );
  if (circuitBreakerHits > 0)
    reasons.push(`Repeat-loop circuit breaker fired ${circuitBreakerHits} time(s).`);
  if (subagents.failed > 0) reasons.push(`${subagents.failed} subagent(s) failed.`);

  const limitations = [
    'Sourced from witness-trace metadata only: raw tool output (stdout/stderr, file contents, error messages) is NOT recorded in the trace and is therefore absent here.',
    'Failure entries list tool name, failure class, duration, and timestamp; inspect the trace at the path above for full per-call detail.',
  ];
  if (status === 'unknown')
    limitations.push('No session_sealed record was present when this receipt was generated.');

  const cost: RunReceipt['cost'] = {
    ...(finalCostUsd !== undefined ? { finalCostUsd } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    ...(closureTokens !== undefined ? { tokens: closureTokens } : {}),
  };

  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    generatedAt: (meta.now ?? new Date()).toISOString(),
    witnessLabel: meta.witnessLabel,
    tracePath: meta.tracePath,
    ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
    ...(meta.endReason !== undefined ? { endReason: meta.endReason } : {}),
    status,
    ...(closureReason !== undefined ? { closureReason } : {}),
    ...(lastStopReason !== undefined ? { lastStopReason } : {}),
    ...(guidance !== undefined ? { guidance } : {}),
    incomplete,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    toolCalls: {
      total,
      succeeded,
      errored,
      erroredNotable,
      refused,
      circuitBreakerHits,
      byTool,
      byFailureClass,
    },
    events: { total: events.length, byKind },
    subagents,
    cost,
    failures,
    humanReviewRequired: reasons.length > 0,
    humanReviewReasons: reasons,
    limitations,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}

/** Render a {@link RunReceipt} as human-readable Markdown. Pure — no I/O. */
export function renderReceiptMarkdown(r: RunReceipt): string {
  const lines: string[] = [];
  lines.push(`# Run receipt — ${r.witnessLabel}`);
  lines.push('');
  lines.push(
    `**Status:** ${r.status} · **Review required:** ${r.humanReviewRequired ? '⚠️ YES' : '✓ no'}`,
  );
  const metaParts: string[] = [];
  if (r.sessionId !== undefined) metaParts.push(`**Session:** ${r.sessionId}`);
  if (r.endedAt !== undefined) metaParts.push(`**Ended:** ${r.endedAt}`);
  if (r.durationMs !== undefined) metaParts.push(`**Duration:** ${formatDuration(r.durationMs)}`);
  if (metaParts.length > 0) lines.push(metaParts.join(' · '));
  lines.push(`**Trace:** \`${r.tracePath}\``);
  lines.push('');

  if (r.humanReviewRequired) {
    lines.push('## Why review is required');
    for (const reason of r.humanReviewReasons) lines.push(`- ${reason}`);
    lines.push('');
  }

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Tool calls | ${r.toolCalls.total} |`);
  lines.push(`| Errored | ${r.toolCalls.errored} (${r.toolCalls.erroredNotable} notable) |`);
  if (r.toolCalls.refused > 0) {
    const rate =
      r.toolCalls.total > 0
        ? ((r.toolCalls.refused / r.toolCalls.total) * 100).toFixed(1)
        : '0.0';
    lines.push(`| Refused (denylisted) | ${r.toolCalls.refused} (${rate}% of calls) |`);
  }
  if (r.toolCalls.circuitBreakerHits > 0)
    lines.push(`| Circuit-breaker hits | ${r.toolCalls.circuitBreakerHits} |`);
  if (r.cost.turnCount !== undefined) lines.push(`| Turns | ${r.cost.turnCount} |`);
  if (r.cost.finalCostUsd !== undefined)
    lines.push(`| Cost (USD) | ${r.cost.finalCostUsd.toFixed(4)} |`);
  if (r.subagents.started > 0)
    lines.push(
      `| Subagents | ${r.subagents.started} started · ${r.subagents.succeeded} ok · ` +
        `${r.subagents.failed} failed · ${r.subagents.cancelled} cancelled |`,
    );
  if (r.closureReason !== undefined) lines.push(`| Closure | ${r.closureReason} |`);
  lines.push('');

  const toolNames = Object.keys(r.toolCalls.byTool).sort();
  if (toolNames.length > 0) {
    lines.push('## Tool calls by name');
    lines.push('');
    lines.push('| Tool | Calls | Errored |');
    lines.push('| --- | --- | --- |');
    for (const name of toolNames) {
      const b = r.toolCalls.byTool[name];
      if (b === undefined) continue;
      lines.push(`| ${name} | ${b.total} | ${b.errored} |`);
    }
    lines.push('');
  }

  if (r.failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    lines.push('| Tool | Class | Duration | When | Exempt |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const f of r.failures) {
      lines.push(
        `| ${f.name} | ${f.failureClass ?? 'unclassified'} | ${f.durationMs}ms | ${f.ts} | ` +
          `${f.exempt ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
  } else {
    lines.push('No tool failures recorded.');
    lines.push('');
  }

  lines.push('## Limitations');
  lines.push('');
  for (const lim of r.limitations) lines.push(`- ${lim}`);
  lines.push('');
  lines.push('---');
  lines.push(
    `_Generated ${r.generatedAt} by the AFK run-receipt writer ` +
      `(read-only; no agent behavior was modified)._`,
  );
  lines.push('');
  return lines.join('\n');
}

/** Options for {@link writeRunReceipt}. */
export interface WriteRunReceiptOptions {
  /** Absolute path to the sealed trace.jsonl to summarize. */
  tracePath: string;
  sessionId?: string;
  reason?: string;
  now?: Date;
}

/**
 * Read a sealed trace, generate the receipt, and write both the JSON and
 * Markdown files under `<state>/receipts/`. Returns the written paths, or
 * `null` when there is nothing to summarize (no trace file on disk — e.g.
 * tracing disabled — or an empty trace). Never throws on a missing trace.
 */
export async function writeRunReceipt(
  opts: WriteRunReceiptOptions,
): Promise<{ label: string; jsonPath: string; mdPath: string } | null> {
  let raw: string;
  try {
    raw = await readFile(opts.tracePath, 'utf8');
  } catch {
    return null; // No trace file — receipts piggyback on the witness layer.
  }
  const events = parseTraceJsonl(raw);
  if (events.length === 0) return null;

  const paths = receiptPathsFor(opts.tracePath);
  const receipt = generateReceipt(events, {
    tracePath: opts.tracePath,
    witnessLabel: paths.label,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    ...(opts.reason !== undefined ? { endReason: opts.reason } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  await mkdir(getReceiptsDir(), { recursive: true });
  await writeFile(paths.jsonPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  await writeFile(paths.mdPath, renderReceiptMarkdown(receipt), 'utf8');
  return paths;
}

/**
 * Built-in SessionEnd hook that writes a run receipt for top-level sessions.
 *
 * Read-only and best-effort: it returns an empty decision (never blocks or
 * injects), skips forked subagents (one receipt per user-facing run), honors
 * `AFK_RUN_RECEIPT_DISABLED=1`, and swallows any write error so a receipt
 * failure can never break session teardown. It relies on `context.tracePath`
 * (threaded from the trace writer) because the witness dir is keyed by the
 * writer's session label, NOT by `sessionId`.
 */
export const runReceiptSessionEndHook: HookHandler = async (context) => {
  if (context.event !== 'SessionEnd') return {};
  if (context.parentSessionId !== undefined) return {}; // skip subagents
  if (env.AFK_RUN_RECEIPT_DISABLED === '1') return {};
  if (context.tracePath === undefined) return {};
  try {
    await writeRunReceipt({
      tracePath: context.tracePath,
      ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
      ...(context.reason !== undefined ? { reason: context.reason } : {}),
    });
  } catch {
    // Best-effort: a receipt-write failure must never break teardown.
  }
  return {};
};
