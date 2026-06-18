/**
 * Session-identity derivation for durable telemetry.
 *
 * Two orthogonal axes, both answerable from in-memory session state:
 *
 *   - `origin` — the USER-FACING surface that produced the work
 *     (`cli` / `telegram` / `daemon`). Derived from the session's `Surface`
 *     (REPL collapses to `cli`; the dead `subagent` Surface value and `unknown`
 *     map to `unknown`). This is DISTINCT from the JSONL telemetry
 *     `surface: 'afk' | 'plugin'` provenance tag, which names the writer
 *     ecosystem, not the entrypoint.
 *   - `actor` — the execution role (`main` vs `subagent`). A subagent is any
 *     session forked with a `parentSessionId`; everything else is `main`.
 *
 * Kept as a standalone, dependency-light module so the mapping table is cheap
 * to unit-test and reusable by the trace emit + other telemetry writers without
 * importing the heavy `AgentSession` module.
 *
 * @module agent/session/session-identity
 */

import type { Surface } from '../awareness/types.js';

/** User-facing surface bucket recorded as `origin` in durable telemetry. */
export type TraceOrigin = 'cli' | 'telegram' | 'daemon' | 'unknown';

/** Execution role recorded as `actor` in durable telemetry. */
export type TraceActor = 'main' | 'subagent';

/**
 * Map a session `Surface` to its persisted `origin` bucket.
 *
 * `repl` collapses to `cli` (the REPL is a CLI entrypoint); `subagent` is an
 * actor role, not a surface, so it maps to `unknown` here (a forked child's
 * origin comes from its inherited parent surface, not this value); `undefined`
 * and `unknown` both map to `unknown`.
 */
export function deriveOrigin(surface: Surface | undefined): TraceOrigin {
  switch (surface) {
    case 'cli':
    case 'repl':
      return 'cli';
    case 'telegram':
      return 'telegram';
    case 'daemon':
      return 'daemon';
    // 'subagent' is an actor role, not a surface; 'unknown'/undefined are
    // genuinely unknown. All collapse to 'unknown'.
    case 'subagent':
    case 'unknown':
    case undefined:
      return 'unknown';
  }
}

/**
 * Derive the actor role from the session's parent linkage. A non-null
 * `parentSessionId` means the session was forked as a subagent.
 */
export function deriveActor(parentSessionId: string | null | undefined): TraceActor {
  return parentSessionId == null ? 'main' : 'subagent';
}
