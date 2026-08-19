/**
 * Telegram-side push notification for settled background subagent jobs.
 *
 * Subscribes to a {@link BackgroundAgentRegistry}'s `settled` event and sends
 * a short status message to the configured Telegram notify targets via
 * {@link pushIfConfigured}. This is the Telegram analog of the REPL's
 * {@link BgResultNotifier} — but delivery is push-based (Telegram API) rather
 * than pull-based (injection into the next user turn).
 *
 * Cancelled jobs are skipped (same contract as the REPL notifier): explicit
 * cancels are operator-initiated and cascade cancels fire during teardown when
 * nothing useful can be surfaced.
 *
 * Lifecycle: construct after the registry, call {@link dispose} on session
 * close so the `settled` listener is removed.
 *
 * @module telegram/bg-result-notifier
 */

import type {
  BackgroundAgentRegistry,
  BackgroundJob,
} from '../agent/background-registry.js';
import { pushIfConfigured } from './push.js';
import { formatDuration } from '../cli/format-utils.js';

/** Status emoji for the push notification. */
function statusEmoji(status: BackgroundJob['status']): string {
  switch (status) {
    case 'completed': return '✅';
    case 'failed':    return '❌';
    default:          return '⚙️';
  }
}

/**
 * Format a one-line push notification for a settled background job.
 *
 * The notification intentionally omits the full result body — it is a nudge
 * to the operator ("your background task finished"), not a delivery vehicle.
 * The model receives the full result via the next-turn injection path (Phase 3,
 * deferred).
 */
function formatNotification(job: BackgroundJob): string {
  const emoji = statusEmoji(job.status);
  const duration =
    job.endedAt !== undefined
      ? formatDuration(job.endedAt - job.startedAt)
      : 'unknown';

  // Label is the first ~80 chars of the dispatch prompt — already truncated
  // by the registry's own `register()`.
  const label = job.label || job.jobId;

  return `${emoji} Background task ${job.status}: ${label} · ${duration}`;
}

export class TelegramBgResultNotifier {
  private readonly onSettled = (job: BackgroundJob): void => {
    // Skip cancelled jobs — same as the REPL notifier contract.
    if (job.status === 'cancelled') return;

    const text = formatNotification(job);
    // Fire-and-forget: a push failure here is non-fatal — the job already
    // settled and its result is available via the registry. Log failures for
    // observability since push is the ONLY delivery path on Telegram (unlike
    // REPL which also injects results into the next turn).
    void pushIfConfigured(text, { target: this.chatId }).catch((err: unknown) => {
      // Non-fatal: the job result is still in the registry (join-able).
      console.error(`[bg-notifier] push failed for job ${job.jobId}:`, err);
    });
    // Emit a background_agent.delivered witness event so trace readers can
    // distinguish push-notified settlements from explicit /bgsub:join calls.
    this.registry.markDelivered(job.jobId);
  };

  /**
   * @param registry  The session's background agent registry.
   * @param chatId    Telegram chat id to push notifications to. When undefined,
   *                  pushIfConfigured uses the default notify targets.
   */
  constructor(
    private readonly registry: BackgroundAgentRegistry,
    private readonly chatId?: number,
  ) {
    registry.on('settled', this.onSettled);
  }

  /** Unsubscribe from the registry. Idempotent. */
  dispose(): void {
    this.registry.off('settled', this.onSettled);
  }
}
