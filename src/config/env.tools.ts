/**
 * Tool-behaviour env vars — post-edit LSP diagnostics (phase 1 of #3904) and
 * future per-tool opt-ins. A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted as a new sub-module so `env.ts` stays within the 350-code-line
 * ceiling. `env.ts` spreads this tuple into `ENV_REGISTRY`.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.tools
 */

import type { EnvVarMeta } from './env.js';

export const TOOLS_ENV_REGISTRY = [
  // ── Post-edit LSP diagnostics (#3904 phase 1) ────────────────────────────
  {
    name: 'AFK_LSP_DIAGNOSTICS',
    description:
      'Enable opt-in LSP features (#3904). When set to 1: ' +
      '(phase 1) after every successful edit_file or write_file call the handler queries ' +
      'typescript-language-server (must be on PATH) for diagnostics on the touched ' +
      'file and appends any errors/warnings to the tool result; ' +
      '(phase 2) enables the code_symbols tool for go-to-definition and find-references. ' +
      'Off by default. A missing or slow server never fails or stalls the edit — ' +
      'the query times out silently. TypeScript / JavaScript only in this phase.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_LSP_DIAGNOSTICS_TIMEOUT_MS',
    description:
      'Hard timeout in milliseconds for the post-edit LSP diagnostics query ' +
      '(AFK_LSP_DIAGNOSTICS=1). If the language server does not respond within ' +
      'this window the query is abandoned silently and the edit result is ' +
      'unchanged. Default 1500 (1.5 s) — intentionally low so a slow server ' +
      'does not stall every edit; raise when diagnostics are valuable enough ' +
      'to wait for.',
    type: 'number',
    required: false,
    default: '1500',
    example: '3000',
    category: 'misc',
  },
  {
    name: 'AFK_LSP_SYMBOLS_TIMEOUT_MS',
    description:
      'Hard timeout in milliseconds for code_symbols (go-to-definition / ' +
      'find-references) LSP queries (AFK_LSP_DIAGNOSTICS=1). Symbol queries ' +
      'can require a cold-start index build and therefore need a longer budget ' +
      'than the post-edit diagnostics timeout (AFK_LSP_DIAGNOSTICS_TIMEOUT_MS). ' +
      'Default 5000 (5 s). Raise for large monorepos where the first query ' +
      'triggers a full project load.',
    type: 'number',
    required: false,
    default: '5000',
    example: '10000',
    category: 'misc',
  },
  {
    name: 'AFK_LSP_IDLE_SHUTDOWN_MS',
    description:
      'Idle window in milliseconds after which a pooled (persistent) language ' +
      'server with no requests is shut down (#4272). Servers are kept warm per ' +
      'workspace root and language so repeat LSP queries skip the cold start. ' +
      'Default 300000 (5 min). Idle timers never keep the process alive.',
    type: 'number',
    required: false,
    default: '300000',
    example: '60000',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
