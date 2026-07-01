/**
 * Daemon telemetry aggregator — reads forge-telemetry.jsonl and aggregates
 * task success/error/skip rates, trigger breakdowns, and skip reasons.
 *
 * Privacy invariants:
 *   - `responseExcerpt` is NEVER included in output aggregates.
 *   - `recentErrors` contains only `{ taskId, ts, message }` — no user content.
 *   - The `command` field is not forwarded either (may contain inline secrets
 *     in edge cases). Only `taskId`, timing, status, and error message are used.
 *
 * Read strategy: reads the full file (or last ~1MB if large). JSONL is
 * parsed line-by-line; malformed lines are silently skipped.
 *
 * @module insights/aggregators/daemon
 */

import { existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { getTelemetryPath } from '../../paths.js';
import type { InsightsOptions, DaemonAggregates } from '../types.js';

// ---------------------------------------------------------------------------
// Zero aggregates factory
// ---------------------------------------------------------------------------

export function zeroDaemonAggregates(): DaemonAggregates {
  return {
    totalRuns: 0,
    successCount: 0,
    errorCount: 0,
    skipCount: 0,
    byTaskId: {},
    triggerBreakdown: {},
    skipReasons: {},
    recentErrors: [],
    avgDurationMs: 0,
  };
}

// ---------------------------------------------------------------------------
// 1 MB tail reader
// ---------------------------------------------------------------------------

const ONE_MB = 1_048_576;

/**
 * Read up to the last 1 MB of a file as a UTF-8 string.
 * Always returns complete lines (splits on '\n').
 */
function readTailMb(filePath: string): string {
  const fd = openSync(filePath, 'r');
  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;
    const readOffset = Math.max(0, fileSize - ONE_MB);
    const readLength = fileSize - readOffset;
    const buf = Buffer.alloc(readLength);
    readSync(fd, buf, 0, readLength, readOffset);
    const content = buf.toString('utf-8');
    // When we start mid-file, drop the partial first line.
    if (readOffset > 0) {
      const firstNewline = content.indexOf('\n');
      return firstNewline >= 0 ? content.slice(firstNewline + 1) : '';
    }
    return content;
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/**
 * Parse `forge-telemetry.jsonl` within the `options.days` lookback window
 * and return aggregated daemon task metrics. Never throws.
 */
export function aggregateDaemonTelemetry(options: InsightsOptions): DaemonAggregates {
  const agg = zeroDaemonAggregates();

  // Determine the telemetry file path — use afkHome override for tests.
  const telemetryPath = options.afkHome
    ? join(options.afkHome, 'agent-framework', 'forge-telemetry.jsonl')
    : getTelemetryPath();

  if (!existsSync(telemetryPath)) {
    return agg;
  }

  let rawContent: string;
  try {
    rawContent = readTailMb(telemetryPath);
  } catch {
    return agg;
  }

  const cutoffMs = Date.now() - options.days * 24 * 60 * 60 * 1000;
  const lines = rawContent.split('\n');

  const allErrors: Array<{ taskId: string; ts: number; message: string }> = [];
  let totalDurationMs = 0;
  let durationCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // malformed line — skip
    }

    // Filter by triggeredAt (ISO string → epoch ms)
    const triggeredAtRaw = record['triggeredAt'];
    if (typeof triggeredAtRaw !== 'string') continue;
    const triggeredAtMs = Date.parse(triggeredAtRaw);
    if (Number.isNaN(triggeredAtMs) || triggeredAtMs < cutoffMs) continue;

    // Only process TelemetryRecord-shaped entries (must have taskId + status)
    const taskId = typeof record['taskId'] === 'string' ? record['taskId'] : null;
    const status = typeof record['status'] === 'string' ? record['status'] : null;
    if (!taskId || !status) continue;

    agg.totalRuns += 1;

    // Initialize per-task breakdown
    if (!agg.byTaskId[taskId]) {
      agg.byTaskId[taskId] = { success: 0, error: 0, skip: 0 };
    }

    // Tally status
    if (status === 'success') {
      agg.successCount += 1;
      agg.byTaskId[taskId]!.success += 1;
    } else if (status === 'error') {
      agg.errorCount += 1;
      agg.byTaskId[taskId]!.error += 1;

      // Build recentErrors entry — NEVER include responseExcerpt or command.
      const rawMessage = record['errorMessage'];
      const message =
        typeof rawMessage === 'string' ? rawMessage.slice(0, 500) : '(no message)';
      allErrors.push({ taskId, ts: triggeredAtMs, message });
    } else if (status === 'skipped') {
      agg.skipCount += 1;
      agg.byTaskId[taskId]!.skip += 1;

      const skipReason = record['skipReason'];
      if (typeof skipReason === 'string') {
        agg.skipReasons[skipReason] = (agg.skipReasons[skipReason] ?? 0) + 1;
      }
    }

    // Trigger breakdown
    const trigger = record['trigger'];
    if (typeof trigger === 'string') {
      agg.triggerBreakdown[trigger] = (agg.triggerBreakdown[trigger] ?? 0) + 1;
    }

    // Duration accumulation
    const durationMs = record['durationMs'];
    if (typeof durationMs === 'number' && durationMs >= 0) {
      totalDurationMs += durationMs;
      durationCount += 1;
    }
  }

  // Average duration
  agg.avgDurationMs = durationCount > 0 ? totalDurationMs / durationCount : 0;

  // Recent errors: last 5, sorted by ts descending — NO responseExcerpt
  agg.recentErrors = allErrors
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5);

  return agg;
}
