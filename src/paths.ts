/**
 * Centralized path helpers for AFK state.
 *
 * Two scopes:
 *   - **User-scope** (`$AFK_HOME/`, default `~/.afk/`) — global config,
 *     state, plugins, skills, and AFK-surface agent-framework telemetry.
 *   - **Project-scope** (`<cwd>/.afk/`) — per-project skills and plugins,
 *     auto-discovered when running from a project directory.
 *
 * User-scope shape:
 *   $AFK_HOME/                   (default: ~/.afk/)
 *     config/                    afk.env, afk.config.json
 *     state/                     (override the whole tier with $AFK_STATE_DIR)
 *       sessions/                session-store sidecars
 *       todos/                   todo-panel data
 *       transcripts/             autosaved REPL session transcripts
 *       daemon/agent-afk@<i>/    per-instance daemon state
 *     agent-framework/           AFK-surface telemetry and briefs
 *       forge-telemetry.jsonl
 *       briefs/
 *     skills/                    generated / user-authored skills
 *     plugins/                   installed plugins + marketplace caches
 *     logs/
 *     cache/
 *
 * Project-scope shape:
 *   <cwd>/.afk/
 *     skills/     project-level SKILL.md dirs
 *     plugins/    project-level plugin dirs
 *
 * Legacy flat paths (~/.afk/sessions, ~/.afk/todos, ~/.afk/transcripts,
 * ~/.afk.env, ~/.afk.config.json) still work: sessions/todos/transcripts
 * migrate once on first access; env/json config files fall back in lookup
 * order.
 */

import { existsSync, mkdirSync, renameSync, cpSync, rmSync } from 'fs';
import { join, dirname, basename, isAbsolute } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';

export function getAfkHome(): string {
  const envVal = env.AFK_HOME;
  if (envVal !== undefined && envVal !== '') {
    // External constraint: AFK_HOME must be absolute and must not be the
    // filesystem root ('/') — writing credentials/sessions to '/' would expose
    // them to all users and could corrupt system directories.
    if (!isAbsolute(envVal) || envVal === '/') {
      throw new Error(
        `AFK_HOME must be an absolute path that is not /, got: ${envVal}`,
      );
    }
    return envVal;
  }
  return join(homedir(), '.afk');
}

export function getSdkHomeDir(): string {
  return getAfkHome();
}

export function getAgentFrameworkDir(): string {
  const envVal = env.AFK_FRAMEWORK_DIR;
  if (envVal !== undefined && envVal !== '') {
    // External constraint: AFK_FRAMEWORK_DIR governs the agent-framework tier
    // (telemetry, briefs, improve artifacts). Mirror the getAfkStateDir() guard
    // since this value is load-bearing for read-scope grants (subagent.ts) and
    // write paths alike — both must resolve to the same directory.
    if (!isAbsolute(envVal) || envVal === '/') {
      throw new Error(
        `AFK_FRAMEWORK_DIR must be an absolute path that is not /, got: ${envVal}`,
      );
    }
    return envVal;
  }
  return join(getAfkHome(), 'agent-framework');
}

export function getTelemetryPath(): string {
  return join(getAgentFrameworkDir(), 'forge-telemetry.jsonl');
}

export function getRoutingDecisionsPath(): string {
  return join(getAgentFrameworkDir(), 'routing-decisions.jsonl');
}

export function getSdkSchemaViolationsPath(): string {
  return join(getAgentFrameworkDir(), 'sdk-schema-violations.jsonl');
}

export function getBriefsDir(): string {
  return join(getAgentFrameworkDir(), 'briefs');
}

/**
 * Directory for cached SessionFacet JSON sidecars (one per session id).
 *
 * Facets are a lazily-derived, consumer-facing projection of a persisted
 * session (see src/agent/facets/). They live under the agent-framework
 * telemetry tier in $AFK_HOME — NOT under a Claude-Code-style `usage-data/`
 * path, which has no precedent here.
 */
export function getFacetCacheDir(): string {
  return join(getAgentFrameworkDir(), 'facets');
}

export function getSkillsDir(): string {
  return join(getAfkHome(), 'skills');
}

export function getPluginsDir(): string {
  return join(getAfkHome(), 'plugins');
}

// ---------------------------------------------------------------------------
// Project-scope paths (cwd-relative)
// ---------------------------------------------------------------------------

