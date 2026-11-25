import { pickResumeFields, type HandoffResumeContext } from './handoff-resume-context.js';
import { writeHandoff, type HandoffRecord } from './handoff-store.js';
import { buildHandoffReplyMarkup } from './handoff-wiring.js';
import { errorMessage } from '../../utils/errors.js';
import type { ElicitationHandler } from '../elicitation-router.js';
import { serializeRequest } from './elicitation-serialize.js';
import { operatorNotify } from '../operator-notify.js';
import type { Telegraf } from 'telegraf';
import { sendHandoffQuestion } from '../../telegram/handoff-answer.js';

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…(truncated)` : text;
}

/** Bound all fields so the raw push sends one message per target. */
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
  bot?: Telegraf;
  /** Resolved/allowlisted override or a trusted primary chat; omitted for default push routing. */
  chatId?: number;
  threadId?: number;
  /** Signal the run to omit the completion notice once a durable question exists. */
  onHandoffWritten?: () => void;
}

/** Persist before notifying, then decline without waiting for a human answer. */
export function makeCronElicitationHandler(opts: CronElicitationHandlerOpts): ElicitationHandler {
  return async (request, { signal, sessionId }) => {
    if (signal.aborted) return { action: 'decline' };

    const record: HandoffRecord = {
      taskId: opts.taskId,
      sessionId: sessionId ?? '',
      question: serializeRequest(request),
      requestType: 'ask_question',
      createdAt: new Date().toISOString(),
      status: 'pending',
      originalCommand: opts.originalCommand,
      ...pickResumeFields(opts.resumeContext),
    };
    try {
      await writeHandoff(record, opts.handoffsDir);
    } catch (err) {
      console.error(`[cron-elicitation] failed to write handoff for task ${opts.taskId}:`, errorMessage(err));
      return { action: 'decline' };
    }

    opts.onHandoffWritten?.();
    if (record.notifyOn === 'never') return { action: 'decline' };

    if (opts.bot !== undefined && opts.chatId !== undefined) {
      // Also handles co-hosted text replies. The sender normally reports a
      // failed send as { ok: false }, not as a rejected promise.
      const sent = await sendHandoffQuestion({
        bot: opts.bot,
        record,
        chatId: opts.chatId,
        handoffsDir: opts.handoffsDir,
        ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
      }).catch(() => undefined);
      if (sent?.ok) return { action: 'decline' };
    }

    const replyMarkup = buildHandoffReplyMarkup(request.type ?? 'text', opts.taskId, request.choices);
    const message = formatCronElicitationMessage(opts.taskId, opts.originalCommand, opts.cronExpression, request.message);
    const choices = !replyMarkup && Array.isArray(request.choices) && request.choices.length > 0
      ? `\nOptions: ${truncate(request.choices.join(', '), 300)}`
      : '';
    const hint = replyMarkup ? '' : '\nSee /handoffs for the pending question.';
    const results = await operatorNotify(message + choices + hint, {
      target: opts.chatId,
      messageThreadId: opts.threadId,
      replyMarkup,
    }).catch(() => undefined);
    if (results === undefined || results?.some((result) => !result.ok)) {
      console.error(`[cron-elicitation] Telegram delivery failed for task ${opts.taskId}; handoff remains pending`);
    }
    return { action: 'decline' };
  };
}
