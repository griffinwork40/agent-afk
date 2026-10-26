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

import { writeJsonFileAsync } from '../../utils/json-file.js';
import { getSessionMetaPath } from '../../paths.journal.js';
import { readFileSync } from 'fs';

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
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Write the session-meta.json sidecar atomically. Best-effort: errors are
 * swallowed and logged to stderr so a sidecar failure never breaks session
 * startup. Uses atomic write (tmp+rename via writeJsonFileAsync).
 */
export async function writeSessionMeta(meta: SessionMeta): Promise<void> {
  try {
    await writeJsonFileAsync(getSessionMetaPath(meta.sessionId), meta);
  } catch (err) {
    // Best-effort: a sidecar write failure must never break session startup.
    // eslint-disable-next-line no-console
    console.error(`[session-meta] failed to write session-meta.json: ${err}`);
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
