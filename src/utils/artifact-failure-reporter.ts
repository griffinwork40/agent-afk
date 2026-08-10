/**
 * Shared first-failure-visible reporter for fire-and-forget observability
 * writes (trace events, subagent prompt/output capture).
 *
 * Contract: an artifact write failing must NEVER fail the caller's turn —
 * every call site here already wraps its write in its own try/catch and
 * reaches this module only from inside that catch block. This module does
 * not change that fire-and-forget contract; it only decides how the
 * swallowed failure becomes VISIBLE without becoming fatal.
 *
 * Problem this fixes (#850): every witness/forensics swallow site reported
 * failure only via `debugLog`, which no-ops unless AFK_DEBUG=1/DEBUG=1. An
 * operator who deliberately turns an observability feature ON (e.g.
 * `AFK_CAPTURE_SUBAGENT_PROMPTS=1`) got total silence whether it worked or
 * was 100% broken — reachable total-silent-no-op modes include
 * EACCES/ENOSPC/EROFS on `mkdir` and a session label that fails
 * `validateSessionId` (see `src/paths.ts`). The gap surfaced only when an
 * operator went looking for evidence that was never written — exactly when
 * it was no longer recoverable. This is deliberately a subsystem-level fix
 * (one shared reporter, wired through every swallow site) rather than a
 * per-module patch, so behavior is consistent across the whole witness layer.
 *
 * Fix: the FIRST failure for a given (subsystem, dedup key) pair is surfaced
 * to stderr unconditionally via `console.error` — same precedent as
 * `subagent-hooks.ts`'s SubagentStop-timeout warning: plain text, no
 * chalk/palette, because a headless daemon/chat surface has no compositor to
 * render into. Every subsequent failure for that same pair falls back to
 * `debugLog`, so a wedged subsystem (e.g. a session directory that is EROFS
 * for the whole run) logs ONCE instead of once per trace event.
 *
 * Dedup key: callers pass whatever string uniquely identifies "this failing
 * artifact sink" for their module. `agent/trace/emit.ts`'s emit* functions
 * take `(writer, payload)` with no `sessionId` parameter, so
 * `TraceWriter.getTracePath()` is used there — unique per session/writer
 * instance without threading a new parameter through every call site. The
 * subagent prompt/output capture modules already carry `input.sessionId` and
 * use that directly.
 *
 * @module utils/artifact-failure-reporter
 */

import { debugLog } from './debug.js';

/** Latch of `subsystem\0dedupKey` pairs that have already surfaced once. */
const reportedOnce = new Set<string>();

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Report a swallowed artifact-write failure. Surfaces the FIRST failure for
 * a given (subsystem, dedupKey) pair to stderr unconditionally; every later
 * failure for the same pair falls back to `debugLog` so a wedged sink does
 * not flood the operator's terminal with one line per call.
 *
 * Contract: never throws. A diagnostic must not become the failure it
 * reports — `console.error` raising (e.g. a broken/closed stderr) is
 * vanishingly rare but cheap to guard against, matching the same contract
 * `warnAfkHomeRejectedOnce` makes in `agent/tools/afk-home-warn.ts`.
 *
 * @param subsystem Short stable label for the failing module, e.g.
 *   `'trace.emit'` or `'subagent-output-capture'`. Combined with `dedupKey`
 *   for the latch, so two different subsystems failing for the same session
 *   each still get their own first-failure warning.
 * @param dedupKey String identifying the specific sink that failed — a
 *   trace path (`TraceWriter.getTracePath()`) or a witness session id.
 * @param context Short human label for the operation that failed, e.g.
 *   `'tool_call'` or `'captureSubagentPrompt'` — included in the message so
 *   the one visible line is actionable rather than a bare "something broke".
 * @param err The caught error.
 */
export function reportArtifactFailure(
  subsystem: string,
  dedupKey: string,
  context: string,
  err: unknown,
): void {
  try {
    const latchKey = `${subsystem}\u0000${dedupKey}`;
    const message = `[afk] ${subsystem} artifact write failed (${context}): ${stringifyError(err)}`;
    if (reportedOnce.has(latchKey)) {
      debugLog(message);
      return;
    }
    reportedOnce.add(latchKey);
    console.error(
      `${message} — further failures in this subsystem for this session are logged only under AFK_DEBUG=1.`,
    );
  } catch {
    /* A diagnostic must never become the failure it reports. */
  }
}

/**
 * Test-only: clear the once-latch so a suite can assert the first-failure
 * behavior deterministically.
 *
 * Contract: production code must never call this. Without it, a test
 * asserting a (subsystem, dedupKey) pair surfaces on its FIRST failure would
 * depend on suite ordering — whichever spec exercises that pair first
 * consumes the latch for every test that runs after it.
 */
export function resetArtifactFailureReporterForTests(): void {
  reportedOnce.clear();
}
