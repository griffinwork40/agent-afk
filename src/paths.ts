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
import { join, dirname, isAbsolute } from 'path';
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

export function getProjectAfkDir(): string {
  return join(process.cwd(), '.afk');
}

export function getProjectSkillsDir(): string {
  return join(getProjectAfkDir(), 'skills');
}

export function getProjectPluginsDir(): string {
  return join(getProjectAfkDir(), 'plugins');
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

export function getTraceDir(sessionId: string): string {
  validateSessionId(sessionId);
  return join(getAfkStateDir(), 'witness', sessionId);
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