/**
 * Project-scoped `.afk/` root: `<cwd>/.afk`.
 *
 * Takes an explicit `cwd` because long-lived hosts (daemon, Telegram bot) and
 * the REPL's worktree mode track a *session* working directory that diverges
 * from the Node host's `process.cwd()` — project-scope artifacts must resolve
 * against the session's cwd, not the host's. The default keeps parity with
 * call sites that genuinely mean the host process cwd (mirrors
 * `getProjectPlansDir` below).
 */
export function getProjectAfkDir(cwd: string = process.cwd()): string {
  return join(cwd, '.afk');
}

/**
 * Project-scoped skills directory: `<cwd>/.afk/skills/`.
 * See {@link getProjectAfkDir} for why `cwd` is a parameter.
 */
export function getProjectSkillsDir(cwd: string = process.cwd()): string {
  return join(getProjectAfkDir(cwd), 'skills');
}

export function getProjectPluginsDir(cwd: string = process.cwd()): string {
  return join(getProjectAfkDir(cwd), 'plugins');
}

/**
 * Project-scoped plans directory: `<cwd>/.afk/plans/`.
 *
 * Home for the plan artifact the model writes when the user exits plan mode
 * (`/plan off`). Takes an explicit `cwd` because the REPL tracks the session's
 * effective working directory (`stats.cwd`, stamped at REPL bootstrap)
 * separately from the Node host's `process.cwd()` — the two diverge under
 * `afk i --worktree`, and the plan must land in the session's worktree, not
 * the host's launch dir. The default keeps parity with the param-less sibling
 * `getProject*Dir` helpers for non-REPL callers.
 */
export function getProjectPlansDir(cwd: string = process.cwd()): string {
  return join(cwd, '.afk', 'plans');
}

export function getPluginsIndexPath(): string {
  return join(getPluginsDir(), '.index.json');
}

export function getSchedulesPath(): string {
  return join(getAfkConfigDir(), 'schedules.json');
}

/**
 * Marketplace cache root. Marketplaces clone into
 * `~/.afk/plugins/cache/<marketplace>/`, matching Claude Code's layout.
 */
export function getMarketplaceCacheDir(): string {
  return join(getPluginsDir(), 'cache');
}

/** Path to a specific marketplace's clone dir. */
export function getMarketplaceDir(name: string): string {
  return join(getMarketplaceCacheDir(), name);
}

/**
 * Bundled plugins shipped inside the compiled dist/ output.
 * Resolved relative to this module's location so it works from both
 * `src/` (dev via tsx) and `dist/` (built output).
 */
export function getBundledPluginsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  // In dist/: thisDir = <root>/dist  → bundled-plugins is a sibling
  // In src/:  thisDir = <root>/src   → bundled-plugins is a sibling
  return join(thisDir, 'bundled-plugins');
}

/**
 * Bundled web-ui assets (compiled `afk web` frontend bundle) shipped inside
 * the compiled dist/ output. Resolved relative to this module's location —
 * same rationale and sibling-dir shape as {@link getBundledPluginsDir} — so it
 * resolves identically under `tsx` (`src/web-ui-assets/`) and compiled dist
 * (`dist/web-ui-assets/`).
 */
export function getWebUiAssetsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);
  return join(thisDir, 'web-ui-assets');
}

export function getAfkConfigDir(): string {
  return join(getAfkHome(), 'config');
}

export function getAfkStateDir(): string {
  const envVal = env.AFK_STATE_DIR;
  if (envVal !== undefined && envVal !== '') {
    // External constraint: AFK_STATE_DIR governs the ENTIRE state tier
    // (sessions, grants, transcripts, daemon state). A relative path would
    // scatter state relative to cwd; '/' would expose it to all users and
    // risk corrupting system dirs. Mirror the getAfkHome() guard since this
    // value is now just as load-bearing.
    if (!isAbsolute(envVal) || envVal === '/') {
      throw new Error(
        `AFK_STATE_DIR must be an absolute path that is not /, got: ${envVal}`,
      );
    }
    return envVal;
  }
  return join(getAfkHome(), 'state');
}

export function getAfkCacheDir(): string {
  return join(getAfkHome(), 'cache');
}

export function getLogsDir(): string {
  return join(getAfkHome(), 'logs');
}

export function getSessionsDir(): string {
  return join(getAfkStateDir(), 'sessions');
}

