/**
 * CLI subcommands for inspecting the witness-layer trace of a session.
 *
 * The runtime writes an append-only NDJSON record of everything an agent
 * did to `~/.afk/state/witness/<session>/trace.jsonl` (see
 * `src/agent/trace/`). That record is the durable evidence of unattended
 * (AFK) work — but until now it had no human-facing reader: inspecting it
 * meant `cat … | jq`. This command surfaces it.
 *
 * Subcommands:
 *   afk trace show [session]   — pretty-print a session's trace for humans
 *                                (session defaults to `latest`)
 *   afk trace list             — list known traces, most recent first
 *
 * The special selector `latest` resolves to the most recently written
 * trace under the witness root, so `afk trace show` with no argument shows
 * the run you most likely just finished.
 *
 * This command is read-only: it never writes to or mutates the witness
 * layer. It tolerates a partially-written (live or crashed) trace —
 * malformed trailing lines are counted and skipped, never fatal.
 *
 * @module cli/commands/trace
 */

import { Command } from 'commander';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { handleCommandError } from '../errors/index.js';
import { getAfkStateDir, getTraceDir } from '../../paths.js';
import { readLedger } from '../../agent/session-ledger.js';
import type { TraceEvent } from '../../agent/trace/index.js';

// ---------------------------------------------------------------------------
// Witness-layer discovery
// ---------------------------------------------------------------------------

/** Absolute path to the witness root that holds per-session trace dirs. */
function getWitnessRoot(): string {
  return join(getAfkStateDir(), 'witness');
}

/** One discovered trace, with the mtime used to order "most recent first". */
export interface TraceDirEntry {
  sessionId: string;
  tracePath: string;
  /** Epoch ms of the trace.jsonl mtime; 0 when the file is absent. */
  mtimeMs: number;
  exists: boolean;
}

/**
 * Scan the witness root for sessions that have a `trace.jsonl`, newest
 * first. Returns an empty array when the witness root does not exist yet
 * (no session has ever emitted a trace).
 */
