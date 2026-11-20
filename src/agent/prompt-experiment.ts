/**
 * Prompt-experiment helpers: env-flag-gated A/B protocol for prompt tuning.
 *
 * ## Why this exists
 *
 * `system-prompt.md` propagates to every session simultaneously with no
 * rollback signal. Five cache-breakage incidents in 30 days (PRs #4217,
 * #3923, #4072, #4198, #4372) demonstrated that the assembly pipeline is
 * fragile to ordering and content changes. This module formalises the
 * gate-first prompt-tuning protocol described in
 * `docs/prompt-tuning-protocol.md`, providing the runtime helpers that
 * callers use to branch on an active experiment.
 *
 * ## Usage
 *
 * ```ts
 * import { isPromptExperimentActive, getPromptVariant } from './prompt-experiment.js';
 *
 * if (isPromptExperimentActive('explore-rewrite')) {
 *   const arm = getPromptVariant('explore-rewrite');
 *   // arm === 'control' | 'treatment'
 * }
 * ```
 *
 * ## Episode-based rollout (narration-directive A/B template)
 *
 * Assignment mirrors the narration-directive A/B template
 * (`narration-directive.ts:17-24`, measured 2026-09-27): 10 episodes per arm.
 * Each `afk whatif` invocation is a separate process; the caller sets
 * `AFK_PROMPT_EXPERIMENT_ARM=control` or `=treatment` explicitly so that arm
 * assignment is unambiguous and auditable in the whatif run log.
 *
 * Typical invocation (put both vars in a spec file; a single `--verify` run
 * is already an A/B comparison — baseline=control, candidate=treatment):
 * ```json
 * {
 *   "title": "explore-rewrite treatment",
 *   "changes": [
 *     { "kind": "env", "key": "AFK_PROMPT_EXPERIMENT", "value": "explore-rewrite" },
 *     { "kind": "env", "key": "AFK_PROMPT_EXPERIMENT_ARM", "value": "treatment" }
 *   ]
 * }
 * ```
 * ```sh
 * afk whatif --spec explore-rewrite.json --verify --yes --samples 10
 * ```
 *
 * ## Hard veto list
 *
 * The following dimensions MUST NOT be varied through this protocol —
 * see `docs/prompt-tuning-protocol.md § Hard veto list` for rationale:
 *   - Assembly order of system-prompt blocks
 *   - Vendored / third-party file content
 *   - Byte-equality pins (cache-breakage sentinel sections)
 *   - Routing-directive gates (tool-allow / tool-deny directives)
 *   - Runtime-numbers section (token budgets, limits, timeouts)
 *
 * @module agent/prompt-experiment
 */

import { env } from '../config/env.js';

/**
 * ## Wiring status
 *
 * `isPromptExperimentActive` and `getPromptVariant` have no production callers
 * yet: the prompt-assembly path (`src/agent/providers/anthropic-direct/query/
 * prompt-assembly.ts`) does not branch on them. This is intentional — the
 * protocol landed ahead of its first consumer (issue #4450, closed by #4468).
 *
 * The first consumer should import these helpers inside the system-prompt
 * assembly step and gate the variant text on `isPromptExperimentActive(name)`.
 * Until then, all sessions see the default prompt regardless of whether
 * `AFK_PROMPT_EXPERIMENT` is set.
 */

/**
 * Returns true when `AFK_PROMPT_EXPERIMENT` is set to `name` (exact,
 * case-sensitive match). False if the var is unset, empty, or names a
 * different experiment.
 *
 * Call sites gate prompt-variant branches on this predicate so that only one
 * experiment is active at a time and unrelated code paths are unaffected.
 */
export function isPromptExperimentActive(name: string): boolean {
  if (!name.trim()) return false;
  const active = env.AFK_PROMPT_EXPERIMENT;
  return typeof active === 'string' && active.trim() === name.trim();
}

/**
 * Returns the arm assignment ('control' | 'treatment') for the named
 * experiment, reading `AFK_PROMPT_EXPERIMENT_ARM`.
 *
 * Always returns 'control' when:
 *   - The named experiment is not active (`AFK_PROMPT_EXPERIMENT` doesn't match).
 *   - `AFK_PROMPT_EXPERIMENT_ARM` is unset, empty, or not 'treatment'.
 *
 * This fail-safe default guarantees that a missing or misconfigured arm
 * assignment never silently enrolls a session in treatment.
 *
 * @param name - Experiment name; must match `AFK_PROMPT_EXPERIMENT` exactly.
 * @returns 'control' | 'treatment'
 */
export function getPromptVariant(name: string): 'control' | 'treatment' {
  if (!isPromptExperimentActive(name)) return 'control';

  const arm = env.AFK_PROMPT_EXPERIMENT_ARM;
  if (typeof arm === 'string' && arm.trim().toLowerCase() === 'treatment') return 'treatment';

  return 'control';
}
