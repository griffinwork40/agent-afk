/**
 * Per-session ToolHealthMonitor — detects when a single tool is failing
 * nearly every call with the same error and (1) appends a warning to the
 * tool's error result so the model can adapt, and (2) emits a durable
 * `tool_degraded` session_phase trace event for downstream aggregation.
 *
 * Contract:
 *   - Fire-and-forget: trace emission never throws through to the caller.
 *   - Never changes `isError`, never blocks execution, never alters successes.
 *   - Trace event emitted at most once per (tool, errorHead) per session
 *     (dedup by emitted set).
 *   - Model notice appended on the triggering call; then suppressed until the
 *     window clears (i.e. success calls dilute the window below the threshold
 *     — at that point the monitor "rearms" naturally and will fire again if
 *     the same degradation recurs, treating it as a new incident).
 *
 * Invariant: instances are per-dispatcher (one per session or forked child).
 * A module-scope singleton would conflate all active sessions in one process
 * (Telegram / daemon) — forbidden by the module-state audit.
 *
 * @module agent/tools/tool-health-monitor
 */

import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import type { TraceSink } from '../trace/index.js';
import { buildErrorHead } from '../providers/shared/tool-call-trace.js';
import { emitSessionPhase } from '../trace/emit.js';

// ---------------------------------------------------------------------------
// Thresholds — all exported so tests can import them by name.
// ---------------------------------------------------------------------------

/**
 * Sliding window: the last N calls of a given tool are examined.
 * Shorter windows surface degradation faster; 10 is a practical balance
 * between latency (bad: too many failures before we notice) and false
 * positives (bad: a single bad call pattern looks catastrophic).
 */
export const HEALTH_WINDOW_SIZE = 10;

/**
 * Minimum number of calls in the window required before the monitor may fire.
 * Below this, the sample is too small to be confident. Must be <= HEALTH_WINDOW_SIZE.
 * 8 of 10 satisfies "nearly every call" without being brittle on the first call.
 */
export const HEALTH_MIN_SAMPLE = 8;

/**
 * Fraction of calls in the window that must be errors. 0.90 = 90%.
 * One success in ten is enough to suppress the alert (ratio = 9/10 = 0.90
 * exactly — boundary is >= so 9/10 fires, 8/10 does not).
 */
export const HEALTH_ERROR_RATE_THRESHOLD = 0.9;

/**
 * Fraction of the errors in the window that must share the SAME errorHead.
 * Guards against a tool that fails with many different errors (likely a
 * programming error on the caller side, not a broken tool/environment).
 * 0.80 = 80%: if the same network error appears in ≥8 of 10 failures, that
 * is a systemic problem, not input diversity.
 */
export const HEALTH_DOMINANT_ERROR_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A single observation recorded in the sliding window. */
interface CallRecord {
  readonly isError: boolean;
  /** undefined for successful calls. */
  readonly errorHead: string | undefined;
}

/** Per-tool sliding window state. */
interface ToolWindow {
  /** Ring buffer of the last HEALTH_WINDOW_SIZE records. */
  readonly records: CallRecord[];
  /**
   * Set of (errorHead) strings for which a `tool_degraded` trace event has
   * already been emitted this session. Prevents duplicate trace events for the
   * same degradation incident (cooldown/dedup by error identity).
   */
  readonly emittedHeads: Set<string>;
  /**
   * Whether the model notice is currently "armed" — true means the next
   * trigger fires the notice, false means it is suppressed (already fired for
   * this degradation episode and the window has not yet recovered).
   *
   * Rearms automatically when the window falls below threshold: the notice
   * appears on the FIRST call that meets the threshold, then is suppressed
   * until the condition clears. This prevents notice spam on every subsequent
   * call while still notifying on a re-degradation.
   */
  noticePending: boolean;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Verdict returned by `ToolHealthMonitor.observe()`.
 *
 * When `degraded` is true, the caller MUST append `notice` to the tool
 * result's `content` field. The verdict fields needed for the trace event are
 * included so the caller does not need to re-derive them.
 */
export interface HealthVerdict {
  readonly degraded: false;
}

export interface DegradedHealthVerdict {
  readonly degraded: true;
  readonly tool: string;
  readonly errorHead: string;
  readonly errorCount: number;
  readonly callCount: number;
  /** Text to append to the failing tool result's content. */
  readonly notice: string;
  /** Whether to emit a trace event (false when already emitted for this head). */
  readonly emitTrace: boolean;
}

export type HealthVerdictResult = HealthVerdict | DegradedHealthVerdict;

// ---------------------------------------------------------------------------
// ToolHealthMonitor
// ---------------------------------------------------------------------------

/**
 * Per-session sliding-window health tracker for tool calls.
 *
 * Usage:
 *   1. Call `observe(call, result)` after every settled tool result.
 *   2. If the verdict is `degraded`, append `verdict.notice` to result.content
 *      and — when `verdict.emitTrace` is true — emit the trace event.
 */
export class ToolHealthMonitor {
  private readonly windows = new Map<string, ToolWindow>();

