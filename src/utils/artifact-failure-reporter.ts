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
 * Invariant: a dedup key may be an OBJECT (the failing sink instance) or a
 * STRING id, and the two are latched in different structures because each
 * choice is load-bearing.
 *
 *   - Object keys use a `WeakMap` keyed on instance identity. Deriving a key
 *     by CALLING A METHOD on the sink is not safe: a partial/test-double
 *     `TraceWriter` need not implement `getTracePath`, and calling it from
 *     inside the catch block made this reporter throw the very failure it
 *     exists to report (`TypeError: writer.getTracePath is not a function` —
 *     4 unhandled errors out of `src/telegram/mcp-session.test.ts`, reddening
 *     CI while all 15864 tests passed). Identity also fixes a correctness bug
 *     a path-derived key cannot: `InMemoryTraceWriter.getTracePath()` returns
 *     the SHARED sentinel `'in-memory://trace'` for every instance
 *     (`agent/trace/writer.ts`), so path-keying silently swallowed the first
 *     warning of every in-memory writer after the first one. A `WeakMap` is
 *     additionally self-bounding — entries go away when the writer does.
 *   - String keys cannot go in a `WeakMap`, so they use an insertion-ordered
 *     `Map` capped at `MAX_STRING_LATCH_ENTRIES`, evicting oldest on overflow
 *     (same shape as the LRU in `cli/syntax-highlight.ts`). Unbounded growth
 *     was reachable: `CronScheduler.spawnSession()` mints a fresh UUID trace
 *     label per tick, so a daemon against a persistently unwritable witness
 *     dir added one permanent entry per scheduled run. Eviction tradeoff,
 *     accepted deliberately: a key evicted after long inactivity may surface
 *     a second visible warning later. Warning twice across hundreds of
 *     distinct sessions beats leaking for the life of the process.
 *
 * @module utils/artifact-failure-reporter
 */

import { debugLog } from './debug.js';

/**
 * Cap on the string-keyed latch. Sized well above the number of distinct
 * sessions one process realistically touches while a sink is wedged, so
 * eviction is a backstop against unbounded growth rather than a routine
 * event that would re-surface warnings during normal operation.
 */
const MAX_STRING_LATCH_ENTRIES = 256;

/**
 * Latch for object dedup keys: sink instance -> subsystems already surfaced.
 * The inner `Set` is bounded by the number of distinct subsystem labels that
 * write to one sink (a small constant); the whole entry is collected when the
 * sink becomes unreachable. Reassigned (not `const`) so the test-only reset
 * can drop every entry at once — a `WeakMap` has no `clear()`.
 */
let reportedByInstance = new WeakMap<object, Set<string>>();

/** Latch of `subsystem\0dedupKey` pairs for STRING keys. Bounded, FIFO. */
const reportedOnce = new Map<string, true>();

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Record a (subsystem, dedupKey) pair as surfaced.
 *
 * @returns true when this is the FIRST sighting of the pair — i.e. the caller
 *   should print visibly rather than falling back to `debugLog`.
 */
function latchFirstSeen(subsystem: string, dedupKey: string | object): boolean {
  if (typeof dedupKey === 'object' && dedupKey !== null) {
    let seen = reportedByInstance.get(dedupKey);
    if (!seen) {
      seen = new Set<string>();
      reportedByInstance.set(dedupKey, seen);
    }
    if (seen.has(subsystem)) return false;
    seen.add(subsystem);
    return true;
  }

  const latchKey = `${subsystem}\u0000${String(dedupKey)}`;
  if (reportedOnce.has(latchKey)) return false;
  reportedOnce.set(latchKey, true);
  if (reportedOnce.size > MAX_STRING_LATCH_ENTRIES) {
    const oldest = reportedOnce.keys().next().value;
    if (oldest !== undefined) reportedOnce.delete(oldest);
  }
  return true;
}

/**
 * Report a swallowed artifact-write failure. Surfaces the FIRST failure for
 * a given (subsystem, dedupKey) pair to stderr unconditionally; every later
 * failure for the same pair falls back to `debugLog` so a wedged sink does
 * not flood the operator's terminal with one line per call.
 *
 * Contract: never throws, and never CALLS anything on `dedupKey`. A
 * diagnostic must not become the failure it reports — the outer try/catch
 * guards a broken/closed stderr, and object keys are used by identity only
 * so a partially-implemented sink cannot raise from in here. Same contract
 * `warnAfkHomeRejectedOnce` makes in `agent/tools/afk-home-warn.ts`.
 *
 * @param subsystem Short stable label for the failing module, e.g.
 *   `'trace.emit'` or `'subagent-output-capture'`. Combined with `dedupKey`
 *   for the latch, so two different subsystems failing on the same sink each
 *   still get their own first-failure warning.
 * @param dedupKey Identifies the specific sink that failed. Pass the sink
 *   INSTANCE (e.g. the `TraceWriter`) when you have it — matched by identity,
 *   never by calling a method on it. Pass a string (e.g. a witness session
 *   id) when the sink has no stable object to hand.
 * @param context Short human label for the operation that failed, e.g.
 *   `'tool_call'` or `'captureSubagentPrompt'` — included in the message so
 *   the one visible line is actionable rather than a bare "something broke".
 * @param err The caught error.
 */
export function reportArtifactFailure(
  subsystem: string,
  dedupKey: string | object,
  context: string,
  err: unknown,
): void {
  try {
    const message = `[afk] ${subsystem} artifact write failed (${context}): ${stringifyError(err)}`;
    if (!latchFirstSeen(subsystem, dedupKey)) {
      debugLog(message);
      return;
    }
    console.error(
      `${message} — further failures in this subsystem for this session are logged only under AFK_DEBUG=1.`,
    );
  } catch {
    /* A diagnostic must never become the failure it reports. */
  }
}

/**
 * Test-only: clear both once-latches so a suite can assert the first-failure
 * behavior deterministically.
 *
 * Contract: production code must never call this. Without it, a test
 * asserting a (subsystem, dedupKey) pair surfaces on its FIRST failure would
 * depend on suite ordering — whichever spec exercises that pair first
 * consumes the latch for every test that runs after it.
 */
export function resetArtifactFailureReporterForTests(): void {
  reportedOnce.clear();
  reportedByInstance = new WeakMap<object, Set<string>>();
}
