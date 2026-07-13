/**
 * Traces aggregator — walks ~/.afk/state/witness/<sessionId>/trace.jsonl and
 * aggregates tool call counts, error rates, subagent depths, compaction
 * counts, and closure reasons.
 *
 * Privacy invariants:
 *   - `responseExcerpt`, prompt content, and user data are NEVER read or
 *     forwarded. We only parse structural metadata fields.
 *   - Line parsing uses Zod schemas from trace/events.ts. Unknown fields
 *     are ignored by the schema — they never reach output aggregates.
 *
 * Session filtering: when `options.afkHome` is provided (tests), the
 * witness root is derived from it. Otherwise uses `getAfkStateDir()`.
 *
 * Timing note: daemon-spawned sessions have no sidecar JSON. We use the
 * first trace event's `ts` field as the session start time to apply the
 * `--days` window filter. When `ts` is absent we fall back to the trace
 * directory mtime.
 *
 * @module insights/aggregators/traces
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getAfkStateDir } from '../../paths.js';
import { TraceEventSchema } from '../../agent/trace/events.js';
import type { InsightsOptions, TraceAggregates } from '../types.js';

// ---------------------------------------------------------------------------
// Zero aggregates factory
// ---------------------------------------------------------------------------

export function zeroTraceAggregates(): TraceAggregates {
  return {
    totalTracedSessions: 0,
    toolCallCounts: {},
    toolErrorCounts: {},
    toolDurationsMs: {},
    subagentForkDepths: {},
    compactionCount: 0,
    closureReasons: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalCostUsd: 0,
    sessionsWithCost: 0,
  };
}

// ---------------------------------------------------------------------------
// Helper: increment a numeric record entry
// ---------------------------------------------------------------------------

function inc(rec: Record<string, number>, key: string, by = 1): void {
  rec[key] = (rec[key] ?? 0) + by;
}

function incNum(rec: Record<number, number>, key: number, by = 1): void {
  rec[key] = (rec[key] ?? 0) + by;
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/**
 * Read all trace JSONL files within the `options.days` lookback window and
 * return aggregated trace metrics. Never throws.
 */
export function aggregateTraces(options: InsightsOptions): TraceAggregates {
  const agg = zeroTraceAggregates();

  // Resolve witness root
  const stateDir = options.afkHome
    ? join(options.afkHome, 'state')
    : getAfkStateDir();
  const witnessRoot = join(stateDir, 'witness');

  if (!existsSync(witnessRoot)) {
    return agg;
  }

  let sessionDirs: string[];
  try {
    sessionDirs = readdirSync(witnessRoot);
  } catch {
    return agg;
  }

  const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;

  for (const sessionId of sessionDirs) {
    const tracePath = join(witnessRoot, sessionId, 'trace.jsonl');
    if (!existsSync(tracePath)) continue;

    // Cheap pre-filter: mtime is always >= the session's start time (the
    // trace file is appended to throughout the session, so its last-write
    // time can never precede its first-write time). If mtime < cutoffMs,
    // the session definitely ended before the window opened — skip WITHOUT
    // reading the (potentially large) trace file. Sessions that pass this
    // check still get the precise first-line-ts check below.
    let mtimeMs: number;
    try {
      mtimeMs = statSync(tracePath).mtimeMs;
    } catch {
      continue; // can't stat — skip
    }
    if (mtimeMs < cutoffMs) {
      continue; // definitely outside window — skip without reading the file
    }

    // Read the trace file once and reuse it for both the window check and
    // aggregation below (this file was previously read twice per session).
    let raw: string | null = null;
    try {
      raw = readFileSync(tracePath, 'utf-8');
    } catch {
      raw = null; // unreadable — fall through to the mtime-based window check
    }

    // Determine whether this session falls within the window.
    // We parse the first event's ts field, falling back to file mtime
    // (already read above during the pre-filter).
    let sessionStartMs: number | null = null;
    if (raw !== null) {
      try {
        const firstLine = raw.split('\n')[0]?.trim();
        if (firstLine) {
          const parsed = JSON.parse(firstLine) as Record<string, unknown>;
          if (typeof parsed['ts'] === 'string') {
            const ts = Date.parse(parsed['ts']);
            if (!Number.isNaN(ts)) {
              sessionStartMs = ts;
            }
          }
        }
      } catch {
        // fall through to mtime
      }
    }

    // Fallback: use trace.jsonl mtime
    if (sessionStartMs === null) {
      sessionStartMs = mtimeMs;
    }

    if (sessionStartMs < cutoffMs) {
      continue; // outside window
    }

    // Process this session's trace file.
    agg.totalTracedSessions += 1;

    if (raw === null) {
      continue; // file was unreadable above — nothing to aggregate
    }
    const lines = raw.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // malformed line — skip
      }

      const result = TraceEventSchema.safeParse(parsed);
      if (!result.success) {
        continue; // schema mismatch — skip
      }

      const event = result.data;

      switch (event.kind) {
        case 'tool_call': {
          const { payload } = event;
          if (payload.phase === 'completed') {
            inc(agg.toolCallCounts, payload.name);
            if (payload.isError) {
              inc(agg.toolErrorCounts, payload.name);
            }
            if (!payload.isError) {
              inc(agg.toolDurationsMs, payload.name, payload.durationMs);
            }
          }
          // 'started' events are intentionally ignored.
          break;
        }

        case 'subagent_lifecycle': {
          const { payload } = event;
          if (payload.transition === 'started') {
            // Track fork depth. Depth is not in the payload directly —
            // we count all started events as depth 1 (fork from main session).
            // TODO: use parentId chain if depth tracking is ever needed.
            incNum(agg.subagentForkDepths, 1);
          }
          break;
        }

        case 'compaction': {
          agg.compactionCount += 1;
          break;
        }

        case 'closure': {
          const { payload } = event;
          inc(agg.closureReasons, payload.reason);
          // Authoritative token split + cost. The session sidecar only carries
          // a combined `totalTokens`; the per-direction breakdown lives here.
          // All finalTokens sub-fields are optional in the schema → default 0.
          const ft = payload.finalTokens;
          agg.totalInputTokens += ft.input ?? 0;
          agg.totalOutputTokens += ft.output ?? 0;
          agg.totalCacheReadTokens += ft.cacheRead ?? 0;
          agg.totalCacheCreationTokens += ft.cacheCreation ?? 0;
          agg.totalCostUsd += payload.finalCostUsd;
          if (payload.finalCostUsd > 0) {
            agg.sessionsWithCost += 1;
          }
          break;
        }

        default:
          // Other event kinds (hook_decision, budget, abort, etc.) — not aggregated.
          break;
      }
    }
  }

  return agg;
}