  /**
   * Record a settled result and return a verdict indicating whether the tool
   * is degraded and what notice (if any) should be appended.
   *
   * Contract: call AFTER the result is fully settled (isError known). The
   * verdict is purely advisory — callers must not let it block the return path.
   */
  observe(call: ToolCall, result: ToolResult): HealthVerdictResult {
    const toolName = call.name;
    const isError = result.isError === true;
    const errorHead = isError ? buildErrorHead(true, result.content) : undefined;

    // Retrieve or create per-tool window.
    let window = this.windows.get(toolName);
    if (window === undefined) {
      window = { records: [], emittedHeads: new Set(), noticePending: true };
      this.windows.set(toolName, window);
    }

    // Append to sliding window (push, then trim front when over capacity).
    window.records.push({ isError, errorHead: errorHead ?? undefined });
    if (window.records.length > HEALTH_WINDOW_SIZE) {
      window.records.shift();
    }

    // Only evaluate on error calls — a success can never be the trigger.
    if (!isError) {
      // A success rearms the notice so the next degradation episode is announced.
      window.noticePending = true;
      return { degraded: false };
    }

    // Need at least HEALTH_MIN_SAMPLE records before evaluating.
    const callCount = window.records.length;
    if (callCount < HEALTH_MIN_SAMPLE) {
      return { degraded: false };
    }

    // Count errors.
    const errorCount = window.records.filter((r) => r.isError).length;
    const errorRate = errorCount / callCount;
    if (errorRate < HEALTH_ERROR_RATE_THRESHOLD) {
      // Below threshold — rearming in case it was suppressed.
      window.noticePending = true;
      return { degraded: false };
    }

    // Count frequency of the dominant errorHead among the error records.
    const errorRecords = window.records.filter((r) => r.isError && r.errorHead !== undefined);
    if (errorRecords.length === 0) {
      return { degraded: false };
    }

    // Find the most common errorHead.
    const headCounts = new Map<string, number>();
    for (const rec of errorRecords) {
      const h = rec.errorHead!;
      headCounts.set(h, (headCounts.get(h) ?? 0) + 1);
    }
    let dominantHead = '';
    let dominantCount = 0;
    for (const [h, count] of headCounts) {
      if (count > dominantCount) {
        dominantCount = count;
        dominantHead = h;
      }
    }

    // Dominance check: dominant errorHead must account for >= 80% of ERRORS
    // (not of total calls — we want the "same error" signal to be strong).
    const dominanceRate = dominantCount / errorCount;
    if (dominanceRate < HEALTH_DOMINANT_ERROR_THRESHOLD) {
      window.noticePending = true;
      return { degraded: false };
    }

    // --- Degraded ---

    // Should we emit a trace event? Only if we haven't already for this head.
    const shouldEmitTrace = !window.emittedHeads.has(dominantHead);
    if (shouldEmitTrace) {
      window.emittedHeads.add(dominantHead);
    }

    // Should we append a model notice? Only when armed (first trigger per episode).
    const shouldNotify = window.noticePending;
    if (shouldNotify) {
      // Suppress until the window clears / rearms on success.
      window.noticePending = false;
    }

    if (!shouldNotify && !shouldEmitTrace) {
      // Already handled this degradation episode: no new trace, no new notice.
      return { degraded: false };
    }

    const notice = shouldNotify
      ? `\n\n[tool-health] ${toolName} has failed ${errorCount} of the last ${callCount} calls ` +
        `with the same error: ${dominantHead}. This looks like a broken tool/environment, not ` +
        `your input. Stop retrying it, tell the user, and use an alternative.`
      : '';

    return {
      degraded: true,
      tool: toolName,
      errorHead: dominantHead,
      errorCount,
      callCount,
      notice,
      emitTrace: shouldEmitTrace,
    };
  }

  /** Exposed for tests: current window record count for a tool. */
  windowSizeFor(toolName: string): number {
    return this.windows.get(toolName)?.records.length ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Emit helper — called by the dispatcher after observe() returns degraded.
// ---------------------------------------------------------------------------

/**
 * Emit the `tool_degraded` session_phase trace event.
 *
 * Fire-and-forget: errors are swallowed by `emitSessionPhase` → `emitTrace`.
 * Callers must not await the returned promise in a way that delays the result.
 */
export function emitToolDegraded(
  traceWriter: TraceSink | undefined,
  verdict: DegradedHealthVerdict,
): void {
  void emitSessionPhase(traceWriter, {
    phase: 'tool_degraded',
    metadata: {
      tool: verdict.tool,
      errorHead: verdict.errorHead,
      errorCount: verdict.errorCount,
      callCount: verdict.callCount,
    },
  });
}

// ---------------------------------------------------------------------------
// Shared apply helper — used by execute() and the batch paths.
// ---------------------------------------------------------------------------

/**
 * Observe a settled tool result and return a (potentially notice-appended)
 * result. Used by both the single-call `execute()` path and the batch paths
 * so the logic lives exactly once.
 *
 * Contract:
 *   - Never changes `isError`.
 *   - Fire-and-forget for the trace event (via `emitToolDegraded`).
 *   - When the verdict is not degraded, returns `result` unchanged.
 */
export function applyToolHealth(
  monitor: ToolHealthMonitor,
  traceWriter: TraceSink | undefined,
  call: ToolCall,
  result: ToolResult,
): ToolResult {
  const verdict = monitor.observe(call, result);
  if (!verdict.degraded) return result;
  if (verdict.emitTrace) emitToolDegraded(traceWriter, verdict);
  if (verdict.notice) return { ...result, content: result.content + verdict.notice };
  return result;
}
