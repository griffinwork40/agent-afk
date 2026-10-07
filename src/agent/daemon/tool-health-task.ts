/**
 * Builtin task: tool-health aggregator.
 *
 * Scans recent witness traces for `tool_degraded` session_phase events,
 * groups them by (tool, errorHead), and alerts via the scheduler's
 * onTaskComplete → Telegram path when a group appears in ≥2 distinct sessions
 * within a rolling 6-hour window.
 *
 * Alert dedup: the same (tool, errorHead) pair is not re-alerted within 24h.
 * State is persisted atomically to `<state>/daemon/tool-health-alerts.json`.
 * A corrupt or missing state file is treated as empty — never throws.
 *
 * The task MUST be registered with `notifyOn: 'failure'` so that the
 * onTaskComplete callback only fires when status === 'error' (an alert). A
 * success (no degraded tools) produces no notification.
 *
 * @module agent/daemon/tool-health-task
 */

import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { listTraces } from '../trace/listing.js';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';
import { getToolHealthAlertStatePath } from '../../paths.daemon.js';
import { errorMessage } from '../../utils/errors.js';
import type { TelemetryRecord, TelemetryTrigger } from './scheduler.js';

// ---------------------------------------------------------------------------
// In-process fallback cooldown (survives disk-write failures within one daemon
// lifetime). Declared here — sibling files must import this binding, never
// re-declare it (enforced by pnpm audit:module-state:check).
// ---------------------------------------------------------------------------

/**
 * Maps `"${tool}::${errorHead}"` → epoch ms of the last alert sent this
 * process lifetime. Written even when the disk-state write fails, so the
 * cooldown is honoured within the current daemon run regardless of disk health.
 */
const _inProcessAlertTimes = new Map<string, number>();

/**
 * Reset the in-process cooldown map. Call from `beforeEach` in tests that
 * exercise the write-failure path so cases do not bleed cooldown into each
 * other. Never call in production code.
 */
export function _resetToolHealthAlertCooldownForTests(): void {
  _inProcessAlertTimes.clear();
}

// ---------------------------------------------------------------------------
// Thresholds / constants — exported for tests
// ---------------------------------------------------------------------------

/** Lookback window: only sessions whose newest content is within this many ms
 *  are scanned. Default 6 hours. */
export const TOOL_HEALTH_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** A group (tool, errorHead) appearing in this many distinct sessions triggers
 *  an alert. */
export const TOOL_HEALTH_MIN_SESSIONS = 2;

/** Cooldown: do not re-alert the same (tool, errorHead) within this window. */
export const TOOL_HEALTH_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Maximum number of trace files to scan per run (cost bound). */
const TOOL_HEALTH_MAX_FILES = 200;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** One `tool_degraded` event extracted from a trace line. */
interface DegradedEvent {
  tool: string;
  errorHead: string;
  errorCount: number;
  callCount: number;
  sessionLabel: string;
}

/** Persisted alert-state: maps `"${tool}::${errorHead}"` → last alert epoch ms. */
interface AlertState {
  alerts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Options type (mirrors worktree-prune-task for testability)
// ---------------------------------------------------------------------------

export interface ToolHealthTaskOptions {
  now: () => number;
  telemetryPath: () => string;
  writeTelemetry: (record: TelemetryRecord) => void;
  /** Override lookback window for tests. */
  lookbackMs?: number;
  /** Override alert state path for tests. */
  alertStatePath?: string;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

async function readAlertState(path: string): Promise<AlertState> {
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'alerts' in parsed &&
      typeof (parsed as { alerts: unknown }).alerts === 'object' &&
      (parsed as { alerts: unknown }).alerts !== null
    ) {
      return parsed as AlertState;
    }
  } catch {
    // Missing or corrupt — treat as empty
  }
  return { alerts: {} };
}

/**
 * Attempt to persist alert state to disk. Returns an error message string when
 * the write failed (caller logs it), or `undefined` on success.
 */