/**
 * Directory for session presence files (Phase 2 awareness layer).
 *
 * Each active top-level session writes `<sessionId>.json` here on start and
 * removes it on exit. Presence files are best-effort (write/delete failures
 * are swallowed) and should not be relied on for crash-safe state — they are
 * purely for real-time session discovery (`afk sessions`).
 *
 * Separate from `getSessionsDir()` (`state/sessions/`) which holds
 * session-store sidecars (conversation history, tool outputs, etc.).
 */
export function getPresenceDir(): string {
  return join(getAfkStateDir(), 'presence');
}

export function getTodosDir(): string {
  return join(getAfkStateDir(), 'todos');
}

/**
 * Directory for autosaved REPL session transcripts (one `<isoStamp>.md` per
 * session, rotated on `/clear`). Lives under the state tier alongside
 * sessions/ and todos/ — it is session state, not a top-level artifact.
 *
 * Pre-3.x builds wrote these to a flat `~/.afk/transcripts/`;
 * {@link ensureTranscriptsMigrated} relocates that legacy dir on first access.
 */
export function getTranscriptsDir(): string {
  return join(getAfkStateDir(), 'transcripts');
}

export function getMemoryDir(): string {
  return join(getAfkStateDir(), 'memory');
}

export function getQueueDir(): string {
  return join(getAfkStateDir(), 'queue');
}

/**
 * Audit log for session-level directory grants (/allow-dir). Each line is a
 * JSONL entry with `{ timestamp, sessionId, action, path, source }`.
 *
 * This is an audit log only — it is NOT replayed on session start. New
 * sessions always begin with `[cwd]` as the only allowed root.
 */
export function getSessionGrantsPath(): string {
  return join(getAfkStateDir(), 'session-grants.jsonl');
}

/**
 * Persisted user-approved path-access grants written by the path-approval
 * elicitation flow when the user selects [Always — persist]. See
 * `src/agent/permissions-store.ts` for the schema. Lives under
 * `~/.afk/config/` rather than `state/` because it's policy (dotfile-syncable)
 * not runtime data.
 */
export function getPermissionsStorePath(): string {
  return join(getAfkConfigDir(), 'permissions.json');
}

/**
 * Root for Speculative Branch Farm worktrees.
 *
 * Each farm lives at `<getFarmsDir()>/<taskSlug>/` and contains:
 *   - `farm.json`              — manifest mirroring FarmCreationResult
 *   - `branch-<n>/`            — one git worktree per speculative branch
 *
 * Lives under `$AFK_HOME/farms/` (default `~/.afk/farms/`).
 */
export function getFarmsDir(): string {
  return join(getAfkHome(), 'farms');
}

export function getFarmDir(taskSlug: string): string {
  return join(getFarmsDir(), taskSlug);
}

/**
 * Per-session witness-layer directory.
 *
 * Holds `trace.jsonl` and any compaction sidecars for the given session.
 * See `docs/philosophy/afk-contract.md` — the witness layer is the durable
 * evidence record for unattended (AFK) work.
 */
const SESSION_ID_SAFE = /^[a-zA-Z0-9_-]+$/;

export function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_SAFE.test(sessionId)) {
    throw new Error(
      `Invalid AFK_SESSION_ID: must match /^[a-zA-Z0-9_-]+$/, got: ${JSON.stringify(sessionId)}`,
    );
  }
}

/**
 * Root of the witness tree — the parent of every per-session trace directory.
 *
 * Canonical home for the path that `afk trace list`, the improve scanner, and
 * the retention sweep all need. Previously duplicated as a private helper in
 * `cli/commands/trace.ts` and `improve/paths.ts`.
 */
export function getWitnessRoot(): string {
  return join(getAfkStateDir(), 'witness');
}

export function getTraceDir(sessionId: string): string {
  validateSessionId(sessionId);
  return join(getWitnessRoot(), sessionId);
}

/** Session-scoped sidecars for human-supplied images addressable by subagents. */
export function getInboundAttachmentsDir(sessionId: string): string {
  return join(getTraceDir(sessionId), 'inbound-attachments');
}

/**
 * Directory for opt-in captured subagent dispatch prompts, keyed by the same
 * witness `sessionLabel` as {@link getTraceDir}.
 *
 * A forked child resumes its parent's sessionId, so a child writing here lands
 * in its PARENT's directory — which is what makes "every prompt this session
 * dispatched" a single-directory read. Pure path helper: the caller owns `mkdir`
 * (see `agent/session/subagent-prompt-capture.ts`).
 */
