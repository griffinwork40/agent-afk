/**
 * Canonical session identity sidecar (`session-meta.json`).
 *
 * Written once per top-level session immediately after the ledger meta record.
 * Provides O(1) access to identity fields that consumers previously extracted
 * by scanning JSONL headers. Best-effort: a write failure is swallowed and
 * never breaks session startup.
 *
 * @module agent/session/session-meta
 * @see https://github.com/griffinwork40/agent-afk/issues/4429
 */

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { writeJsonFileAsync } from '../../utils/json-file.js';
import { getSessionMetaPath } from '../../paths.journal.js';
import { debugLog } from '../../utils/debug.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** The machine-readable session identity sidecar. */
export interface SessionMeta {
  /** Schema version; bump when fields are removed or semantics change. */
  v: 1;
  /** Provider-issued session id (the ledger key). */
  sessionId: string;
  /** Model id string. */
  model: string;
  /** Effective working directory at session start. */
  cwd?: string;
  /** Witness trace dir UUID; null = tracing disabled. */
  traceLabel?: string | null;
  /** Originating surface. */
  surface?: string;
  /** Provider family name (e.g. 'anthropic', 'openai'). */
  provider?: string;
  /** ms-epoch when the session started. */
  startedAt?: number;
  /** Running afk package version. */
  afkVersion?: string;
  /**
   * Parent session id when this session is a `/fork` child. Undefined for
   * top-level sessions. Used by the sidecar-sweep to protect fork parents
   * from age-based eviction (#4429).
   */
  forkedFrom?: string;
  /**
   * Git workspace state captured once at top-level session start.
   * Null fields indicate a non-git cwd or a git error (detached HEAD yields
   * branch: null with headSha set). Undefined when not yet written (old
   * sidecars) or when this is a subagent session (subagents never write this).
   *
   * A later SessionEnd step uses headSha to run `git log <headSha>..HEAD`
   * and enumerate commits the session made.
   */
  gitHead?: SessionStart | null;
}

// ---------------------------------------------------------------------------
// Git head capture (top-level sessions only)
// ---------------------------------------------------------------------------

/**
 * Git workspace state recorded once at top-level session start.
 *
 * - `branch`: current branch name; null on detached HEAD or non-git cwd.
 * - `headSha`: full 40-hex SHA of HEAD; null on non-git cwd.
 * - `capturedAt`: ms-epoch when the snapshot was taken.
 */
export interface SessionStart {
  branch: string | null;
  headSha: string | null;
  capturedAt: number;
}

/**
 * Capture the full 40-hex HEAD SHA and branch name for `cwd` via two
 * bounded, shell-free spawnSync calls. Returns `{ branch: null, headSha:
 * null }` when `cwd` is not a git repository or git is unavailable — never
 * throws.
 *
 * Timeout: 3 000 ms per call (generous but bounded; avoids hanging session
 * startup on a network-mount repo). No shell (`shell: false`).
 */
export function captureGitHead(cwd: string): SessionStart {
  const capturedAt = Date.now();

  const runGit = (args: string[]): string | null => {
    try {
      const r = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 256,
        shell: false,
        timeout: 3000,
      });
      if (r.status !== 0 || r.signal !== null || r.error !== undefined) return null;
      const out = typeof r.stdout === 'string' ? r.stdout.trim() : null;
      return out && out.length > 0 ? out : null;
    } catch {
      return null;
    }
  };

  const headSha = runGit(['rev-parse', 'HEAD']);
  // Validate: full SHA must be exactly 40 hex chars.
  const validSha =
    headSha !== null && /^[0-9a-f]{40}$/i.test(headSha) ? headSha : null;

  // symbolic-ref returns null on detached HEAD (non-zero exit) — that is
  // the correct branch: null signal.
  const branch = validSha !== null ? runGit(['symbolic-ref', '--short', 'HEAD']) : null;

  return { branch, headSha: validSha, capturedAt };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Write the session-meta.json sidecar atomically. Best-effort: errors are
 * swallowed and logged via debugLog so a sidecar failure never breaks session
 * startup. Uses atomic write (tmp+rename via writeJsonFileAsync).
 */
export async function writeSessionMeta(meta: SessionMeta): Promise<void> {
  try {
    await writeJsonFileAsync(getSessionMetaPath(meta.sessionId), meta);
  } catch (err) {
    // Best-effort: a sidecar write failure must never break session startup.
    // Use debugLog (not console.error) to avoid Vitest EnvironmentTeardownError
    // when this fire-and-forget promise rejects after the test worker RPC closes.
    debugLog(`[session-meta] failed to write session-meta.json: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read the session-meta.json sidecar synchronously. Returns `null` when the
 * file does not exist or fails to parse (pre-sidecar sessions, disabled
 * ledger, corrupt write). Callers should fall back to their current source.
 */
export function readSessionMeta(sessionId: string): SessionMeta | null {
  try {
    const raw = readFileSync(getSessionMetaPath(sessionId), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed['sessionId'] !== 'string' || parsed['v'] !== 1) return null;
    return parsed as unknown as SessionMeta;
  } catch {
    return null;
  }
}

/**
 * Read the git-head snapshot recorded at top-level session start.
 *
 * Returns `null` when:
 *   - The sidecar does not exist (pre-feature sessions, subagent sessions).
 *   - The sidecar exists but has no `gitHead` field (old sidecar written
 *     before this field was added).
 *   - The sidecar's `gitHead` field is explicitly null (non-git cwd).
 *
 * Signature for downstream consumers (e.g. a SessionEnd `git log` step):
 *   `readSessionStart(sessionId: string): SessionStart | null`
 */
export function readSessionStart(sessionId: string): SessionStart | null {
  const meta = readSessionMeta(sessionId);
  if (meta === null || meta.gitHead === undefined || meta.gitHead === null) return null;
  return meta.gitHead;
}
