/**
 * Constructor helpers for AgentSession.
 * @module agent/session/session-setup
 */

import { getSessionGrantsPath } from '../../paths.js';
import {
  capJsonlBySize,
  SESSION_GRANTS_MAX_BYTES,
  SESSION_GRANTS_KEEP_TAIL_LINES,
} from '../log-retention.js';
import { sweepWitnessTree, WITNESS_SWEEP_START_DELAY_MS } from '../witness-sweep.js';
import { sweepSessionSidecars, SESSION_SIDECAR_SWEEP_START_DELAY_MS } from '../session-sidecar-sweep.js';
import { sweepMemoryGc, MEMORY_GC_SWEEP_START_DELAY_MS } from '../memory/memory-gc-sweep.js';
import { debugLog } from '../../utils/debug.js';
import { errorMessage } from '../../utils/errors.js';
import { loadJournalMessages } from '../journal/index.js';
import { computeMissingExecutors, warnMissingExecutorsOnce } from './session-setup.missing-executors.js';
import type {
  AgentConfig,
  SessionIdentity,
  SessionMetadata,
} from '../types.js';

/**
 * Wire an optional external abort signal to an internal AbortController.
 * Forwards abort events (preserving reason) and attaches onAbort.
 */
export function wireAbortSignal(
  external: AbortSignal | undefined,
  internal: AbortController,
  onAbort: () => void,
): void {
  if (external) {
    if (external.aborted) {
      internal.abort(external.reason);
    } else {
      external.addEventListener(
        'abort',
        () => {
          if (!internal.signal.aborted) internal.abort(external.reason);
        },
        { once: true },
      );
    }
  }
  internal.signal.addEventListener('abort', onAbort, { once: true });
}

/**
 * Build initial session identity and metadata from config.
 * Metadata model is supplied separately (resolved by buildQueryOptions).
 */
export function buildInitialState(
  config: AgentConfig,
  resolvedModel: string,
): {
  sessionIdentity: SessionIdentity;
  metadata: SessionMetadata;
} {
  const permissionMode = config.permissionMode ?? 'default';
  const persistSession = config.persistSession ?? true;

  const sessionIdentity: SessionIdentity = {
    sessionId: config.sessionId,
    configuredSessionId: config.sessionId,
    resume: config.resume,
    resumeSessionAt: config.resumeSessionAt,
    continue: config.continue,
    forkSession: config.forkSession,
    persistSession,
  };

  // #3442: name the agent/skill/compose tools a bare session cannot offer.
  const missingExecutors = computeMissingExecutors(config);
  if (missingExecutors !== undefined) warnMissingExecutorsOnce(missingExecutors);

  const metadata: SessionMetadata = {
    sessionId: config.sessionId,
    model: resolvedModel,
    permissionMode,
    ...(missingExecutors !== undefined ? { missingExecutors } : {}),
  };

  return { sessionIdentity, metadata };
}

/**
 * Contract: when an SDK consumer passes `resume` but omits `resumeMessages`
 * and `resumeHistory`, auto-load the on-disk message journal
 * so the resumed conversation sees its prior context — matching the behaviour
 * the CLI achieves via `resumeConfigFor()`.
 *
 * Guards:
 *   - Already-explicit `resumeMessages` wins (no double-load; CLI path is safe).
 *   - Explicit `resumeHistory` wins: the caller supplied its own context.
 *   - `sessionId` alone never triggers a load: only `resume` expresses intent
 *     to continue a prior conversation (callers pass `sessionId` to name a
 *     session, e.g. the Telegram lifecycle, without asking for rehydration).
 *   - `persistSession: false` opts out (caller does not want disk state).
 *   - `isMessageJournalDisabled()` (`AFK_MESSAGE_JOURNAL_DISABLED=1`) is a no-op.
 *   - Fork configs (`isSubagentFork` / `parentSessionId`) are never seeded here;
 *     they rehydrate from the parent's in-memory journal via `JournalSync`.
 *   - When the journal is absent or empty, the config is returned unchanged so
 *     the caller falls through to the existing `resumeHistory` path.
 *   - When the journal is corrupt in a way the reader does not tolerate (e.g. a
 *     well-formed append record whose `tool_result.content` is `[null]`, which
 *     throws in `hydratePart`), the load error is reported to stderr and the
 *     config is returned unchanged. This runs inside the `AgentSession`
 *     constructor, so an escaped throw would fail construction before any
 *     provider exists; a corrupt journal must degrade to "no prior context".
 *
 * `continue` is not handled here (it requires a session-store lookup that the
 * CLI owns; SDK callers that want `--continue` semantics should resolve the id
 * themselves and pass it as `resume`).
 */
