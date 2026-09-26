/**
 * What-if episode mode env vars: a contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling,
 * following the `env.browser.ts` / `env.display.ts` precedent (#2206). `env.ts`
 * spreads this tuple into `ENV_REGISTRY` at the same position the entries used
 * to occupy, so registry order, the derived `EnvObject` / `EnvVarName` types,
 * and the rendered `docs/env-registry.*` are all unchanged.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.whatif
 */

import type { EnvVarMeta } from './env.js';

export const WHATIF_ENV_REGISTRY = [
  {
    name: 'AFK_WHATIF_EPISODE',
    description:
      'When set to "1" or "true", the process is a sandboxed what-if episode. ' +
      'The episode gate (src/agent/whatif-episode-gate.ts) intercepts every PreToolUse ' +
      'call: read-only tools execute normally; the first side-effecting action is ' +
      'RECORDED as the decision but NOT executed. Episode processes are spawned by ' +
      '`afk whatif --verify` as isolated subprocesses with their own AFK_HOME / ' +
      'AFK_STATE_DIR pointing at the sandbox. Do not set this manually in production — ' +
      'it disables delegation, MCP (unless AFK_WHATIF_ALLOW_MCP=1), and all write tools.',
    type: 'boolean',
    required: false,
    default: '',
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_WHATIF_TOOL_LOG',
    description:
      'Absolute path of a JSONL file the episode gate appends every tool request to ' +
      '(one JSON line per call). Each line has the shape ' +
      '`{"ts":<ms>,"tool":<name>,"input":<raw input>,"verdict":"executed"|"recorded","subagent":<bool>}`. ' +
      'Ignored when AFK_WHATIF_EPISODE is not set. The file is created if absent; ' +
      'write errors are swallowed so a full disk never disrupts tool execution.',
    type: 'string',
    required: false,
    example: '/tmp/whatif-run-abc123/tool-log.jsonl',
    category: 'misc',
  },
  {
    name: 'AFK_WHATIF_ALLOW_MCP',
    description:
      'When set to "1" or "true" inside a what-if episode (AFK_WHATIF_EPISODE=1), ' +
      'keep MCP servers enabled. By default, MCP servers are disabled inside episodes ' +
      'to prevent side effects from spawning external processes. Set this flag only ' +
      'when the change under test specifically concerns MCP server behaviour.',
    type: 'boolean',
    required: false,
    default: '',
    example: '1',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
