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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { handleCommandError } from '../errors/index.js';
import { buildTraceResults, DEFAULT_RESULT_LINES } from './trace-results.js';
import { formatTrace } from './trace-summary-render.js';
import { getTraceDir, getWitnessRoot } from '../../paths.js';
import { readLedger } from '../../agent/session-ledger.js';
import type { TraceEvent } from '../../agent/trace/index.js';
import {
  listTraces,
  resolveLatestSession,
} from '../../agent/trace/listing.js';
import { parseJsonlLines } from '../../utils/jsonl.js';

// Re-export for consumers that imported these from this module before the
// refactor. Maintains backward compatibility with existing CLI code paths.
export type { TraceDirEntry } from '../../agent/trace/listing.js';
export { listTraces, resolveLatestSession };
export type { FormatTraceOptions } from './trace-summary-render.js';
export { formatTrace } from './trace-summary-render.js';

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
  let malformed = 0;
  // Use parseJsonlLines for the shared parse+trim+skip-empty contract.
  // `looksLikeEvent` is NOT passed as `guard`: a guard silently drops non-event
  // values, hiding them from `malformed`. Two-pass is intentional — both JSON
  // failures (onParseError) and structural mismatches (below) must be counted.
  const raw = parseJsonlLines(content, { onParseError: () => { malformed++; } });
  const events: TraceEvent[] = [];
  for (const parsed of raw) {
    if (looksLikeEvent(parsed)) {
      events.push(parsed);
    } else {
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
// Command registration
// ---------------------------------------------------------------------------

/** `--results-lines` value: a non-negative integer, else the default. */
function parseResultLines(raw: string | undefined): number {
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? DEFAULT_RESULT_LINES : n;
}

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
    .option('--results', 'Print each tool call\'s full result (from the message journal) under its row', false)
    .option('--results-lines <number>', `Max lines per result with --results (0 = no limit, default ${DEFAULT_RESULT_LINES})`)
    .action(
      async (
        session: string | undefined,
        options: { all: boolean; json: boolean; limit?: string; results: boolean; resultsLines?: string },
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
          const results = options.results
            ? buildTraceResults(loaded.sessionId, loaded.events, parseResultLines(options.resultsLines))
            : undefined;
          process.stdout.write(
            formatTrace(loaded.sessionId, loaded.tracePath, loaded, {
              showAll: options.all,
              ...(limit !== undefined ? { limit } : {}),
              ...(results !== undefined ? { resultFor: results.resultFor, resultsNote: results.note } : {}),
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