export function getPromptsDir(sessionId: string): string {
  return join(getTraceDir(sessionId), 'prompts');
}

/**
 * Directory for opt-in captured subagent conversational OUTPUT — the mirror of
 * {@link getPromptsDir}, which captures only what a child was *asked*.
 *
 * Same session-label keying and same fork semantics: a child resumes its
 * parent's sessionId, so one directory holds every child transcript a session
 * produced, keyed by `subagentId` filename. Pure path helper: the caller owns
 * `mkdir` (see `agent/session/subagent-output-capture.ts`).
 */
export function getSubagentOutputsDir(sessionId: string): string {
  return join(getTraceDir(sessionId), 'outputs');
}

/**
 * Inverse of {@link getTraceDir}: recover the witness `sessionLabel` from a
 * trace-file path (`.../witness/<label>/trace.jsonl`).
 *
 * Returns `null` for the in-memory writer sentinel (`in-memory://trace`) and
 * for an absent path, so a caller recording the label can store an explicit
 * "no trace" marker rather than a bogus directory name. Used to stamp the
 * witness label into the session ledger's `meta` record — the trace writer
 * exposes only `getTracePath()` (its label is a random UUID it doesn't surface
 * directly), so the label is derived from that path.
 */
export function sessionLabelFromTracePath(tracePath: string | undefined | null): string | null {
  if (!tracePath || tracePath.startsWith('in-memory:')) return null;
  return basename(dirname(tracePath));
}

/**
 * Directory for post-session run receipts.
 *
 * Each completed top-level session writes `<label>.json` + `<label>.md` here,
 * keyed by the witness-trace label so a receipt sits 1:1 with the trace it
 * summarizes (see `src/agent/trace/receipt.ts`). Read-only derivatives of the
 * sealed witness trace — they carry no state the trace doesn't already hold.
 */
export function getReceiptsDir(): string {
  return join(getAfkStateDir(), 'receipts');
}

export function getDaemonStateDir(instanceId: string = 'default'): string {
  return join(getAfkStateDir(), 'daemon', `agent-afk@${instanceId}`);
}

export function getWorktreeSweepLockPath(): string {
  return join(getAfkStateDir(), 'worktree-sweep.lock');
}

/**
 * Registry of repo roots known to contain afk-managed worktrees. The sweep is
 * per-root, so without this the daemon only ever reclaims the ONE repo its cwd
 * happens to resolve to and trees under every other repo leak forever (#761).
 */
export function getWorktreeRootsRegistryPath(): string {
  return join(getAfkStateDir(), 'worktree-roots.json');
}

export function getEnvConfigPath(): string {
  return join(getAfkConfigDir(), 'afk.env');
}

export function getJsonConfigPath(): string {
  return join(getAfkConfigDir(), 'afk.config.json');
}

/**
 * Path to the user-global AFK settings file.
 * Distinct from `getJsonConfigPath()` (which is `afk.config.json`) — this is
 * the supplemental `settings.json` that carries shell-hook trust gates and
 * other opt-in flags that should not live in the primary config.
 */
export function getSettingsPath(): string {
  return join(getAfkConfigDir(), 'settings.json');
}

/**
 * Path to the project-local AFK settings file (`<cwd>/.afk/settings.json`).
 *
 * Accepts an explicit `cwd` so tests can inject a temp directory without
 * mutating `process.cwd()`.  Do NOT call `getProjectAfkDir()` here — that
 * function always reads `process.cwd()` internally and ignores any argument.
 */
export function getProjectSettingsPath(cwd: string = process.cwd()): string {
  return join(cwd, '.afk', 'settings.json');
}

/**
 * Path to the user-scope AFK.md system-prompt overlay (`$AFK_HOME/AFK.md`).
 *
 * Contract: this is the BROADEST tier — it applies to every project on the
 * machine and is concatenated FIRST by `loadAfkMd()`. Note it sits at the
 * `$AFK_HOME` root, NOT under `config/` like afk.env / afk.config.json, so it
 * stays hand-editable next to the other top-level operator files.
 */
export function getUserAfkMdPath(): string {
  return join(getAfkHome(), 'AFK.md');
}

