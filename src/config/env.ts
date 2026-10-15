/**
 * Centralized environment-variable registry and read-point.
 *
 * Every `process.env[...]` access in `src/` outside this file is a CI failure
 * (enforced by `scripts/audit-env-access.ts`, gated in `.github/workflows/ci.yml`).
 * The audit script maintains a tiny allowlist for legitimate dynamic-access call
 * sites (envvar loops, child-process env forwarding); see `AUDIT_ALLOWLIST` in
 * that script for the canonical list with rationale.
 *
 * ## Why this exists
 *
 * `agent-afk` reads ~70 distinct env vars across ~50 files. Before this module
 * landed, those reads were scattered raw `process.env['AFK_X']` calls with no
 * source of truth, no machine-readable catalogue, and no path to runtime
 * validation. This module fixes all three at once:
 *
 *   - `env` object: typed lazy getters, one per var. `env.AFK_MODEL` replaces
 *     `process.env['AFK_MODEL']` at every call site.
 *   - `ENV_REGISTRY`: typed metadata array consumed by `pnpm scan:env` (renders
 *     `docs/env-registry.{json,md}`) and `/doctor` (warns on missing required
 *     vars at startup).
 *   - Audit gate: CI fails if a new direct `process.env` read sneaks in.
 *
 * ## Lazy getters, raw strings
 *
 * Getters re-read `process.env` on every access — no caching layer. Two reasons:
 *
 *   1. Tests mutate `process.env` per-case via `beforeEach`. Eager constants
 *      would freeze test state at import time.
 *   2. `dotenv` loads inside `loadConfig()`, which runs AFTER module import.
 *      Eager reads would see undefined for any var sourced from `~/.afk/config/afk.env`.
 *
 * Getters return raw `string | undefined`. Parsing (`parseInt`, `=== '1'`, etc.)
 * stays at call sites for now — this keeps migration purely mechanical. A future
 * refactor can wrap each getter in a zod schema; that's a single-file change
 * here and orthogonal to call-site code.
 *
 * ## Adding a new env var
 *
 *   1. Add an entry to `ENV_REGISTRY` — name, description, type, required, etc.
 *   2. Run `pnpm scan:env` to regenerate `docs/env-registry.{json,md}`.
 *
 * The `env` object is generated dynamically from `ENV_REGISTRY` at module load
 * time (see the `Object.defineProperty` loop below), so no manual getter is
 * needed. The `EnvObject` mapped type and `EnvVarName` union are derived from
 * the registry, preserving full autocomplete and `tsc --noEmit` type safety.
 */

import { AUTH_ENV_REGISTRY } from './env.auth.js';
import { BROWSER_ENV_REGISTRY } from './env.browser.js';
import { DAEMON_ENV_REGISTRY } from './env.daemon.js';
import { DEBUG_ENV_REGISTRY } from './env.debug.js';
import { DISPLAY_ENV_REGISTRY } from './env.display.js';
import { HOOKS_ENV_REGISTRY } from './env.hooks.js';
import { MCP_ENV_REGISTRY } from './env.mcp.js';
import { MISC_ENV_REGISTRY } from './env.misc.js';
import { MODEL_ENV_REGISTRY } from './env.model.js';
import { MODEL_TIERS_ENV_REGISTRY } from './env.model-tiers.js';
import { PATHS_ENV_REGISTRY } from './env.paths.js';
import { PEER_ENV_REGISTRY } from './env.peer.js';
import { TELEGRAM_ENV_REGISTRY } from './env.telegram.js';
import { UI_ENV_REGISTRY } from './env.ui.js';
import { WHATIF_ENV_REGISTRY } from './env.whatif.js';
import { SESSION_STORAGE_ENV_REGISTRY } from './env.session-storage.js';
import { MEMORY_GC_ENV_REGISTRY } from './env.memory-gc.js';
import { VITALS_ENV_REGISTRY } from './env.vitals.js';

export type EnvVarType = 'string' | 'number' | 'boolean' | 'json';

export type EnvVarCategory =
  | 'model'
  | 'auth'
  | 'telegram'
  | 'paths'
  | 'debug'
  | 'daemon'
  | 'worktree'
  | 'mcp'
  | 'routing'
  | 'browser'
  | 'process'
  | 'display'
  | 'misc';

export interface EnvVarMeta {
  readonly name: string;
  readonly description: string;
  readonly type: EnvVarType;
  readonly required: boolean;
  readonly default?: string;
  readonly example?: string;
  readonly category: EnvVarCategory;
  /**
   * When true, the var is read but no human-authored description exists yet.
   * Surfaced in `/doctor` and registry docs so contributors can backfill.
   */
  readonly describedTodo?: boolean;
  /**
   * When true, this var holds a credential (API key, bearer token, OAuth token).
   * Two enforcement effects:
   *   1. The corresponding getter on `env` is defined non-enumerable, so
   *      `JSON.stringify(env)`, `console.log(env)`, `Object.keys(env)`, and
   *      `for...in env` do NOT surface the value. Direct access (`env.X`)
   *      still works — this only blocks accidental serialization.
   *   2. Renderers MUST NOT publish an `example` value for secret entries —
   *      credential-format strings committed to git survive history forever
   *      and trigger downstream secret scanners.
   */
  readonly secret?: boolean;
}