export function seedResumeMessages(config: AgentConfig): AgentConfig {
  // Already have full-fidelity messages — nothing to do.
  if (config.resumeMessages !== undefined) return config;
  // Caller supplied its own text history; do not override it with the journal.
  if (config.resumeHistory !== undefined) return config;
  // Caller opted out of disk persistence.
  if (config.persistSession === false) return config;
  // Fork sessions rehydrate from the parent provider's in-memory journal.
  if (config.isSubagentFork === true || config.parentSessionId !== undefined) return config;
  // Only an explicit `resume` requests rehydration.
  const targetId = config.resume;
  if (!targetId) return config;
  // loadJournalMessages checks isMessageJournalDisabled() and returns null when
  // absent, disabled, or empty. It can still throw on accepted-but-malformed
  // nested records, so the boundary below keeps construction non-throwing.
  let messages: ReturnType<typeof loadJournalMessages>;
  try {
    messages = loadJournalMessages(targetId);
  } catch (err) {
    try {
      process.stderr.write(
        `[afk] journal: resume load failed for session ${targetId}; continuing without prior context: ${errorMessage(err)}\n`,
      );
    } catch {
      // stderr closed — nothing left to tell.
    }
    return config;
  }
  if (!messages) return config;
  return { ...config, resumeMessages: messages };
}

/**
 * Top-level session-start housekeeping, extracted from the AgentSession
 * constructor. Callers invoke it for top-level sessions only.
 *
 * Bounds the write-only session-grants audit log: subagents share the parent's
 * path, so re-running per fork is redundant and widens the rewrite-collision
 * window. Fire-and-forget + silent-fail — best-effort housekeeping that must
 * never delay or break construction.
 *
 * Bounds the witness tree the same way. Self-throttled by a stamp file, so this
 * is a no-op on all but one session start every few hours (#849).
 *
 * Invariant: the sweeps are deferred off the construction path and
 * `.unref()`ed, exactly as BackgroundAgentRegistry's eviction sweep is. The
 * walk is O(files in the witness tree), so running it inline competes with the
 * session's own first-turn I/O. The unref also means a short-lived process
 * exits without ever paying for it.
 */
export function scheduleTopLevelHousekeeping(
  getActiveLabel: () => string | undefined,
  getActiveSessionId: () => string | undefined,
): void {
  void capJsonlBySize(getSessionGrantsPath(), {
    maxBytes: SESSION_GRANTS_MAX_BYTES,
    keepTailLines: SESSION_GRANTS_KEEP_TAIL_LINES,
  });
  const witnessSweepTimer = setTimeout(() => {
    void sweepWitnessTree({ activeLabel: getActiveLabel() });
  }, WITNESS_SWEEP_START_DELAY_MS);
  witnessSweepTimer.unref();
  const sidecarSweepTimer = setTimeout(() => {
    void sweepSessionSidecars({ activeSessionId: getActiveSessionId() });
  }, SESSION_SIDECAR_SWEEP_START_DELAY_MS);
  sidecarSweepTimer.unref();
  // Memory GC sweep — opt-in, OFF by default (AFK_MEMORY_GC_SWEEP_ENABLE=1).
  // Self-throttled to at most once per 24 hours. Fire-and-forget; never throws.
  // The sweep logs internally when it archives facts or encounters an error.
  const memoryGcTimer = setTimeout(() => {
    sweepMemoryGc().then((result) => {
      if (!result.skipped) {
        debugLog(
          `[session-setup] memory GC sweep complete: candidates=${result.candidates} archived=${result.archived}${result.error ? ` error=${result.error}` : ''}`,
        );
      }
    }).catch(() => {
      // sweepMemoryGc itself never rejects, but guard just in case.
    });
  }, MEMORY_GC_SWEEP_START_DELAY_MS);
  memoryGcTimer.unref();
}