async function writeAlertState(path: string, state: AlertState): Promise<string | undefined> {
  try {
    await atomicWriteFileAsync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
    return undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

// ---------------------------------------------------------------------------
// Trace scanning
// ---------------------------------------------------------------------------

/**
 * Parse one NDJSON line from a trace file and extract a `tool_degraded` event.
 * Returns `null` when the line is not a matching event.
 */
function parseDegradedLine(
  line: string,
  sessionLabel: string,
): DegradedEvent | null {
  if (!line.includes('tool_degraded')) return null;
  try {
    const obj: unknown = JSON.parse(line);
    if (
      obj === null ||
      typeof obj !== 'object' ||
      (obj as Record<string, unknown>)['kind'] !== 'session_phase'
    ) {
      return null;
    }
    const payload = (obj as Record<string, unknown>)['payload'];
    if (
      payload === null ||
      typeof payload !== 'object' ||
      (payload as Record<string, unknown>)['phase'] !== 'tool_degraded'
    ) {
      return null;
    }
    const meta = (payload as Record<string, unknown>)['metadata'];
    if (meta === null || typeof meta !== 'object') return null;
    const m = meta as Record<string, unknown>;
    const tool = typeof m['tool'] === 'string' ? m['tool'] : undefined;
    const errorHead = typeof m['errorHead'] === 'string' ? m['errorHead'] : undefined;
    if (!tool || !errorHead) return null;
    const errorCount = typeof m['errorCount'] === 'number' ? m['errorCount'] : 0;
    const callCount = typeof m['callCount'] === 'number' ? m['callCount'] : 0;
    return { tool, errorHead, errorCount, callCount, sessionLabel };
  } catch {
    return null;
  }
}

/**
 * Stream-read a trace.jsonl file and collect all `tool_degraded` events.
 * Errors (permission, missing) are silently swallowed — return [].
 */
async function scanTrace(
  tracePath: string,
  sessionLabel: string,
): Promise<DegradedEvent[]> {
  const events: DegradedEvent[] = [];
  try {
    const rl = createInterface({
      input: createReadStream(tracePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (line.trim() === '') continue;
      const ev = parseDegradedLine(line, sessionLabel);
      if (ev !== null) events.push(ev);
    }
  } catch {
    // Silently ignore unreadable traces
  }
  return events;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface GroupSummary {
  tool: string;
  errorHead: string;
  sessionCount: number;
  totalErrorCount: number;
  totalCallCount: number;
}

function aggregateEvents(allEvents: DegradedEvent[]): GroupSummary[] {
  // Group by (tool, errorHead) — count distinct sessions and accumulate counts
  const byKey = new Map<
    string,
    { tool: string; errorHead: string; sessions: Set<string>; errCount: number; callCount: number }
  >();
  for (const ev of allEvents) {
    const key = `${ev.tool}::${ev.errorHead}`;
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { tool: ev.tool, errorHead: ev.errorHead, sessions: new Set(), errCount: 0, callCount: 0 };
      byKey.set(key, entry);
    }
    entry.sessions.add(ev.sessionLabel);
    entry.errCount += ev.errorCount;
    entry.callCount += ev.callCount;
  }

  const summaries: GroupSummary[] = [];
  for (const entry of byKey.values()) {
    if (entry.sessions.size >= TOOL_HEALTH_MIN_SESSIONS) {
      summaries.push({
        tool: entry.tool,
        errorHead: entry.errorHead,
        sessionCount: entry.sessions.size,
        totalErrorCount: entry.errCount,
        totalCallCount: entry.callCount,
      });
    }
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Main task entry point
// ---------------------------------------------------------------------------

export async function runBuiltinToolHealthTask(
  task: { taskId: string; command: string; cronExpression?: string },
  trigger: TelemetryTrigger,
  options: ToolHealthTaskOptions,
): Promise<TelemetryRecord> {
  const triggeredAt = new Date(options.now());
  const startTimeMs = options.now();
  const baseRecord = {
    taskId: task.taskId,
    command: task.command,
    trigger,
    ...(task.cronExpression !== undefined ? { cronExpression: task.cronExpression } : {}),
    triggeredAt: triggeredAt.toISOString(),
  };

  try {
    const lookbackMs = options.lookbackMs ?? TOOL_HEALTH_LOOKBACK_MS;
    const cutoffMs = options.now() - lookbackMs;
    const alertStatePath = options.alertStatePath ?? getToolHealthAlertStatePath();

    // Discover recent traces — skip ones outside the window by mtime
    const allTraces = await listTraces();
    const recentTraces = allTraces
      .filter((t) => t.mtimeMs >= cutoffMs)
      .slice(0, TOOL_HEALTH_MAX_FILES);

    // Scan each trace for tool_degraded events
    const allEvents: DegradedEvent[] = [];
    for (const trace of recentTraces) {
      const events = await scanTrace(trace.tracePath, trace.sessionId);
      allEvents.push(...events);
    }

    // Aggregate by (tool, errorHead), filter for >= 2 sessions
    const groups = aggregateEvents(allEvents);
    if (groups.length === 0) {
      const record: TelemetryRecord = {
        ...baseRecord,
        durationMs: options.now() - startTimeMs,
        status: 'success',
        responseExcerpt: `tool-health: no degraded tools found in last ${Math.round(lookbackMs / 3600000)}h (scanned ${recentTraces.length} sessions)`,
      };
      options.writeTelemetry(record);
      return record;
    }

    // Apply cooldown: filter out groups alerted within 24h.
    // Two sources are checked: (1) on-disk persisted state (survives daemon
    // restarts) and (2) the in-process map (guards against disk-write failures
    // within one daemon lifetime so the same alert cannot re-fire every tick).
    const alertState = await readAlertState(alertStatePath);
    const nowMs = options.now();
    const newAlerts: GroupSummary[] = [];

    for (const g of groups) {
      const key = `${g.tool}::${g.errorHead}`;
      const lastDisk = alertState.alerts[key] ?? 0;
      const lastInProcess = _inProcessAlertTimes.get(key) ?? 0;
      const lastAlert = Math.max(lastDisk, lastInProcess);
      if (nowMs - lastAlert >= TOOL_HEALTH_COOLDOWN_MS) {
        newAlerts.push(g);
      }
    }

    if (newAlerts.length === 0) {
      // All alerts suppressed by cooldown — success (no Telegram push)
      const record: TelemetryRecord = {
        ...baseRecord,
        durationMs: options.now() - startTimeMs,
        status: 'success',
        responseExcerpt: `tool-health: ${groups.length} degraded group(s) found but all within 24h cooldown`,
      };
      options.writeTelemetry(record);
      return record;
    }

    // Update cooldown state for newly firing groups.
    // Write in-process map FIRST (always succeeds) so cooldown is honoured
    // even when the disk write below fails.
    for (const g of newAlerts) {
      const key = `${g.tool}::${g.errorHead}`;
      alertState.alerts[key] = nowMs;
      _inProcessAlertTimes.set(key, nowMs);
    }
    const writeErr = await writeAlertState(alertStatePath, alertState);
    let stateWriteNote: string | undefined;
    if (writeErr !== undefined) {
      const note = `tool-health: alert state write failed (in-process cooldown active): ${writeErr}`;
      process.stderr.write(`${note}\n`);
      stateWriteNote = note;
    }

    // Build alert message — operator-readable Telegram text
    const windowHours = Math.round(lookbackMs / 3600000);
    const lines = newAlerts.map(
      (g) =>
        `tool-health: ${g.tool} degraded in ${g.sessionCount} sessions (last ${windowHours}h): ${g.errorHead}` +
        ` [${g.totalErrorCount}/${g.totalCallCount} calls failed]`,
    );
    const alertErrorMessage = lines.join('\n');

    const record: TelemetryRecord = {
      ...baseRecord,
      durationMs: options.now() - startTimeMs,
      status: 'error',
      errorMessage: alertErrorMessage,
      ...(stateWriteNote !== undefined ? { responseExcerpt: stateWriteNote } : {}),
    };
    options.writeTelemetry(record);
    return record;
  } catch (err) {
    const record: TelemetryRecord = {
      ...baseRecord,
      durationMs: options.now() - startTimeMs,
      status: 'error',
      errorMessage: `tool-health: unexpected error: ${errorMessage(err)}`,
    };
    options.writeTelemetry(record);
    return record;
  }
}