/**
 * Canonical catalogue of every env var the runtime reads. Sorted alphabetically
 * by `name` to keep diffs readable. Mirror order in the `env` object below so
 * the file is easy to navigate by name.
 *
 * `describedTodo: true` marks entries that need a human-written description.
 * Backfill them as you touch the relevant code path.
 *
 * Registry entries live in env.*.ts sub-modules (extracted for the 350-line
 * ceiling). Each sub-module is spread into this array at the position the
 * entries used to occupy, so registry order, the derived `EnvObject` /
 * `EnvVarName` types, and the rendered `docs/env-registry.*` are all unchanged.
 */
export const ENV_REGISTRY = [
  // ── Model / agent runtime ─────────────────────────────────────────────────
  // Core compaction / limits / scheduling (env.model.ts)
  ...MODEL_ENV_REGISTRY,
  // Model tiers, timeouts, suggestions, legacy aliases (env.model-tiers.ts)
  ...MODEL_TIERS_ENV_REGISTRY,
  // Memory GC env vars (env.memory-gc.ts)
  ...MEMORY_GC_ENV_REGISTRY,

  // ── System prompt / Auth / Image generation (env.auth.ts) ─────────────────
  ...AUTH_ENV_REGISTRY,

  // ── Telegram (env.telegram.ts) ────────────────────────────────────────────
  ...TELEGRAM_ENV_REGISTRY,
  // Peer-messaging env vars (env.peer.ts)
  ...PEER_ENV_REGISTRY,

  // ── Paths / state ─────────────────────────────────────────────────────────
  // AFK home/state-tier path overrides + OS path conventions (env.paths.ts)
  ...PATHS_ENV_REGISTRY,

  // ── Daemon / Web UI / Worktree / Routing / Bash preview (env.daemon.ts) ───
  ...DAEMON_ENV_REGISTRY,

  // ── MCP ───────────────────────────────────────────────────────────────────
  // Entries live in env.mcp.ts (extracted for the 350-line ceiling).
  ...MCP_ENV_REGISTRY,

  // ── UI / output (env.ui.ts) ────────────────────────────────────────────────
  ...UI_ENV_REGISTRY,
  // Entries live in env.display.ts (text measure, centering, smoke text;
  // extracted for the 350-line ceiling).
  ...DISPLAY_ENV_REGISTRY,

  // ── Debug / diagnostics / process conventions (env.debug.ts) ──────────────
  ...DEBUG_ENV_REGISTRY,
  // Entries live in env.session-storage.ts (extracted for the 350-line ceiling).
  ...SESSION_STORAGE_ENV_REGISTRY,

  // ── Browser-control tools ────────────────────────────────────────────────
  // Entries live in env.browser.ts (extracted for the 350-line ceiling, #2206).
  ...BROWSER_ENV_REGISTRY,

  // ── What-if episode mode ──────────────────────────────────────────────────
  // Entries live in env.whatif.ts (extracted for the 350-line ceiling).
  ...WHATIF_ENV_REGISTRY,

  // ── Filesystem / Rate-limit / Web egress / CLI / Session / Shell (env.misc.ts)
  ...MISC_ENV_REGISTRY,

  // ── Hook feature flags (env.hooks.ts) ────────────────────────────────────
  ...HOOKS_ENV_REGISTRY,

  // ── Per-round vitals harness note (env.vitals.ts) ────────────────────────
  ...VITALS_ENV_REGISTRY,
] as const satisfies readonly EnvVarMeta[];

/**
 * Typed map of every registered env var name to `string | undefined`.
 * Secret entries are non-enumerable (see secret-hardening below).
 *
 * Derived directly from `ENV_REGISTRY` so adding a new env var is a
 * **one-step change**: add an entry to `ENV_REGISTRY`; the getter,
 * type, and secret-hardening are all generated automatically.
 */
export type EnvObject = { readonly [K in (typeof ENV_REGISTRY)[number]['name']]: string | undefined };

/**
 * Single read-point for every env var the runtime touches. One lazy getter
 * per registry entry — derived dynamically from `ENV_REGISTRY`. Reads
 * `process.env` on every access (no caching; tests mutate `process.env`
 * per-case, and dotenv loads AFTER module import).
 *
 * Migration: every `process.env['X']` outside `src/config/env.ts` should be
 * `env.X`. CI enforces via `pnpm audit:env:check`.
 *
 * Secret entries (`entry.secret === true`) are made non-enumerable so that
 * `Object.keys(env)`, `for...in env`, and `JSON.stringify(env)` do NOT
 * surface credentials. Direct property access (`env.ANTHROPIC_API_KEY`) is
 * unaffected — non-enumerable blocks accidental serialization only.
 *
 * ## Adding a new env var
 *   1. Add an entry to `ENV_REGISTRY` above (name, description, type, …).
 *   2. Run `pnpm scan:env` to regenerate `docs/env-registry.{json,md}`.
 *   That's it — no manual getter needed.
 */
