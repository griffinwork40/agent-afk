/**
 * Provider-neutral overload-pause timing helpers.
 *
 * These constants and functions are shared by both the Anthropic-direct and the
 * OpenAI-compatible overload-pause tiers. Keeping them here prevents the
 * openai-compatible tier from importing across the provider boundary into
 * `anthropic-direct/overload-pause.ts`.
 *
 * The anthropic-direct module re-exports everything from here so existing
 * `from '…/anthropic-direct/overload-pause.js'` import sites continue to work
 * without change.
 *
 * @module agent/providers/shared/overload-pause-shared
 */

import { env } from '../../../config/env.js';

/** Default wall-clock pause ceiling on an interactive surface (repl/cli/telegram). */
export const OVERLOAD_PAUSE_CEILING_MS = 10 * 60 * 1000;

/**
 * Hard upper bound on an operator-supplied `AFK_OVERLOAD_PAUSE_MS`, matching the
 * 2-hour worst case of the usage-limit park. Without it a typo
 * (`AFK_OVERLOAD_PAUSE_MS=99999999999`) parks ANY surface — a daemon included —
 * for years on an upstream capacity blip, which is precisely the silent
 * always-on hang the surface gate exists to prevent.
 */
export const OVERLOAD_PAUSE_MAX_MS = 2 * 60 * 60 * 1000;

/**
 * Probe cadence bounds. A 529 carries **no reset timestamp**, so unlike
 * `waitForReset` there is no authoritative deadline to key on — the only honest
 * strategy is to re-probe on a jittered interval until the plain wall-clock
 * ceiling. Jittered across a wide band so parallel sessions/subagents that all
 * hit the same capacity event de-synchronize instead of re-hammering in lockstep.
 */
export const OVERLOAD_PROBE_MIN_MS = 60 * 1000;
export const OVERLOAD_PROBE_MAX_MS = 120 * 1000;

/**
 * Fraction of the base backoff used as jitter width for the in-loop overload
 * ladder.
 */
const OVERLOAD_JITTER_RATIO = 0.25;

/**
 * Add proportional jitter to a backoff delay: returns `baseMs` plus a random
 * 0–25% of `baseMs`. Additive-only (never shortens the base wait).
 *
 * @param baseMs Deterministic backoff for this attempt.
 * @param random Injectable RNG for deterministic tests. Defaults to `Math.random`.
 */
export function jitterBackoff(baseMs: number, random: () => number = Math.random): number {
  return baseMs + Math.floor(random() * baseMs * OVERLOAD_JITTER_RATIO);
}

/**
 * Pick the next probe delay: a uniform draw from
 * [{@link OVERLOAD_PROBE_MIN_MS}, {@link OVERLOAD_PROBE_MAX_MS}].
 *
 * @param random Injectable RNG for deterministic tests.
 */
export function nextProbeDelayMs(random: () => number = Math.random): number {
  const span = OVERLOAD_PROBE_MAX_MS - OVERLOAD_PROBE_MIN_MS;
  return OVERLOAD_PROBE_MIN_MS + Math.floor(random() * span);
}

/** Surfaces on which parking on an upstream capacity event is acceptable. */
const INTERACTIVE_SURFACES = new Set(['cli', 'repl', 'telegram', 'web']);

/**
 * Resolve the wall-clock pause ceiling for a surface.
 *
 * Invariant: a daemon/cron session must NEVER park on a capacity event. An
 * always-on runner that silently parks is strictly worse than one that fails and
 * notifies — the operator has no ESC to press and no panel to read, and two
 * sessions in the #762 incident already hung 38 and 63 minutes with no terminal
 * event. So non-interactive surfaces default to `0` (fail fast) and must be
 * opted in deliberately via `AFK_OVERLOAD_PAUSE_MS`.
 *
 * `AFK_OVERLOAD_PAUSE_MS` overrides BOTH the gate and the ceiling for every
 * surface: `0` disables the pause everywhere (pure fail-fast, the pre-#762
 * timing minus the fatal closure), a positive integer enables it with that
 * ceiling in milliseconds. A non-numeric or negative value is ignored, and an
 * over-large one is clamped to {@link OVERLOAD_PAUSE_MAX_MS}.
 *
 * @param surface `AgentConfig.surface` as plumbed through the provider
 *                (`index.ts` → `query.ts` → `RetryLayer`). `undefined` is
 *                treated as non-interactive.
 * @returns Ceiling in ms; `0` means "do not pause, surface the terminal now".
 */
export function resolveOverloadPauseCeilingMs(surface: string | undefined): number {
  const raw = env.AFK_OVERLOAD_PAUSE_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(Math.floor(parsed), OVERLOAD_PAUSE_MAX_MS);
    }
  }
  return surface !== undefined && INTERACTIVE_SURFACES.has(surface)
    ? OVERLOAD_PAUSE_CEILING_MS
    : 0;
}
