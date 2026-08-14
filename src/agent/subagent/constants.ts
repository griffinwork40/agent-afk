/**
 * Default budgets and shared constants for forked subagents.
 *
 * Extracted verbatim from `../subagent.ts` (#829) to keep that module focused
 * on the `SubagentManager` class. Every symbol here is re-exported from
 * `../subagent.ts`, so this move is invisible to existing importers.
 *
 * @module agent/subagent/constants
 */

import type { AgentConfig } from '../types.js';
import type { ElicitationRequest, ElicitationResult } from '../types/sdk-types.js';
import { env } from '../../config/env.js';

// External constraint: backgrounded subagents have no surface to serve
// elicitations — auto-decline prevents silent hangs.
// Exported so it can be wired into forkSubagent's background-mode path by callers.
export const DENY_ELICITATION: NonNullable<AgentConfig['onElicitation']> = async (
  _request: ElicitationRequest,
  _options: { signal: AbortSignal },
): Promise<ElicitationResult> => ({ action: 'decline' });

/**
 * Default tool-use-iteration ceiling applied to every forked subagent.
 *
 * A subagent runs exactly one conversation turn (one `sendMessageStream`), so
 * this bounds the tool-use loop WITHIN that turn. anthropic-direct otherwise
 * defaults to `0` (unbounded — see DEFAULT_MAX_TOOL_USE_ITERATIONS), which lets
 * a runaway child spin indefinitely while its parent is suspended at
 * `await runToResult`. `50` matches openai-compatible's built-in cap so both
 * providers bound child loops identically. Hitting the cap surfaces as a
 * `tool_use_loop_capped` done (not an error), returning the child's partial
 * work. Callers may override per-fork via `config.maxToolUseIterations` (e.g.
 * `0` to opt a trusted deep-investigation child back into unbounded mode).
 */
export const SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS = 50;

/**
 * Default wall-clock budget applied to every forked subagent turn.
 *
 * `DEFAULT_SESSION_TIMEOUT_MS` is `0` (unbounded), which is correct for
 * top-level sessions — a human owns them — but not for forks: a child stalled
 * by provider throttling, a wedged stream, or a slow-grinding tool loop parks
 * its parent at `await runToResult` indefinitely (observed 2026-07-07: four
 * parallel children spun 29 minutes under a 429 cascade until the operator
 * manually cancelled). The tool-iteration cap above bounds ROUNDS but not
 * TIME — throttled rounds can each take minutes. On expiry `withTimeout`
 * aborts the child's controller, cascading through the AbortGraph to its
 * descendants, and the parent receives a legible TimeoutError tool_result
 * instead of hanging.
 *
 * 45 minutes (raised from an earlier 20 min): the 20-min cap was a BLUNT wall
 * that guillotined genuinely-working read-only research/review children —
 * `/review`'s `research-agent` (which nests `git-investigator`) does continuous
 * grep/read archaeology that legitimately exceeds 20 min on a large diff, so a
 * healthy child was being killed mid-work rather than a hung one relieved.
 * 45 min gives real headroom over the longest healthy child observed while
 * still guaranteeing every fork terminates. Operators can tune per-environment
 * via `AFK_SUBAGENT_TIMEOUT_MS` (see {@link resolveSubagentTimeoutMs}); callers
 * may override per-fork via `config.timeoutMs` (`0` restores unbounded).
 *
 * NOTE: a follow-up will add a progress-aware idle watchdog (reset the budget
 * on observable child progress) so an ACTIVELY-working child is never cut off
 * regardless of total wall-clock; this raised blunt cap is the interim relief.
 */
export const SUBAGENT_DEFAULT_TIMEOUT_MS = 45 * 60_000;

/**
 * Resolve the foreground forked-subagent wall-clock budget from
 * `AFK_SUBAGENT_TIMEOUT_MS`.
 *
 * Mirrors {@link resolveTtfbTimeoutMs}: returns the parsed value when it is a
 * finite integer `>= 0`. A value of `0` is the explicit disable escape hatch
 * (returned as `0` = unbounded). Unset, empty, or unparseable input falls back
 * to {@link SUBAGENT_DEFAULT_TIMEOUT_MS}; negative values are treated as invalid
 * and also fall back to the default.
 *
 * Only consulted for the DEFAULT budget: an explicit per-fork `config.timeoutMs`
 * (including the background {@link SUBAGENT_BACKGROUND_TIMEOUT_MS} set by the
 * SubagentExecutor) still wins via the `??` at the fork site.
 */
