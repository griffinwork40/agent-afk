/**
 * Wire the durable handoff store into the daemon elicitation path.
 *
 * Two entry points:
 *
 * 1. `makeDaemonElicitationHandler` — an ElicitationHandler that writes a
 *    HandoffRecord to disk BEFORE sending a Telegram notification, so the
 *    question survives a daemon restart. When the operator answers via
 *    Telegram, `updateHandoffAnswer` is called to record the answer.
 *
 * 2. `recoverPendingHandoffs` — called on daemon startup to re-notify the
 *    operator for any handoffs in status 'pending' (questions that were asked
 *    before the daemon restarted but never answered).
 *
 * Contract: handoff-store.ts is the durable persistence layer; this module
 * is the integration glue that wires it into the daemon scheduler and
 * Telegram notification path. The in-process elicitation router remains the
 * fast path for interactive surfaces (REPL, Telegram bot); this module is
 * the crash-recovery fallback for headless daemon tasks.
 *
 * @module agent/daemon/handoff-wiring
 */

import type { ElicitationHandler } from '../elicitation-router.js';
import type { ElicitationRequest, ElicitationResult } from '../types/sdk-types.js';
import {
  writeHandoff,
  listPendingHandoffs,
  updateHandoffAnswer,
  deleteHandoff,
  type HandoffRecord,
} from './handoff-store.js';
import { setLeaseState } from './lease-store.js';
import { pushIfConfigured } from '../../telegram/push.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default TTL for daemon handoffs: 24 hours.
 * After this, the handoff transitions to 'expired' during the next recovery
 * sweep and the originating task is dead-lettered.
 */
const DEFAULT_HANDOFF_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Cap on the question text echoed to Telegram. Mirrors the elicitation
 * router's MAX_NOTIFY_MESSAGE_CHARS (300) for consistency.
 */
const MAX_NOTIFY_CHARS = 300;

function truncateForNotify(text: string): string {
  return text.length <= MAX_NOTIFY_CHARS
    ? text
    : `${text.slice(0, MAX_NOTIFY_CHARS)}…(truncated)`;
}

// ---------------------------------------------------------------------------
// Daemon elicitation handler
// ---------------------------------------------------------------------------

/**
 * Options for `makeDaemonElicitationHandler`.
 */
export interface DaemonElicitationOpts {
  /** Task ID for the running daemon task (used as the handoff key). */
  taskId: string;
  /** The original command string for the daemon task (preserved for replay). */
  originalCommand: string;
  /**
   * Queue directory override (for testing). Defaults to the global queue dir
   * resolved by lease-store.
   */
  queueDir?: string;
  /**
   * Handoffs directory override (for testing). Defaults to getHandoffsDir().
   */
  handoffsDir?: string;
}

/**
 * Build an ElicitationHandler for daemon-spawned sessions.
 *
 * When the agent calls `ask_question`, this handler:
 *   1. Writes a HandoffRecord to disk (write-before-notify invariant).
 *   2. Transitions the task's lease state to 'waiting_human_input' so lease
 *      recovery does not incorrectly reclaim the task while a human decides.
 *   3. Sends a Telegram notification with the question.
 *   4. Returns { action: 'decline' } — the daemon session is non-interactive
 *      and cannot block waiting for a synchronous answer. The durable handoff
 *      record is the mechanism for eventual delivery.
 *
 * Invariant: the HandoffRecord is written BEFORE the Telegram notification.
 * If the process crashes between write and send, the startup recovery loop
 * re-sends the notification. If it crashes between send and write (impossible
 * with this ordering), the question would be lost.
 */