export async function listTraces(): Promise<TraceDirEntry[]> {
  const root = getWitnessRoot();
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const entries: TraceDirEntry[] = [];
  for (const sessionId of names) {
    const tracePath = join(root, sessionId, 'trace.jsonl');
    try {
      const st = await stat(tracePath);
      if (st.isFile()) {
        entries.push({ sessionId, tracePath, mtimeMs: st.mtimeMs, exists: true });
      }
    } catch {
      // Not a session dir, or no trace.jsonl inside — skip silently.
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

/** Resolve `latest` to the newest session id, or `null` when none exist. */
export async function resolveLatestSession(): Promise<string | null> {
  const traces = await listTraces();
  return traces[0]?.sessionId ?? null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Result of parsing a trace.jsonl file. */
export interface ParsedTrace {
  events: TraceEvent[];
  /** Count of non-empty lines that failed to parse (e.g. a partial tail
   *  line in a still-being-written trace). */
  malformed: number;
}

/** Minimal structural guard — a real event has a string `kind`, a numeric
 *  `seq`, and an object `payload`. Kept lenient on purpose so a forward-
 *  compatible trace (a `kind` this build doesn't know) still renders. */
function looksLikeEvent(v: unknown): v is TraceEvent {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['kind'] === 'string' &&
    typeof o['seq'] === 'number' &&
    typeof o['payload'] === 'object' &&
    o['payload'] !== null
  );
}

/** Parse NDJSON trace content into events, tolerating malformed lines. */
export function parseTrace(content: string): ParsedTrace {
  const events: TraceEvent[] = [];
  let malformed = 0;
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (looksLikeEvent(parsed)) {
        events.push(parsed);
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

/**
 * Resolve a session selector to a concrete trace and parse it.
 *
 * `session` may be a concrete session id or the literal `latest`. Throws a
 * human-readable error when the selector resolves to no on-disk trace.
 */
export async function loadTrace(
  session: string,
): Promise<{ sessionId: string; tracePath: string } & ParsedTrace> {
  let sessionId = session;
  if (session === 'latest') {
    const latest = await resolveLatestSession();
    if (latest === null) {
      throw new Error(
        `No traces found under ${getWitnessRoot()}. Run an agent session first, ` +
          `or pass an explicit session id (see \`afk trace list\`).`,
      );
    }
    sessionId = latest;
  }

  // getTraceDir validates the id shape and throws on an unsafe value.
  let tracePath = join(getTraceDir(sessionId), 'trace.jsonl');
  let content = await readTraceFile(tracePath);

  // Fresh sessions label the witness dir with a random UUID, not the session id
  // (only resumed sessions reuse the id) — so a direct <witness>/<id>/ lookup
  // misses them. The session ledger's `meta` record carries the real label;
  // consult it before giving up.
  if (content === null) {
    const resolved = await traceLabelFromLedger(sessionId);
    if (resolved.kind === 'disabled') {
      throw new Error(
        `Session "${sessionId}" ran with tracing disabled — its ledger records ` +
          `traceLabel: null, so no witness trace was written ` +
          `(tracing is off when AFK_TRACE_DISABLED=1).`,
      );
    }
    if (resolved.kind === 'label' && resolved.label !== sessionId) {
      try {
        const relabeled = join(getTraceDir(resolved.label), 'trace.jsonl');
        const viaLedger = await readTraceFile(relabeled);
        if (viaLedger !== null) {
          tracePath = relabeled;
          content = viaLedger;
        }
      } catch {
        // Unsafe/garbage label in the ledger — fall through to the not-found error.
      }
    }
  }

  if (content === null) {
    throw new Error(
      `No trace found for session "${sessionId}" at ${tracePath}. ` +
        `See \`afk trace list\` for available sessions.`,
    );
  }

  return { sessionId, tracePath, ...parseTrace(content) };
}

/** Read a `trace.jsonl`, returning `null` on ENOENT (other errors rethrow). */
async function readTraceFile(tracePath: string): Promise<string | null> {
  try {
    return await readFile(tracePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Recover a session's witness label from its ledger `meta` record.
 *   - `{ kind: 'label', label }` — meta recorded a non-empty `traceLabel`.
 *   - `{ kind: 'disabled' }`     — meta recorded `traceLabel: null` (tracing off).
 *   - `{ kind: 'none' }`         — no ledger, no meta, or a pre-field ledger.
 */
async function traceLabelFromLedger(
  sessionId: string,
): Promise<{ kind: 'label'; label: string } | { kind: 'disabled' } | { kind: 'none' }> {
  try {
    for await (const rec of readLedger(sessionId)) {
      if (rec.kind !== 'meta') continue;
      if (typeof rec.traceLabel === 'string' && rec.traceLabel.length > 0) {
        return { kind: 'label', label: rec.traceLabel };
      }
      if (rec.traceLabel === null) return { kind: 'disabled' };
      return { kind: 'none' }; // meta present but written before the field existed
    }
  } catch {
    // Ledger unreadable — treat as no signal and fall back to the direct lookup.
  }
  return { kind: 'none' };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** UTC HH:MM:SS slice of an ISO-8601 timestamp; deterministic across
 *  timezones (good for stable output and tests). */
function fmtTime(ts: string): string {
  return ts.length >= 19 ? ts.slice(11, 19) : ts;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Fixed label column so event lines align. */
function label(s: string): string {
  const WIDTH = 9;
  return s.length >= WIDTH ? s : s + ' '.repeat(WIDTH - s.length);
}

// ---------------------------------------------------------------------------
// Per-event rendering
// ---------------------------------------------------------------------------

interface RenderContext {
  /** toolUseIds that have a `completed` record — used to detect orphaned
   *  `started` events (a tool that began but never returned). */
  completedToolIds: Set<string>;
  /** Include low-signal events (session_phase) and paired tool `started`
   *  lines that have a matching completion. */
  showAll: boolean;
}

/**
 * Render one event to a human line, or `null` when the event is filtered
 * out of the default view. The detail text per kind is deliberately terse
 * — this is a "what happened" scan, not a full dump (use `--json` for that).
 */
function renderEvent(event: TraceEvent, ctx: RenderContext): string | null {
  const time = fmtTime(event.ts);
  const line = (kind: string, detail: string): string =>
    `  ${time}  ${label(kind)}  ${detail}`;

  switch (event.kind) {
    case 'tool_call': {
      const p = event.payload;
      if (p.phase === 'started') {
        // An orphaned `started` (no matching `completed`) means the call
        // never returned — a crash or abort mid-tool. Surface only orphans
        // by default; with --all, show every started line too.
        const orphan = !ctx.completedToolIds.has(p.toolUseId);
        if (!ctx.showAll && !orphan) return null;
        const sub = p.subagentId ? `  [${p.subagentId}]` : '';
        const note = orphan ? 'started (no completion recorded)' : 'started';
        return line('tool', `${p.name}  ${note}${sub}`);
      }
      const status = p.isError ? 'ERR' : 'ok';
      const trunc = p.truncated ? '  (truncated)' : '';
      const sub = p.subagentId ? `  [${p.subagentId}]` : '';
      return line(
        'tool',
        `${p.name}  ${status}  ${fmtDuration(p.durationMs)}  ${fmtBytes(p.resultBytes)}${trunc}${sub}`,
      );
    }

    case 'hook_decision': {
      const p = event.payload;
      if (p.decision === undefined) return null; // all handlers passed — noise
      if (p.decision === 'block') {
        const tool = p.blockedTool ? ` ${p.blockedTool}` : '';
        const reason = p.reason ? `  (${truncate(p.reason, 80)})` : '';
        return line('hook', `BLOCK ${p.hookEvent}${tool}${reason}`);
      }
      const reason = p.reason ? `  (${truncate(p.reason, 80)})` : '';
      return line('hook', `approve ${p.hookEvent}${reason}`);
    }

    case 'subagent_lifecycle': {
      const p = event.payload;
      switch (p.transition) {
        case 'started':
          return line('subagent', `started  ${p.model}  [${p.subagentId}]`);
        case 'succeeded': {
          const cost = p.totalCostUsd !== undefined ? `  ${fmtUsd(p.totalCostUsd)}` : '';
          return line(
            'subagent',
            `succeeded  ${fmtDuration(p.durationMs)}  ${p.turnCount} turns  ${fmtBytes(p.outputBytes)}${cost}  [${p.subagentId}]`,
          );
        }
        case 'failed': {
          // `[timeout]` marks a child killed by its own wall-clock budget
          // (failureClass:'timeout') vs an ordinary error — see the subagent
          // lifecycle failed payload.
          const to = p.failureClass === 'timeout' ? '  [timeout]' : '';
          return line(
            'subagent',
            `FAILED  ${p.errorClass}: ${truncate(p.errorMessage, 80)}${to}  [${p.subagentId}]`,
          );
        }
        case 'cancelled': {
          // `(timeout)` marks a cascade that originated from an ancestor's
          // wall-clock budget expiry vs an ordinary parent/explicit cancel.
          const to = p.timeout ? ' (timeout)' : '';
          return line('subagent', `cancelled (${p.source})${to}  [${p.subagentId}]`);
        }
      }
      return null;
    }

    case 'background_agent': {
      const p = event.payload;
      switch (p.transition) {
        case 'started':
          return line('bg-agent', `started  ${p.model}  ${truncate(p.label, 60)}  [${p.jobId}]`);
        case 'completed':
          return line(
            'bg-agent',
            `completed  ${fmtDuration(p.durationMs)}  ${fmtBytes(p.outputBytes)}  [${p.jobId}]`,
          );
        case 'failed':
          return line(
            'bg-agent',
            `FAILED  ${p.errorClass}: ${truncate(p.errorMessage, 80)}  [${p.jobId}]`,
          );
        case 'cancelled':
          return line('bg-agent', `cancelled (${p.source})  [${p.jobId}]`);
        case 'joined':
          return line('bg-agent', `joined  ${p.jobStatus}  [${p.jobId}]`);
        case 'delivered':
          return line('bg-agent', `delivered  ${p.jobStatus}  [${p.jobId}]`);
      }
      return null;
    }

    case 'abort': {
      const p = event.payload;
      const reason = p.reason ? `  ${truncate(p.reason, 80)}` : '';
      const cascade = p.cascadedTo.length > 0 ? `  cascaded→${p.cascadedTo.length}` : '';
      return line('abort', `${p.origin}${reason}${cascade}`);
    }

    case 'compaction': {
      const p = event.payload;
      const saved =
        p.tokensSavedEstimate !== undefined ? `  ~${p.tokensSavedEstimate} tok saved` : '';
      return line('compact', `${p.trigger}  ${p.messagesBefore}→${p.messagesAfter} msgs${saved}`);
    }

    case 'closure': {
      const p = event.payload;
      const guidance = p.guidance ? `  — ${truncate(p.guidance, 100)}` : '';
      // Surface the raw provider stop_reason (e.g. `refusal`, `max_tokens`)
      // alongside the AFK-classified closure reason. It is already persisted
      // on the closure event but was previously unrendered — leaving silent
      // stops (a turn that ends with no output and no error) diagnosable only
      // by reading the raw trace.jsonl. See docs: silent-model-loop debugging.
      const stop = p.lastStopReason ? `  stop=${p.lastStopReason}` : '';
      return line(
        'closure',
        `${p.reason}  turns=${p.finalTurnCount}${stop}  ${fmtUsd(p.finalCostUsd)}${guidance}`,
      );
    }

    case 'claim': {
      const p = event.payload;
      return line(
        'claim',
        `[${p.source}] "${truncate(p.assertion, 80)}"  conf=${p.confidence}  ${p.evidence.length} evidence`,
      );
    }

    case 'browser_event': {
      const p = event.payload;
      const action = p.action ? ` ${p.action}` : '';
      const url = p.urlAfter ? `  ${p.urlAfter}` : '';
      return line('browser', `${p.tool}${action}  ${p.status}${url}`);
    }

    case 'budget': {
      const p = event.payload;
      return line('budget', `${p.kind}  ${fmtUsd(p.runningCostUsd)}/${fmtUsd(p.maxBudgetUsd)}`);
    }

    case 'session_phase': {
      const p = event.payload;
      // `rate_limit` is HIGH-signal: it explains an otherwise-invisible stall
      // (the SDK's silent 429/503/529 retry-after backoff surfaces only as an
      // abnormally long model_ttfb). Render it in the DEFAULT view — unlike the
      // other phases, which are low-signal latency-waterfall markers shown only
      // with --all. Placed before the showAll gate below on purpose.
      if (p.phase === 'rate_limit') {
        const md = p.metadata ?? {};
        const reason = md['reason'];
        const status = md['status'];
        const source = md['source'];
        const wait =
          p.durationMs !== undefined ? `  retry-after ${fmtDuration(p.durationMs)}` : '';
        const statusBit = status !== undefined ? `  ${status}` : '';
        const srcBit = source !== undefined ? `  (${source})` : '';
        const head = reason !== undefined ? String(reason) : 'throttled';
        return line('throttle', `${head}${statusBit}${wait}${srcBit}`);
      }
      // Usage-limit park/unpark is the highest-signal stall of all — a
      // multi-hour subscription pause, not a per-minute backoff. Render in the
      // DEFAULT view (before the showAll gate) so the trace explains the gap.
      if (p.phase === 'usage_limit_pause') {
        const md = p.metadata ?? {};
        const resetsAt = md['resetsAt'];
        const resetBit = resetsAt !== undefined ? `  resets ${resetsAt}` : '  no reset ts';
        return line('paused', `usage-limit${resetBit}`);
      }
      if (p.phase === 'usage_limit_resume') {
        const md = p.metadata ?? {};
        const parked = p.durationMs !== undefined ? `  parked ${fmtDuration(p.durationMs)}` : '';
        const hotSwap = md['hotSwapped'] === true ? '  (hot-swap)' : '';
        return line('resumed', `usage-limit${parked}${hotSwap}`);
      }
      if (!ctx.showAll) return null; // latency waterfall — low signal by default
      const dur = p.durationMs !== undefined ? `  ${fmtDuration(p.durationMs)}` : '';
      // Prefer the operator alias (session_init_start); fall back to the
      // resolved wire id (model_ttfb carries only that).
      const modelStr = p.model ?? p.resolvedModel;
      const modelBit = modelStr !== undefined ? `  ${modelStr}` : '';
      return line('phase', `${p.phase}${dur}${modelBit}`);
    }

    case 'session_sealed': {
      const p = event.payload;
      const subs = p.subagentCount ? `  ${p.subagentCount} subagents` : '';
      return line(
        'SEALED',
        `${p.status}  turns=${p.finalTurnCount}  ${fmtUsd(p.finalCostUsd)}${subs}  (closed ${p.closedAt})`,
      );
    }

    default: {
      // Forward-compatible: render an unknown future kind rather than drop it.
      const k = (event as { kind: string }).kind;
      return line(k, '(unrecognized event kind)');
    }
  }
}

// ---------------------------------------------------------------------------
// Summary header
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
      ` · ${summary.blocks} blocks${throttlePart}${costPart}`,
  );
  out.push('');

  let rendered: string[] = [];
  for (const e of events) {
    const r = renderEvent(e, ctx);
    if (r !== null) rendered.push(r);
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

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerTraceCommand(program: Command): void {
  const trace = program
    .command('trace')
    .description(
      'Inspect the witness-layer trace of a session — the durable record of\n' +
        'everything the agent did. Reads ~/.afk/state/witness/<session>/trace.jsonl.',
    );

  // afk trace show [session]
  trace
    .command('show [session]')
    .description(
      'Pretty-print a session\'s trace for humans. [session] is a session id\n' +
        'or "latest" (the default) — the most recently written trace.',
    )
    .option('--all', 'Include low-signal events (latency phases, paired tool starts)', false)
    .option('--json', 'Emit the raw NDJSON record unchanged (for piping to jq)', false)
    .option('-n, --limit <number>', 'Show only the last N events')
    .action(
      async (
        session: string | undefined,
        options: { all: boolean; json: boolean; limit?: string },
      ) => {
        try {
          const selector = session ?? 'latest';

          if (options.json) {
            const { tracePath } = await loadTrace(selector);
            const raw = await readFile(tracePath, 'utf8');
            process.stdout.write(raw.endsWith('\n') ? raw : raw + '\n');
            return;
          }

          const loaded = await loadTrace(selector);
          let limit: number | undefined;
          if (options.limit !== undefined) {
            const n = parseInt(options.limit, 10);
            if (!Number.isNaN(n) && n >= 0) limit = n;
          }
          process.stdout.write(
            formatTrace(loaded.sessionId, loaded.tracePath, loaded, {
              showAll: options.all,
              ...(limit !== undefined ? { limit } : {}),
            }),
          );
        } catch (err) {
          handleCommandError(err);
        }
      },
    );

  // afk trace list
  trace
    .command('list')
    .description('List sessions that have a trace, most recent first')
    .option('-n, --max <number>', 'Maximum sessions to show', '20')
    .action(async (options: { max: string }) => {
      try {
        const maxRows = Math.min(200, Math.max(1, parseInt(options.max, 10) || 20));
        const traces = await listTraces();
        if (traces.length === 0) {
          process.stdout.write(`No traces found under ${getWitnessRoot()}\n`);
          return;
        }
        for (const t of traces.slice(0, maxRows)) {
          const when = new Date(t.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
          process.stdout.write(`${when}  ${t.sessionId}\n`);
        }
      } catch (err) {
        handleCommandError(err);
      }
    });
}
