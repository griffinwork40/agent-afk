import { pickResumeFields, type HandoffResumeContext } from './handoff-resume-context.js';
import { writeHandoff, type HandoffRecord } from './handoff-store.js';
import { pushHandoffQuestion } from './handoff-notify.js';
import { errorMessage } from '../../utils/errors.js';
import type { ElicitationHandler } from '../elicitation-router.js';
import { serializeRequest } from './elicitation-serialize.js';
import type { Telegraf } from 'telegraf';
import { sendHandoffQuestion } from '../../telegram/handoff-answer.js';
import { resolveConfiguredNotifyTargets } from '../../telegram/notify-routing.js';

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…(truncated)` : text;
}

/** Bound the header fields independently of the answer instructions. */
export function formatCronElicitationMessage(
  taskId: string,
  command: string,
  cron: string | undefined,
  question: string,
): string {
  const cronNote = cron !== undefined ? ` (cron: ${truncate(cron, 120)})` : '';
  return (
    `[daemon] Cron task "${truncate(taskId, 128)}"${cronNote} needs your input.\n` +
    `Command: ${truncate(command, 500)}\n` +
    `Question: ${truncate(question, 300)}`
  );
}

interface CronElicitationHandlerOpts {
  taskId: string;
  /** Secret-redacted by the caller. */
  originalCommand: string;
  handoffsDir?: string;
  cronExpression?: string;
  resumeContext?: HandoffResumeContext;
  /** Co-hosted Telegraf instance; when present each target gets the rich question first. */
  bot?: Telegraf;
  /**
   * The task's explicit `notifyChat`, already alias-resolved AND allowlisted by
   * the caller. When set it is the ONLY delivery target; configured defaults
   * are not consulted. Omit to use configured notify routing.
   */
  overrideChatId?: number;
  /**
   * The co-hosted bot's primary chat. Used ONLY to map `primaryThreadId` onto
   * that chat when it is also a resolved target — never as a target itself.
   */
  primaryChatId?: number;
  primaryThreadId?: number;
  /** Configured default targets (primary/broadcast/custom). Injectable for tests. */
  resolveDefaultTargets?: () => readonly number[];
  /** Signal the run to omit the completion notice once a durable question exists. */
  onHandoffWritten?: () => void;
}

/**
 * Resolve the cron question's delivery targets BEFORE any send: the
 * allowlisted override alone, else the configured notify routing. De-duplicated
 * so no chat ever receives the question twice.
 */
export function resolveCronQuestionTargets(
  overrideChatId: number | undefined,
  resolveDefaultTargets: () => readonly number[] = resolveConfiguredNotifyTargets,
): number[] {
  const raw = overrideChatId !== undefined ? [overrideChatId] : resolveDefaultTargets();
  return [...new Set(raw.filter((id) => Number.isFinite(id) && id !== 0))];
}

/** Persist before notifying, then decline without waiting for a human answer. */
export function makeCronElicitationHandler(opts: CronElicitationHandlerOpts): ElicitationHandler {
  return async (request, { signal, sessionId }) => {
    if (signal.aborted) return { action: 'decline' };

    const draft: HandoffRecord = {
      taskId: opts.taskId,
      sessionId: sessionId ?? '',
      question: serializeRequest(request),
      requestType: 'ask_question',
      createdAt: new Date().toISOString(),
      status: 'pending',
      originalCommand: opts.originalCommand,
      ...pickResumeFields(opts.resumeContext),
    };
    let record: HandoffRecord;
    try {
      record = await writeHandoff(draft, opts.handoffsDir);
    } catch (err) {
      console.error('[cron-elicitation] failed to write handoff for task %s: %s', opts.taskId, errorMessage(err));
      return { action: 'decline' };
    }

    opts.onHandoffWritten?.();
    if (record.notifyOn === 'never') return { action: 'decline' };

    const targets = resolveCronQuestionTargets(opts.overrideChatId, opts.resolveDefaultTargets);
    if (targets.length === 0) {
      console.error('[cron-elicitation] no Telegram target for task %s; handoff remains pending', opts.taskId);
      return { action: 'decline' };
    }

    const message = formatCronElicitationMessage(opts.taskId, opts.originalCommand, opts.cronExpression, request.message);

    // Each resolved target is delivered independently: rich bot send first
    // (when co-hosted), then a raw interactive push to that
    // target only if the bot send failed. One target's failure never re-sends
    // to another target, and no chat outside `targets` is ever contacted.
    let failed = 0;
    for (const chatId of targets) {
      const threadId = chatId === opts.primaryChatId ? opts.primaryThreadId : undefined;
      if (opts.bot !== undefined) {
        // The sender normally reports a failed send as { ok: false }.
        const sent = await sendHandoffQuestion({
          bot: opts.bot,
          record,
          chatId,
          handoffsDir: opts.handoffsDir,
          ...(threadId !== undefined ? { threadId } : {}),
        }).catch(() => undefined);
        if (sent?.ok) continue;
      }
      const sent = await pushHandoffQuestion(record, message, {
        target: chatId,
        messageThreadId: threadId,
        handoffsDir: opts.handoffsDir,
      }).catch(() => false);
      if (!sent) failed += 1;
    }
    if (failed > 0) {
      console.error(
        '[cron-elicitation] Telegram delivery failed for %d of %d target(s) for task %s; handoff remains pending',
        failed, targets.length, opts.taskId,
      );
    }
    return { action: 'decline' };
  };
}