export function makeDaemonElicitationHandler(
  opts: DaemonElicitationOpts,
): ElicitationHandler {
  return async (
    request: ElicitationRequest,
    options: { signal: AbortSignal; sessionId?: string },
  ): Promise<ElicitationResult> => {
    if (options.signal.aborted) return { action: 'decline' };

    const record: HandoffRecord = {
      taskId: opts.taskId,
      sessionId: options.sessionId ?? '',
      question: serializeRequest(request),
      requestType: 'ask_question',
      createdAt: new Date().toISOString(),
      status: 'pending',
      originalCommand: opts.originalCommand,
    };

    // Step 1: persist the handoff record BEFORE any notification.
    try {
      await writeHandoff(record, opts.handoffsDir);
    } catch (err) {
      // If we cannot persist, decline immediately — better to lose the
      // question than to send a notification with no durable backing.
      // eslint-disable-next-line no-console
      console.error(
        `[handoff-wiring] failed to write handoff for task ${opts.taskId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return { action: 'decline' };
    }

    // Step 2: transition the lease to 'waiting_human_input' so lease recovery
    // skips this task while the human is being asked.
    try {
      setLeaseState(opts.taskId, 'waiting_human_input', opts.queueDir);
    } catch {
      // Non-fatal: if the lease update fails, the worst case is that lease
      // recovery might reclaim the task — the handoff record still exists
      // for manual recovery.
    }

    // Step 3: send a Telegram notification. Fire-and-forget.
    const questionText = truncateForNotify(request.message);
    const parts = [
      `🔔 Daemon task waiting for your answer`,
      `📋 Task: ${opts.taskId}`,
      questionText,
    ];
    if (request.choices && request.choices.length > 0) {
      parts.push(`Options: ${request.choices.join(', ')}`);
    }
    parts.push(`\nReply to this task's next run to provide your answer.`);
    void pushIfConfigured(parts.join('\n')).catch(() => undefined);

    // Step 4: decline — daemon sessions cannot block on a synchronous answer.
    // The durable handoff record is the mechanism for eventual delivery.
    return { action: 'decline' };
  };
}

// ---------------------------------------------------------------------------
// Startup recovery
// ---------------------------------------------------------------------------

/**
 * Result of a recovery sweep: how many handoffs were re-notified and how
 * many were expired.
 */
export interface RecoveryResult {
  renotified: number;
  expired: number;
}

/**
 * On daemon startup, scan for pending handoffs and re-notify the operator.
 *
 * For each pending handoff:
 *   - If the handoff has exceeded DEFAULT_HANDOFF_TTL_MS, transition it to
 *     'expired' and log.
 *   - Otherwise, send a reminder Telegram notification so the operator knows
 *     a question is still waiting.
 *
 * Best-effort and self-logging: individual failures are logged but do not
 * prevent processing of other handoffs. The caller can fire-and-forget.
 * Returns a summary for programmatic callers.
 */
export async function recoverPendingHandoffs(
  handoffsDir?: string,
): Promise<RecoveryResult> {
  const result: RecoveryResult = { renotified: 0, expired: 0 };

  let pending: HandoffRecord[];
  try {
    pending = await listPendingHandoffs(handoffsDir);
  } catch {
    return result;
  }

  const now = Date.now();

  for (const record of pending) {
    const createdMs = new Date(record.createdAt).getTime();
    const age = now - createdMs;

    if (age > DEFAULT_HANDOFF_TTL_MS) {
      // Handoff has expired — transition to 'expired' and clean up.
      try {
        const expired: HandoffRecord = {
          ...record,
          status: 'expired',
        };
        await writeHandoff(expired, handoffsDir);
        result.expired += 1;
        // eslint-disable-next-line no-console
        console.error(
          `[handoff-wiring] expired stale handoff for task ${record.taskId} (age: ${Math.round(age / 3_600_000)}h)`,
        );
      } catch {
        // Skip — leave the record as-is for the next sweep.
      }
      continue;
    }

    // Re-notify the operator.
    try {
      const questionText = typeof record.question['message'] === 'string'
        ? truncateForNotify(record.question['message'] as string)
        : '(question details unavailable)';
      const parts = [
        `🔔 Reminder: daemon task still waiting for your answer`,
        `📋 Task: ${record.taskId}`,
        questionText,
        `⏱️ Waiting for ${Math.round(age / 60_000)} minutes`,
      ];
      void pushIfConfigured(parts.join('\n')).catch(() => undefined);
      result.renotified += 1;
    } catch {
      // Non-fatal — continue with other handoffs.
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Answer recording (called by external surfaces)
// ---------------------------------------------------------------------------

/**
 * Record a human answer for a pending handoff and clean up.
 *
 * Called by Telegram reply handlers (or any future surface) when the operator
 * provides an answer to a pending handoff question.
 *
 * @param taskId - The daemon task ID whose handoff to answer.
 * @param answer - The human's response value.
 * @param source - Which surface provided the answer ('telegram' | 'web' | 'repl').
 * @param handoffsDir - Override for testing.
 * @returns true if this caller won the first-writer CAS, false if another
 *   surface already answered.
 */
export async function answerHandoff(
  taskId: string,
  answer: unknown,
  source: string,
  handoffsDir?: string,
): Promise<boolean> {
  const result = await updateHandoffAnswer(taskId, answer, source, handoffsDir);
  return result.won;
}

/**
 * Clean up a handoff record after the answer has been consumed.
 * Delegates to deleteHandoff for idempotent removal.
 */
export async function cleanupHandoff(
  taskId: string,
  handoffsDir?: string,
): Promise<void> {
  await deleteHandoff(taskId, handoffsDir);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Serialize an ElicitationRequest into a plain Record for durable storage.
 * Strips non-serializable fields (functions, symbols) and preserves only
 * the JSON-safe question metadata needed for re-presentation.
 */
function serializeRequest(request: ElicitationRequest): Record<string, unknown> {
  const out: Record<string, unknown> = {
    message: request.message,
  };
  if (request.type !== undefined) out['type'] = request.type;
  if (request.choices !== undefined) out['choices'] = request.choices;
  if (request.context !== undefined) out['context'] = request.context;
  if (request.title !== undefined) out['title'] = request.title;
  if (request.serverName !== undefined) out['serverName'] = request.serverName;
  if (request.allowSkip !== undefined) out['allowSkip'] = request.allowSkip;
  if (request.allowCustom !== undefined) out['allowCustom'] = request.allowCustom;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if ((request as Record<string, unknown>)['questionDefault'] !== undefined) {
    out['questionDefault'] = (request as Record<string, unknown>)['questionDefault'];
  }
  if (request.min !== undefined) out['min'] = request.min;
  if (request.max !== undefined) out['max'] = request.max;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if ((request as Record<string, unknown>)['minLength'] !== undefined) {
    out['minLength'] = (request as Record<string, unknown>)['minLength'];
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if ((request as Record<string, unknown>)['maxLength'] !== undefined) {
    out['maxLength'] = (request as Record<string, unknown>)['maxLength'];
  }
  return out;
}
