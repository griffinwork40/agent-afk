/**
 * Compact summary of per-root sweep failures for the daemon's PERSISTED
 * telemetry record.
 *
 * Invariant: `TelemetryRecord.errorMessage` must never enumerate absolute repo
 * paths. It is appended to the telemetry JSONL by a bare `appendFileSync` with
 * no mode argument, so the file takes the process umask and is world-readable
 * in practice — and it is additionally forwarded into a Telegram push body by
 * `formatTaskCompletion` in `src/cli/commands/daemon.ts`. The worktree root
 * registry deliberately writes its own file at 0o600 precisely because "the
 * absolute path of every repo the user works in" is sensitive
 * (`agent/worktree-root-registry.ts`), so folding that same list into
 * telemetry would defeat the protection one module away from where it is
 * declared. The operator still gets full paths through the UNPERSISTED
 * `warnings` array built alongside this at the call site — that is the
 * detailed channel; this is the durable, exportable one.
 *
 * Contract: `reason` must arrive ALREADY redacted (the caller runs
 * `redactInlineSecrets` once, in the sweep loop, and reuses the result for
 * both channels). This function never redacts, so a double pass over
 * already-redacted text is impossible by construction.
 *
 * @module agent/daemon/root-failure-summary
 */

import { basename } from 'node:path';

/**
 * Ceiling on the rendered summary.
 *
 * External constraint: every sibling telemetry write truncates — the
 * scheduler's own `responseExcerpt` at 280 chars, `MAX_ERROR_MESSAGE_CHARS` in
 * `agent/tools/subagent/failure-payload.ts` — and both readers clamp anyway
 * (`insights/aggregators/daemon.ts` at 500, `cli/commands/daemon.ts` at 400).
 * An unbounded join would grow with every registered root (up to MAX_ROOTS =
 * 64) on every tick for as long as the prune stays systemically broken,
 * writing bytes no consumer ever reads.
 */
export const MAX_ROOT_FAILURE_SUMMARY_CHARS = 500;

export interface RootFailure {
  /** Absolute repo root. Only its basename reaches the returned string. */
  repoRoot: string;
  /** Already-redacted failure text. */
  reason: string;
}

/**
 * Render `failures` as `"N root(s) failed sweep — <base>: <reason>; …"`,
 * truncated to {@link MAX_ROOT_FAILURE_SUMMARY_CHARS} with a trailing ellipsis.
 */
export function summarizeRootFailures(failures: readonly RootFailure[]): string {
  const joined = failures.map((f) => `${basename(f.repoRoot)}: ${f.reason}`).join('; ');
  const full = `${String(failures.length)} root(s) failed sweep — ${joined}`;
  return full.length <= MAX_ROOT_FAILURE_SUMMARY_CHARS
    ? full
    : `${full.slice(0, MAX_ROOT_FAILURE_SUMMARY_CHARS - 1)}…`;
}
