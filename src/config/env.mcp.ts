/**
 * MCP env vars — the `mcp` category of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling,
 * following the `env.browser.ts` precedent (#2206). `env.ts` spreads this
 * tuple into `ENV_REGISTRY` at the same position the entries used to occupy,
 * so registry order, the derived `EnvObject` / `EnvVarName` types, and the
 * rendered `docs/env-registry.*` are all unchanged.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.mcp
 */

import type { EnvVarMeta } from './env.js';

export const MCP_ENV_REGISTRY = [
  {
    name: 'AFK_MCP_HEALTHCHECK',
    description:
      'Enable an optional post-connect liveness probe that re-issues tools/list to every connected MCP ' +
      'server in parallel after the initial connect burst. OFF by default — the extra round-trip adds ' +
      'cold-start latency (issue #1751). Set to a truthy value (1/true/yes/on) to enable.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'mcp',
  },
  {
    name: 'AFK_ALLOW_PROJECT_MCP',
    description: 'Opt-in to loading + spawning MCP servers declared in <cwd>/.mcp.json. Fail-closed: when unset (or 0), project-local servers are NOT spawned; set to a truthy value (1/true/yes/on) to load them. A project-local .mcp.json spawns arbitrary commands on session start, so it is off by default to prevent code execution when entering an untrusted repo (issue #571). Skipped servers are listed in a startup warning with the opt-in instruction.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'mcp',
  },
] as const satisfies readonly EnvVarMeta[];
