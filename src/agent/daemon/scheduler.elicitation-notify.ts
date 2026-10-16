/**
 * Cron-task elicitation visibility (#3243 gap 1 — partial).
 *
 * When a cron or sessionstart task's agent calls `ask_question`, the
 * elicitation router has no handler installed (only pull tasks wire one via
 * `makeDaemonElicitationHandler`). The router's built-in
 * `notifyUnattendedElicitation` fires a generic Telegram push, but it has no
 * task context: it doesn't name the task, doesn't write a durable handoff
 * record, and doesn't respect the task's `notifyOn` setting.
 *
 * This module provides `makeCronElicitationHandler` — a lightweight handler
 * for cron/sessionstart tasks that:
 *
 *   1. Writes a durable `HandoffRecord` so the question survives a restart
 *      and the handoff maintenance tick (handoff-maintenance.ts, every trigger
 *      mode) can resume it with the answer via `processAnsweredHandoffs`.
 *   2. Sends a task-aware Telegram notification (names the task, respects
 *      `notifyOn` via the injected `notify` callback).
 *   3. Returns `{ action: 'decline' }` immediately — cron sessions cannot
 *      block on a synchronous answer; the operator answers later and the
 *      handoff is consumed on the next maintenance tick.
 *
 * Deliberately omits the `setLeaseState('waiting_human_input')` step used
 * by `makeDaemonElicitationHandler` for pull tasks: cron tasks have no
 * durable lease file, so there is nothing to transition.
 *
 * The `formatCronElicitationMessage` helper is also exported so the
 * scheduler can supply it as `responseText` inside a `TaskCompletionDetails`
 * object — this routes the notification through the normal `onTaskComplete`
 * path (honours `notifyOn: 'always' | 'failure' | 'never'` and
 * `notifyChat`) rather than firing a raw unconditional push.
 *
 * @module agent/daemon/scheduler.elicitation-notify
 */

import { writeHandoff, type HandoffRecord } from './handoff-store.js';
import { errorMessage } from '../../utils/errors.js';
import { debugLog } from '../../utils/debug.js';
import type { ElicitationHandler } from '../elicitation-router.js';
import { serializeRequest } from './elicitation-serialize.js';
import type { Telegraf } from 'telegraf';
import { sendHandoffQuestion } from '../../telegram/handoff-answer.js';

// Re-export so callers only need one import for the whole cron-elicitation concern.
export type { ElicitationHandler };

// ---------------------------------------------------------------------------
// Notification message
// ---------------------------------------------------------------------------

/**
 * Plain-text notification body for a cron-task elicitation. Safe in all
 * Telegram parse modes (no markdown). Includes enough context for the
 * operator to decide how to respond without needing to look up the task.
 *
 * @param taskId   Scheduled task id (e.g. `my-deploy-task`).
 * @param command  The task command string (already secret-redacted).
 * @param cron     The cron expression, if any.
 * @param question The `message` field from the `ElicitationRequest`.
 */
