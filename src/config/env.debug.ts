/**
 * Debug / diagnostics and process / runtime-convention env vars.
 * A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling.
 * `env.ts` spreads this tuple into `ENV_REGISTRY` at the appropriate position.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.debug
 */

import type { EnvVarMeta } from './env.js';

export const DEBUG_ENV_REGISTRY = [
  // ── Debug / diagnostics ───────────────────────────────────────────────────
  {
    name: 'AFK_DEBUG',
    description: 'Enable verbose debug logging across the codebase. Accepts 1 to enable.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_DEBUG_CLIPBOARD',
    description: 'Debug bracketed-paste and image-paste handling in the interactive REPL.',
    type: 'boolean',
    required: false,
    category: 'debug',
  },
  {
    name: 'AFK_DEBUG_COMPOSITOR',
    description: 'Gate compositor phase-boundary traces to stderr; any truthy value enables.',
    type: 'boolean',
    required: false,
    category: 'debug',
  },
  {
    name: 'AFK_TRACE_DISABLED',
    description: 'Disable the agent trace subsystem entirely. Set to 1 to skip trace file writes.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_WITNESS_RETENTION_DISABLE',
    description:
      'Disable the witness-tree retention sweep entirely, so no session directory is ever evicted.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_WITNESS_MAX_AGE_DAYS',
    description:
      'Evict a witness session directory once its newest content is older than this many days. Default 30.',
    type: 'number',
    required: false,
    default: '30',
    category: 'debug',
  },
  {
    name: 'AFK_WITNESS_MAX_BYTES',
    description:
      'Aggregate byte cap for the witness tree; oldest session directories are evicted first once exceeded. Default 2147483648 (2 GiB).',
    type: 'number',
    required: false,
    default: '2147483648',
    category: 'debug',
  },
  {
    name: 'AFK_SESSION_RETENTION_DISABLE',
    description:
      'Disable the session sidecar retention sweep entirely, so no state/sessions/*.json file is ever evicted.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_SESSION_MAX_AGE_DAYS',
    description:
      'Evict a session sidecar file once it is older than this many days (based on savedAt). Default 30.',
    type: 'number',
    required: false,
    default: '30',
    category: 'debug',
  },
  {
    name: 'AFK_SESSION_MAX_COUNT',
    description:
      'Count-based safety valve: evict oldest session sidecars first once the total exceeds this number. Default 1000.',
    type: 'number',
    required: false,
    default: '1000',
    category: 'debug',
  },
  {
    name: 'AFK_WAVE_MANIFEST_DISABLED',
    description:
      'Disable the wave manifest system entirely. When set to 1, no manifest is written ' +
      'for parallel subagent waves, and no resumption offer is made at session start.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_WAVE_MANIFEST_TTL_HOURS',
    description:
      'Time-to-live for wave manifests in hours. Manifests older than this are deleted ' +
      'on reconciliation and by the witness sweep. Default 48 (two days).',
    type: 'number',
    required: false,
    default: '48',
    example: '24',
    category: 'misc',
  },
  {
    name: 'AFK_WAVE_RESUME_UNATTENDED',
    description:
      'When set to 1, surface wave resumption offers even on non-interactive surfaces ' +
      '(daemon, one-shot chat). By default, offers are only made on interactive surfaces ' +
      '(REPL, Telegram).',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_RUN_RECEIPT_DISABLED',
    description:
      'Disable the post-session run receipt (state/receipts/<label>.json and .md). ' +
      'Set to 1 to skip receipt writes; the underlying witness trace is unaffected. ' +
      'Receipts are also implicitly off when AFK_TRACE_DISABLED=1 (no trace to summarize).',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_SUBAGENT_RESULT_CAP_BYTES',
    description:
      'Foreground subagent result size cap in bytes. When a subagent\'s final message exceeds ' +
      'this threshold, the full output is spilled to a sidecar file ' +
      '(state/sessions/<id>/subagent-handoffs/<subagentId>.txt) and the parent receives a ' +
      'head+tail slice with a read_file pointer. Prevents large subagent outputs from bloating ' +
      'parent context. Set to 0 to disable the cap entirely. Default 32768 (32KB). ' +
      'Note: sidecar files contain unredacted subagent output. No automatic GC covers subagent-handoffs/ today; ' +
      'retention is tied to session-directory cleanup.',
    type: 'number',
    required: false,
    default: '32768',
    example: '16384',
    category: 'model',
  },
  {
    name: 'AFK_SUBAGENT_LOG',
    description:
      'Opt-in per-subagent conversation log. Writes OutputEvent JSONL to ' +
      'state/subagent-logs/<sessionLabel>/<subagentId>.jsonl for both foreground and ' +
      'background subagents. Powers /tasks:view replay. OFF by default (raw tool arguments ' +
      'are written without redaction). Set to 1 to enable.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'DEBUG',
    description: 'Standard Node `debug`-package convention. When set to 1, enables verbose logging in several modules alongside AFK_DEBUG.',
    type: 'string',
    required: false,
    category: 'debug',
  },
  {
    name: 'AGENT_AFK_ASCII',
    description:
      'Force the interactive REPL tool-lane renderer to ASCII-only glyphs instead of the default Unicode box-drawing set. Accepts 1/true/yes (case-insensitive). Useful for terminals whose font lacks ┃├╰├ glyphs.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },

  // ── Process / runtime conventions ────────────────────────────────────────
  {
    name: 'AGENT_SURFACE',
    description:
      'Process-level surface identity propagated to subprocesses (e.g. Python plugin scripts) ' +
      'that cannot read the in-memory AgentConfig.surface field. The CLI entrypoint defaults it ' +
      "to 'afk' via ??=; no surface overrides it at runtime today, so the env var is effectively " +
      "a static 'afk' constant. Per-surface discrimination ('cli', 'telegram', 'daemon') lives " +
      'on AgentConfig.surface instead. The browser headless-routing check in ' +
      'src/browser/config.ts reads this as a secondary fallback after AFK_BROWSER_HEADLESS.',
    type: 'string',
    required: false,
    default: 'afk',
    example: 'afk',
    category: 'process',
  },
  {
    name: 'CI',
    description: 'Standard CI-detection convention. Auto-set by GitHub Actions, CircleCI, etc. Used to switch off TTY-only UX.',
    type: 'string',
    required: false,
    example: 'true',
    category: 'process',
  },
  {
    name: 'NODE_ENV',
    description: 'Standard Node environment marker. test | development | production. Used by routing-telemetry.ts to suppress test-time writes.',
    type: 'string',
    required: false,
    example: 'production',
    category: 'process',
  },
  {
    name: 'VITEST',
    description: 'Set automatically by Vitest. Used at runtime to short-circuit code paths that should not fire in tests.',
    type: 'string',
    required: false,
    category: 'process',
  },
  {
    name: 'NO_UPDATE_NOTIFIER',
    description: 'Disable the update-available notifier on CLI startup. Standard convention shared with many Node CLIs.',
    type: 'boolean',
    required: false,
    category: 'process',
  },
] as const satisfies readonly EnvVarMeta[];