export function resolveSubagentTimeoutMs(): number {
  const raw = env.AFK_SUBAGENT_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return SUBAGENT_DEFAULT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return SUBAGENT_DEFAULT_TIMEOUT_MS;
  return n;
}

/**
 * Default progress-aware IDLE budget applied to every forked subagent turn.
 *
 * Distinct from {@link SUBAGENT_DEFAULT_TIMEOUT_MS} (the 45-min blunt
 * wall-clock that bounds total turn TIME): this bounds time since the child last
 * produced an observable `OutputEvent`. The incident that motivated it — a
 * `/review` run that hung ~43 min producing zero output — was a subagent's model
 * call stalling under HTTP 429 / provider throttling with NO detection: round
 * caps bound *work done*, wall-clock bounds *time elapsed*, and neither bounds
 * *time since anything observable happened*. The idle watchdog (see
 * {@link import('./subagent/idle-watchdog.js').IdleWatchdog}) fires materially
 * sooner than the wall-clock on a genuine stall and never fires while the stream
 * is legitimately parked on a provider-communicated backoff (OAuth `paused`,
 * `rate_limit` with `retryAfterMs`).
 *
 * 8 minutes: a companion follow-up SPLITS OUT the transient-429 stream signal
 * (the `retry-layer.ts` change that would make a transient backoff wait a
 * visible, deadline-extending stream event). Until it lands, THIS watchdog is
 * blind to the retry-layer's transient backoff. The verified worst case there is
 * `RATE_LIMIT_TRANSIENT_MAX_RETRIES (3)` × `RATE_LIMIT_RETRY_MAX_WAIT_MS (120s)`
 * + jitter ≈ 363s of legitimate near-silence; an 8-min (480s) default clears
 * that with ~2 min margin, so a transient backoff can never false-fire the
 * watchdog, while it is still 5.6× tighter than the wall-clock. Once the
 * follow-up lands the default can tighten toward ~5 min. Env-tunable via
 * `AFK_SUBAGENT_IDLE_TIMEOUT_MS` (see {@link resolveSubagentIdleTimeoutMs});
 * per-fork override via `config.idleTimeoutMs`; `0` disables the watchdog (the
 * wall-clock still applies).
 */
export const SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS = 8 * 60_000;

/**
 * Resolve the forked-subagent idle-watchdog budget from
 * `AFK_SUBAGENT_IDLE_TIMEOUT_MS`.
 *
 * Mirrors {@link resolveSubagentTimeoutMs} byte-for-byte: returns the parsed
 * value when it is a finite integer `>= 0`. A value of `0` is the explicit
 * disable escape hatch (returned as `0` = watchdog off). Unset, empty, or
 * unparseable input falls back to {@link SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS};
 * negative values are treated as invalid and also fall back to the default.
 *
 * Only consulted for the DEFAULT budget: an explicit per-fork
 * `config.idleTimeoutMs` still wins via the `??` at the fork site.
 */
export function resolveSubagentIdleTimeoutMs(): number {
  const raw = env.AFK_SUBAGENT_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return SUBAGENT_DEFAULT_IDLE_TIMEOUT_MS;
  return n;
}

/**
 * Wall-clock budget for BACKGROUND-mode agent dispatches (fire-and-forget
 * jobs whose results auto-deliver later). Background children don't park
 * their parent, so the anti-hang pressure is lower — but an unbounded
 * detached child is still a zombie token-burner when it wedges. 60 minutes
 * keeps documented "long investigations" viable at 3× the foreground budget
 * while guaranteeing every fork terminates. Applied by SubagentExecutor
 * before forking (background mode is executor-level knowledge the manager
 * doesn't have); explicit `config.timeoutMs` wins, `0` = unbounded.
 */
export const SUBAGENT_BACKGROUND_TIMEOUT_MS = 60 * 60_000;

/**
 * Bound on how long the owner waits for in-flight children's terminal trace
 * rows after cascade-aborting them, before sealing the writer anyway.
 *
 * Mirrors `CANCEL_DRAIN_TIMEOUT_MS` in background-registry.ts, which solves
 * the identical problem for background jobs. The bound is mandatory, not
 * defensive: without it a single wedged child converts "parent finished" into
 * "parent hangs on close" (#733).
 */
export const SUBAGENT_DRAIN_TIMEOUT_MS = 5000;
