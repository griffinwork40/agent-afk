/**
 * Mid-stream hard-cap overflow handling for the bash handler.
 *
 * Attaches stdout/stderr data listeners that accumulate bytes into a shared
 * counter and, when HARD_CAP_BYTES is crossed, SIGKILLs the child and
 * settles the promise immediately — a genuine-runaway circuit-breaker that
 * prevents V8 `RangeError: Invalid string length` on >512MB output floods.
 *
 * Extracted from `createBashHandler` so that function stays under the 200-line
 * ceiling. All mutable state is passed explicitly; no closures over hidden locals.
 *
 * @module agent/tools/handlers/bash.overflow
 */

import type { ChildProcess } from 'child_process';
import type { RollingTailBuffer } from './_rolling-tail.js';
import { appendRoutingDecision } from '../../routing-telemetry.js';
import { detectTestResult } from './test-runner-detector.js';
import { stripEscapeSequences } from '../../../utils/terminal-sanitize.js';
import { HARD_CAP_BYTES, MODEL_CAP_BYTES, headAndTail, HARD_CAP_KILL_NOTE } from './_output-cap.js';
import { debugLog } from '../../../utils/debug.js';

/** Shared mutable accumulator passed by reference so both stream handlers share one counter. */
export interface OverflowState {
  stdout: string;
  stderr: string;
  totalBytes: number;
  overflowKilled: boolean;
}

/** Parameters for {@link attachStreamHandlers}. */
export interface AttachStreamHandlersParams {
  proc: ChildProcess;
  state: OverflowState;
  tailBuffer: RollingTailBuffer | undefined;
  resolved: () => boolean;
  deregisterOnClose: () => (() => void) | undefined;
  settle: (result: { content: string; isError?: boolean; truncated?: boolean; capturePath?: string; durationMs?: number; exitCode?: number; testResult?: import('./test-runner-detector.js').TestResult }) => void;
  startedAt: number;
  command: string;
}

/**
 * Check whether the accumulated byte total has crossed HARD_CAP_BYTES.
 * If so, SIGKILL the process and settle the promise with a head+tail view.
 * One-shot: the `overflowKilled` latch prevents double-settlement from
 * concurrent stdout+stderr data events.
 */
function maybeOverflow(
  stream: 'stdout' | 'stderr',
  params: AttachStreamHandlersParams,
): void {
  const { state, proc, resolved, deregisterOnClose, settle, startedAt, command } = params;
  // M3: one-shot latch — concurrent stdout+stderr data events can both
  // push totalBytes past the threshold before the kill takes effect.
  if (state.overflowKilled) return;
  if (resolved()) return;
  if (state.totalBytes < HARD_CAP_BYTES) return;
  state.overflowKilled = true;
  // P1: debug-only (a raw console.warn tore through the TUI); users see the
  // tool row's outputCapKilled label, the model sees HARD_CAP_KILL_NOTE.
  debugLog(
    `[bash] overflow kill: stream=${stream} totalBytes=${state.totalBytes} command="${command}"`,
  );
  // P2: structured JSONL counterpart queryable from routing-decisions.jsonl.
  // Privacy: command stays out of telemetry (audit §G.4).
  void appendRoutingDecision({
    event: 'tool.overflow_kill',
    tool: 'bash',
    total_bytes: state.totalBytes,
    stream,
  });
  proc.kill('SIGKILL');
  const combined = stripEscapeSequences((state.stdout + state.stderr).trimEnd());
  const testResult = detectTestResult(combined) ?? undefined;
  const content = headAndTail(combined, MODEL_CAP_BYTES) + HARD_CAP_KILL_NOTE;
  deregisterOnClose()?.();
  settle({ content, truncated: true, durationMs: Date.now() - startedAt, ...(testResult !== undefined ? { testResult } : {}) });
}

/**
 * Attach `data` listeners to `proc.stdout` and `proc.stderr`.
 *
 * Each listener guards at the Buffer layer (H1 + M1) before `.toString()` so
 * a single oversized chunk never allocates a full V8 string, then feeds the
 * rolling tail buffer for live TUI display.
 */
export function attachStreamHandlers(params: AttachStreamHandlersParams): void {
  const { proc, state, tailBuffer } = params;

  proc.stdout!.on('data', (chunk: Buffer) => {
    // H1 + M1: slice at the Buffer layer BEFORE .toString() so a single
    // oversized chunk (>= HARD_CAP_BYTES) never allocates a full V8 string.
    const remaining = HARD_CAP_BYTES - state.totalBytes;
    const safe = chunk.length <= remaining ? chunk : chunk.subarray(0, Math.max(0, remaining));
    state.totalBytes += safe.length;
    const text = safe.toString('utf8');
    state.stdout += text;
    tailBuffer?.push(text);
    maybeOverflow('stdout', params);
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    // H1 + M1: same Buffer-layer guard as stdout handler above.
    const remaining = HARD_CAP_BYTES - state.totalBytes;
    const safe = chunk.length <= remaining ? chunk : chunk.subarray(0, Math.max(0, remaining));
    state.totalBytes += safe.length;
    const text = safe.toString('utf8');
    state.stderr += text;
    tailBuffer?.push(text);
    maybeOverflow('stderr', params);
  });
}