export function formatCronElicitationMessage(
  taskId: string,
  command: string,
  cron: string | undefined,
  question: string,
): string {
  const cronNote = cron !== undefined ? ` (cron: ${cron})` : '';
  const cap = 300;
  const questionHead = question.length > cap ? `${question.slice(0, cap)}\u2026(truncated)` : question;
  return (
    `[daemon] Cron task "${taskId}"${cronNote} needs your input and cannot continue.\n` +
    `Command: ${command}\n` +
    `Question: ${questionHead}\n` +
    `The question has been saved as a handoff record. ` +
    `Answer via Telegram and the daemon will resume the task with your answer.`
  );
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Options for {@link makeCronElicitationHandler}.
 */
export interface CronElicitationHandlerOpts {
  /** Scheduled task id. */
  taskId: string;
  /** The task's command string (already secret-redacted by the caller). */
  originalCommand: string;
  /** Override the handoffs directory (tests). Defaults to `getHandoffsDir()`. */
  handoffsDir?: string;
  /**
   * Called synchronously after the handoff record is written and before the
   * handler returns. Receives the plain-text notification message so the
   * scheduler can pass it as `responseText` inside `TaskCompletionDetails`
   * and route it through `onTaskComplete` (honours `notifyOn`).
   * Best-effort: a throwing callback is swallowed; the handler always returns
   * `{ action: 'decline' }`.
   */
  onHandoffWritten?: (message: string) => void;
  /** Cron expression for the task, if any (included in notification text). */
  cronExpression?: string;
  /**
   * Telegraf bot instance. When provided together with `chatId`, the handler
   * sends a rich interactive handoff question (inline keyboard for
   * confirm/choice, reply-to-message for text/number) — the same path
   * `makeDaemonElicitationHandler` uses for pull tasks (#3243 item 2).
   * When absent, the `onHandoffWritten` callback routes the notification
   * through `onTaskComplete` (honours `notifyOn`/`notifyChat`).
   */
  bot?: Telegraf;
  /** Target Telegram chat ID for the rich handoff question. */
  chatId?: number;
  /** Optional topic thread ID for supergroups. */
  threadId?: number;
}

/**
 * Build an `ElicitationHandler` for cron and sessionstart daemon tasks.
 *
 * The handler writes a durable handoff, fires the `onHandoffWritten` callback
 * with a task-aware notification message, then immediately returns
 * `{ action: 'decline' }`.
 *
 * Install via `elicitationRouter.install(...)` before `session.sendMessage()`
 * and uninstall in the `finally` block — the same pattern `executeAgentTask`
 * already uses for pull tasks.
 */
export function makeCronElicitationHandler(
  opts: CronElicitationHandlerOpts,
): ElicitationHandler {
  const handler: ElicitationHandler = async (request, options) => {
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

    // Step 1: persist the handoff so the operator can answer later and
    // the maintenance tick resumes the task with the answer (#1416).
    let handoffWritten = false;
    try {
      await writeHandoff(record, opts.handoffsDir);
      handoffWritten = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[cron-elicitation] failed to write handoff for task ${opts.taskId}:`,
        errorMessage(err),
      );
    }

    // Step 2: send notification — rich Telegram handoff if bot+chatId are
    // available (#3243 item 2), otherwise fall back to the onHandoffWritten
    // callback which routes through onTaskComplete (honours notifyOn).
    if (handoffWritten) {
      if (opts.bot !== undefined && opts.chatId !== undefined) {
        // Rich interactive path: sends inline keyboards for confirm/choice and
        // enables reply-to-message matching for text/number answers — the same
        // path pull tasks use via makeDaemonElicitationHandler.
        void sendHandoffQuestion({
          bot: opts.bot,
          record,
          chatId: opts.chatId,
          ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
          handoffsDir: opts.handoffsDir,
        }).catch((err) => {
          // Log the delivery failure so it is visible in daemon logs (#3637).
          // The handoff record on disk still exists and can be answered later;
          // fall back to onHandoffWritten so notifyOn routing still fires.
          // eslint-disable-next-line no-console
          console.error(
            `[cron-elicitation] sendHandoffQuestion failed for task ${opts.taskId}:`,
            errorMessage(err),
          );
          if (opts.onHandoffWritten !== undefined) {
            const msg = formatCronElicitationMessage(
              opts.taskId,
              opts.originalCommand,
              opts.cronExpression,
              request.message,
            );
            try { opts.onHandoffWritten(msg); } catch (e) { debugLog('[cron-elicitation] onHandoffWritten fallback threw:', errorMessage(e)); }
          }
        });
      } else if (opts.onHandoffWritten !== undefined) {
        // Fallback: plain-text notification routed through onTaskComplete
        // so notifyOn / notifyChat are honoured.
        const msg = formatCronElicitationMessage(
          opts.taskId,
          opts.originalCommand,
          opts.cronExpression,
          request.message,
        );
        try {
          opts.onHandoffWritten(msg);
        } catch {
          // observational only — never let a notification failure break the run
        }
      }
    }

    // Step 3: decline immediately. Cron sessions cannot block on a
    // synchronous answer.
    return { action: 'decline' };
  };
  return handler;
}
