/**
 * Prompt-experiment env var: a contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted as a standalone sub-module following the env.whatif.ts /
 * env.continuation.ts precedent so `env.ts` stays within the 350-line ceiling.
 * `env.ts` spreads this tuple into `ENV_REGISTRY` in the "What-if / prompt
 * experiment" section, immediately after WHATIF_ENV_REGISTRY.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.prompt-experiment
 */

import type { EnvVarMeta } from './env.js';

export const PROMPT_EXPERIMENT_ENV_REGISTRY = [
  {
    name: 'AFK_PROMPT_EXPERIMENT',
    description:
      'Names the active prompt experiment (e.g. "narration-v2", "explore-rewrite"). ' +
      'When set, `isPromptExperimentActive(name)` returns true for the matching name ' +
      'and `getPromptVariant(name)` reads `AFK_PROMPT_EXPERIMENT_ARM` to assign the ' +
      'session to "control" or "treatment" (10 episodes per arm, matching the ' +
      'narration-directive A/B template — see docs/prompt-tuning-protocol.md). ' +
      'Unset or empty = no experiment active; all sessions see the default prompt. ' +
      'Use only with `afk whatif --env AFK_PROMPT_EXPERIMENT=<name> ' +
      '--env AFK_PROMPT_EXPERIMENT_ARM=control|treatment` for isolated episode runs — ' +
      'never set persistently in afk.env. ' +
      'See docs/prompt-tuning-protocol.md for the full gate-first protocol and hard ' +
      'veto list before using this var.',
    type: 'string',
    required: false,
    example: 'explore-rewrite',
    category: 'misc',
  },
  {
    name: 'AFK_PROMPT_EXPERIMENT_ARM',
    description:
      'Arm assignment for the active prompt experiment named by `AFK_PROMPT_EXPERIMENT`. ' +
      'Accepted values: "control" (baseline prompt, no changes) or "treatment" (candidate ' +
      'prompt variant). Must be set alongside `AFK_PROMPT_EXPERIMENT` — ignored when that ' +
      'var is unset. Unset or unrecognised value falls back to "control" so that a missing ' +
      'assignment never silently enrolls a session in treatment. ' +
      'Set one arm per `afk whatif` invocation; run 10 episodes per arm (matching the ' +
      'narration-directive A/B template). Never set persistently in afk.env.',
    type: 'string',
    required: false,
    example: 'treatment',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