/**
 * Path to the project-scope AFK.md system-prompt overlay (`<cwd>/AFK.md`).
 *
 * The most-specific tier: concatenated SECOND by `loadAfkMd()` and documented
 * as taking precedence on conflict. Accepts an explicit `cwd` so tests can
 * inject a temp directory without mutating `process.cwd()` — same rationale as
 * `getProjectSettingsPath()`. Deliberately NOT under `.afk/`: an AFK.md is a
 * repo-root document a human is expected to read and commit.
 */
export function getProjectAfkMdPath(cwd: string = process.cwd()): string {
  return join(cwd, 'AFK.md');
}

export function getLegacyEnvConfigPath(): string {
  return join(homedir(), '.afk.env');
}

export function getLegacyJsonConfigPath(): string {
  return join(homedir(), '.afk.config.json');
}

function getLegacySessionsDir(): string {
  return join(getAfkHome(), 'sessions');
}

function getLegacyTodosDir(): string {
  return join(getAfkHome(), 'todos');
}

function getLegacyTranscriptsDir(): string {
  return join(getAfkHome(), 'transcripts');
}

function migrateDirOnce(oldPath: string, newPath: string): void {
  if (oldPath === newPath) return;
  if (!existsSync(oldPath)) return;
  if (existsSync(newPath)) return;
  try {
    mkdirSync(dirname(newPath), { recursive: true });
    try {
      renameSync(oldPath, newPath);
    } catch (renameErr) {
      // External constraint: renameSync throws EXDEV when src and dst are on
      // different filesystems (cross-device rename). Fall back to copy+remove
      // so the migration succeeds even when AFK_HOME is on a different mount.
      if ((renameErr as NodeJS.ErrnoException).code === 'EXDEV') {
        try {
          cpSync(oldPath, newPath, { recursive: true });
          rmSync(oldPath, { recursive: true, force: true });
        } catch (fallbackErr) {
          // Best-effort: log but don't crash. Caller creates the new path fresh.
          process.stderr.write(
            `[afk] migrateDirOnce: EXDEV fallback failed for ${oldPath} → ${newPath}: ${String(fallbackErr)}\n`,
          );
        }
      }
      // Any other error is swallowed — migration remains best-effort.
    }
  } catch {
    // mkdirSync failure: best-effort, leave state as-is.
  }
}

export function ensureSessionsMigrated(): void {
  migrateDirOnce(getLegacySessionsDir(), getSessionsDir());
}

export function ensureTodosMigrated(): void {
  migrateDirOnce(getLegacyTodosDir(), getTodosDir());
}

/**
 * Relocate the legacy flat transcripts dir (`~/.afk/transcripts/`) into the
 * state tier (`<getAfkStateDir()>/transcripts/`). No-op when there is nothing
 * to move, or when an $AFK_STATE_DIR override already places both at the same
 * path (migrateDirOnce early-returns on oldPath === newPath).
 */
export function ensureTranscriptsMigrated(): void {
  migrateDirOnce(getLegacyTranscriptsDir(), getTranscriptsDir());
}

/**
 * Path to the REPL input history file.
 * Format: newline-delimited JSON objects `{ text: string, ts: number }`.
 * Append-only up to MAX_HISTORY_ENTRIES (1 000); compacted on overflow.
 */
export function getReplHistoryPath(): string {
  return join(getAfkStateDir(), 'repl-history.jsonl');
}

/**
 * Path to the first-run marker file. Written once (empty) after the
 * first-run welcome banner is shown, so the banner never repeats.
 */
export function getFirstRunMarkerPath(): string {
  return join(getAfkStateDir(), '.first-run-shown');
}

// ---------------------------------------------------------------------------
// Background job persistence paths
// ---------------------------------------------------------------------------

/**
 * Strict format check for background-job IDs.
 *
 * jobIds are produced internally by `BackgroundAgentRegistry.nextJobId()` as
 * `bg-<base36-timestamp>-<counter>` and are NEVER user-authored. They flow
 * through several CLI surfaces (`afk bg tail <jobId>`, `afk bg replay`,
 * `/bgsub:join <id>`) where they ARE caller-supplied strings — so every
 * accessor below must defend against path traversal (`../../etc/passwd`),
 * absolute paths, null bytes, and other unsafe filename payloads.
 *
 * Centralizing the check here ensures one guard covers every accessor
 * (`getBgJobDir`, `getBgJobLog`, `getBgJobMeta`) and any future caller is
 * automatically protected without per-call sanitization.
 *
 * Allowed charset: `[A-Za-z0-9_-]+`, max 128 chars. Anything else throws.
 */
