/**
 * AFK home / state-tier path overrides. A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within its file-size baseline,
 * following the `env.browser.ts` / `env.display.ts` precedent (#2206). `env.ts`
 * spreads this tuple into `ENV_REGISTRY` at the same position the entries used
 * to occupy, so registry order, the derived `EnvObject` / `EnvVarName` types,
 * and the rendered `docs/env-registry.*` are all unchanged.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.paths
 */

import type { EnvVarMeta } from './env.js';

export const PATHS_ENV_REGISTRY = [
  {
    name: 'AFK_HOME',
    description: 'Override the AFK home directory. Default: ~/.afk/.',
    type: 'string',
    required: false,
    default: '~/.afk',
    example: '/opt/afk',
    category: 'paths',
  },
  {
    name: 'AFK_STATE_DIR',
    description: 'Override the entire AFK state tier (sessions/, todos/, transcripts/, memory/, daemon/, etc.), not just one subdirectory. Must be an absolute path (not /). Default: $AFK_HOME/state/.',
    type: 'string',
    required: false,
    category: 'paths',
  },
  {
    name: 'AFK_FRAMEWORK_DIR',
    description: 'Override the AFK agent-framework directory used for telemetry and briefs. Default: $AFK_HOME/agent-framework/.',
    type: 'string',
    required: false,
    category: 'paths',
  },
  {
    name: 'AFK_COMPANION_PRIMER',
    description: 'Opt-in: absolute path to a single companion-primer file. When set, its content is bounded (capped, fenced as <companion-primer>) and appended to the system prompt at session start for top-level sessions (chat/REPL/telegram/daemon), as lower-authority "reflections, not facts" context. Unset (default) = no-op. Only the one named file is ever read — never a directory or repo walk.',
    type: 'string',
    required: false,
    example: '/Users/me/Projects/afk-companion/PRIMER.md',
    category: 'paths',
  },
] as const satisfies readonly EnvVarMeta[];