const _envBase = {} as EnvObject;
const _seenEnvNames = new Set<string>();
for (const _entry of ENV_REGISTRY) {
  const _name = _entry.name; // close over name for the getter
  // Invariant: three cross-cutting rules that hold for every iteration of this
  // loop. Violating any of them silently corrupts the runtime env object in
  // ways that are very hard to debug — no TypeScript error fires, no test
  // catches it without a targeted assertion, and the damage only surfaces at
  // call-site reads (wrong value, leaked credential, broken predicate).
  //
  // 1. UNIQUENESS — configurable:true means a second defineProperty call for
  //    the same name SILENTLY REPLACES the first getter. If two registry entries
  //    share a name the earlier one disappears with no error. The _seenEnvNames
  //    Set below turns that silent replacement into a loud module-load Error so
  //    a duplicate is caught at import time in every test and prod run, not
  //    discovered later when a call site returns the wrong value.
  //
  // 2. SECRET → NON-ENUMERABLE coupling — entry.secret === true MUST produce
  //    enumerable:false. If the expression is wrong (e.g. inverted), secret vars
  //    appear in Object.keys(env), JSON.stringify(env), and for..in env, leaking
  //    API keys into logs, debug dumps, and serialized config snapshots. The
  //    current expression is !('secret' in _entry && _entry.secret), which is
  //    false (non-enumerable) for secret entries and true (enumerable) for all
  //    others. Never simplify this to a boolean cast without re-verifying the
  //    polarity — the semantics are: secret=true → hidden from enumeration.
  //
  // 3. isPlainOutputRequested() coupling — the exported isPlainOutputRequested()
  //    function reads env.AFK_PLAIN_OUTPUT by name. If AFK_PLAIN_OUTPUT is ever
  //    renamed in ENV_REGISTRY without updating that function's string literal,
  //    the function silently returns false for every call site (TTY sessions that
  //    set AFK_PLAIN_OUTPUT=1 never enter plain-output mode). The three render
  //    sites that gate on it (repl-renderer.ts, input-surface.ts,
  //    stream-renderer.ts) all fail open (normal overlay mode) with no error.
  //    Keep the name 'AFK_PLAIN_OUTPUT' in sync with the function literal.
  if (_seenEnvNames.has(_name)) {
    throw new Error(`env.ts: duplicate ENV_REGISTRY entry for '${_name}' — configurable:true would silently replace the first getter`);
  }
  _seenEnvNames.add(_name);
  Object.defineProperty(_envBase, _name, {
    // process.env reads stay in src/config/env.ts per audit-env-access.ts constraint.
    get(): string | undefined { return process.env[_name]; },
    enumerable: !('secret' in _entry && _entry.secret), // secrets: non-enumerable (hidden from serialization)
    configurable: true,
  });
}

export const env: EnvObject = _envBase;

/**
 * Truthy-check for `AFK_PLAIN_OUTPUT` (the `--plain` CLI flag's env twin).
 * Truthy iff `'1'` or `'true'`, case-insensitive, after trimming whitespace —
 * matching the convention used by other boolean-ish opt-in vars in this
 * codebase (see AFK_AUTO_ROUTING in env-tier.ts).
 *
 * Reads via `env.AFK_PLAIN_OUTPUT` (never `process.env` directly), keeping
 * this inside the CI-enforced single-read-point boundary (`pnpm audit:env:check`).
 *
 * Shared by every render-decision site that must treat a `--plain` /
 * `AFK_PLAIN_OUTPUT=1` TTY session as non-TTY for rendering purposes: the
 * REPL renderer seam (`repl-renderer.ts`, between-turn writes), the
 * persistent input surface's compositor arm (`input-surface.ts`), and the
 * per-turn StreamRenderer's `isTTY` computation (`stream-renderer.ts`).
 * Originally module-local to `repl-renderer.ts`; promoted here so all three
 * sites import one predicate instead of drifting copies.
 */
export function isPlainOutputRequested(): boolean {
  const raw = env.AFK_PLAIN_OUTPUT;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Union of every registered env-var name. Useful for typed variable-name
 * parameters, e.g. `function readEnv(name: EnvVarName)`.
 *
 * Guaranteed to equal `keyof EnvObject` — both are derived from the same
 * `ENV_REGISTRY` source of truth, so parity is structural, not checked at
 * runtime. The authoritative behavioural parity gate remains the test in
 * `src/config/env.test.ts`.
 */
export type EnvVarName = keyof EnvObject;

// Runtime helpers over the registry — extracted to env-helpers.ts to keep this
// file within the 350-line ceiling. Re-exported here so all existing import
// sites (`import { getEnvVarMeta } from './env.js'`) continue to resolve.
export {
  getEnvVarMeta,
  getMissingRequiredEnvVars,
  isEnvVarSet,
  getEnvVarValue,
  isExplicitlyDisabled,
  isExplicitlyEnabled,
} from './env-helpers.js';