const BG_JOB_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const BG_JOB_ID_MAX_LEN = 128;

export function assertSafeJobId(jobId: string): void {
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new Error('Invalid jobId: must be a non-empty string');
  }
  if (jobId.length > BG_JOB_ID_MAX_LEN) {
    throw new Error(`Invalid jobId: exceeds ${BG_JOB_ID_MAX_LEN} chars`);
  }
  if (!BG_JOB_ID_PATTERN.test(jobId)) {
    throw new Error(
      `Invalid jobId: ${JSON.stringify(jobId)} contains characters outside [A-Za-z0-9_-]`,
    );
  }
}

/**
 * Root directory for persisted background job logs.
 * Each job gets its own subdirectory: `~/.afk/state/bg/<jobId>/`.
 */
export function getBgJobsRoot(): string {
  return join(getAfkStateDir(), 'bg');
}

/**
 * Directory for a specific background job's persisted data.
 * @throws if `jobId` fails {@link assertSafeJobId}.
 */
export function getBgJobDir(jobId: string): string {
  assertSafeJobId(jobId);
  return join(getBgJobsRoot(), jobId);
}

/**
 * Append-only JSONL event log for a specific background job.
 * @throws if `jobId` fails {@link assertSafeJobId}.
 */
export function getBgJobLog(jobId: string): string {
  return join(getBgJobDir(jobId), 'events.jsonl');
}

/**
 * JSON metadata sidecar for a specific background job.
 * @throws if `jobId` fails {@link assertSafeJobId}.
 */
export function getBgJobMeta(jobId: string): string {
  return join(getBgJobDir(jobId), 'meta.json');
}

// ---------------------------------------------------------------------------
// Subagent conversation logs — powers /tasks:view replay
// ---------------------------------------------------------------------------

/**
 * Root directory for per-subagent conversation JSONL logs.
 * Layout: `~/.afk/state/subagent-logs/<sessionLabel>/<subagentId>.jsonl`
 */
export function getSubagentLogsRoot(): string {
  return join(getAfkStateDir(), 'subagent-logs');
}

/**
 * Session-scoped directory for one parent session's subagent logs.
 * @throws if `sessionLabel` fails {@link assertSafeJobId} (reuses the same charset guard).
 */
export function getSubagentLogSessionDir(sessionLabel: string): string {
  assertSafeJobId(sessionLabel);
  return join(getSubagentLogsRoot(), sessionLabel);
}

/**
 * JSONL event log for a specific subagent within a session.
 * @throws if `sessionLabel` or `subagentId` fail {@link assertSafeJobId}.
 */
export function getSubagentLogPath(sessionLabel: string, subagentId: string): string {
  assertSafeJobId(subagentId);
  return join(getSubagentLogSessionDir(sessionLabel), `${subagentId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Browser session-vault paths
//
// Invariant: a profile name flows into a filesystem path, so it MUST pass
// assertSafeBrowserProfile() before any join() — same containment rationale as
// assertSafeJobId. Mirrors the bg-job pattern: a leading guard means every
// downstream helper is automatically protected without per-call sanitization.
// ---------------------------------------------------------------------------

const BROWSER_PROFILE_PATTERN = /^[A-Za-z0-9_-]+$/;
const BROWSER_PROFILE_MAX_LEN = 128;

export function assertSafeBrowserProfile(profile: string): void {
  if (typeof profile !== 'string' || profile.length === 0) {
    throw new Error('Invalid browser profile: must be a non-empty string');
  }
  if (profile.length > BROWSER_PROFILE_MAX_LEN) {
    throw new Error(`Invalid browser profile: exceeds ${BROWSER_PROFILE_MAX_LEN} chars`);
  }
  if (!BROWSER_PROFILE_PATTERN.test(profile)) {
    throw new Error(
      `Invalid browser profile: ${JSON.stringify(profile)} contains characters outside [A-Za-z0-9_-]`,
    );
  }
}

/**
 * Root directory for persistent browser session-vault profiles.
 * Each profile gets its own subdirectory: `~/.afk/state/browser/<profile>/`.
 */
export function getBrowserStateRoot(): string {
  return join(getAfkStateDir(), 'browser');
}

/**
 * Directory holding a specific browser profile's persisted state.
 * @throws if `profile` fails {@link assertSafeBrowserProfile}.
 */
export function getBrowserProfileStateDir(profile: string): string {
  assertSafeBrowserProfile(profile);
  return join(getBrowserStateRoot(), profile);
}

/**
 * Path to a profile's Playwright `storageState` (cookies + localStorage).
 *
 * Invariant: this file holds live session credentials — callers MUST write it
 * with `0600` perms and treat it as secrets-at-rest.
 *
 * @throws if `profile` fails {@link assertSafeBrowserProfile}.
 */
export function getBrowserStorageStatePath(profile: string): string {
  return join(getBrowserProfileStateDir(profile), 'storageState.json');
}

// ---------------------------------------------------------------------------
// Session event-ledger paths
// ---------------------------------------------------------------------------

/**
 * Session ids flow into ledger paths from provider-issued identifiers AND
 * from caller-supplied CLI/Telegram arguments (`afk attach <id>`, `/watch
 * <id>`), so the same traversal defense as bg job ids applies. UUIDs and
 * slugified names both fit the charset.
 */
const LEDGER_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const LEDGER_SESSION_ID_MAX_LEN = 128;

/** Non-throwing safety check for session ids used in ledger paths. */
export function isSafeLedgerSessionId(sessionId: string): boolean {
  return (
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    sessionId.length <= LEDGER_SESSION_ID_MAX_LEN &&
    LEDGER_SESSION_ID_PATTERN.test(sessionId)
  );
}

/**
 * Per-session ledger directory: `~/.afk/state/sessions/<sessionId>/`.
 * Shares the sessions dir with sidecar `<id>.json` files and mint-state
 * subdirs — the ledger adds `events.jsonl` inside the per-id subdir.
 * @throws if `sessionId` fails {@link isSafeLedgerSessionId}.
 */
export function getSessionLedgerDir(sessionId: string): string {
  if (!isSafeLedgerSessionId(sessionId)) {
    throw new Error(`Invalid session id for ledger path: ${JSON.stringify(sessionId)}`);
  }
  return join(getSessionsDir(), sessionId);
}

/**
 * Append-only JSONL event ledger for a session.
 * @throws if `sessionId` fails {@link isSafeLedgerSessionId}.
 */
export function getSessionLedgerPath(sessionId: string): string {
  return join(getSessionLedgerDir(sessionId), 'events.jsonl');
}

/**
 * Per-session HMAC key for the AFK remote-control channel:
 * `~/.afk/state/sessions/<sessionId>/session.key`. Written 0600 by the REPL
 * when AFK mode is enabled; read by the Telegram daemon to sign the
 * elicitation responses and abort requests it writes back into the session
 * ledger, and re-verified by the REPL before it acts on them.
 * @throws if `sessionId` fails {@link isSafeLedgerSessionId}.
 */
export function getSessionKeyPath(sessionId: string): string {
  return join(getSessionLedgerDir(sessionId), 'session.key');
}

/**
 * Path to the MCP server-status file.
 *
 * Written by `KeychainOAuthProvider.redirectToAuthorization()` when an MCP
 * server requires OAuth authorization. Each entry is keyed by server name:
 *
 *   {
 *     "<serverName>": {
 *       "status":           "oauth_pending",
 *       "authorizationUrl": "https://...",
 *       "timestamp":        <ms since epoch>
 *     }
 *   }
 *
 * The `/mcp` slash command reads this file to surface pending auth URLs to
 * the user in interactive sessions.
 */
export function getOauthPendingPath(): string {
  return join(getAfkStateDir(), 'mcp', 'server-status.json');
}

// ---------------------------------------------------------------------------
// Wave manifest paths
// ---------------------------------------------------------------------------

/**
 * Root for wave manifests: `~/.afk/state/waves/`.
 *
 * One JSON file per wave (≥2 concurrent dispatches in one turn) lives here.
 * Written by coordinators (SubagentExecutor, ComposeExecutor) before a fan-out
 * starts; cleaned up by the reconciler and witness sweep after TTL expiry.
 */
export function getWavesDir(): string {
  return join(getAfkStateDir(), 'waves');
}

/**
 * Per-manifest file: `~/.afk/state/waves/<waveId>.json`.
 *
 * waveId is a UUID v4, which fits the isSafeLedgerSessionId charset
 * ([A-Za-z0-9_-]), so no extra validation is needed beyond the UUID generator.
 */
export function getWaveManifestPath(waveId: string): string {
  return join(getWavesDir(), `${waveId}.json`);
}
