/**
 * Telegram-side delivery for settled background subagent jobs.
 *
 * Subscribes to a {@link BackgroundAgentRegistry}'s `settled` event and does
 * two things per non-cancelled job — the Telegram analog of the REPL's
 * `BgResultNotifier`:
 *
 *   1. **Operator push** — a status line followed by the result body, sent via
 *      {@link pushIfConfigured} (which splits past Telegram's 4096-char limit
 *      with `splitLongMessage`). The body is capped at 16KB with a
 *      `/bgsub:join <jobId>` marker, the same cap the REPL injection uses.
 *   2. **Next-turn model injection** — the job is buffered and drained as a
 *      `<background-subagent-result>` envelope (the REPL's
 *      `buildBgResultInjection`) by the message handler, which prepends it to
 *      the next incoming turn for this chat/topic (see `./bg-injection.ts`).
 *
 * Cancelled jobs are skipped (same contract as the REPL notifier): explicit
 * cancels are operator-initiated and cascade cancels fire during teardown when
 * nothing useful can be surfaced.
 *
 * Lifecycle: construct after the registry, call {@link dispose} on session
 * close so the `settled` listener and the route registration are removed.
 *
 * @module telegram/bg-result-notifier
 */

import type {
  BackgroundAgentRegistry,
  BackgroundJob,
} from '../agent/background-registry.js';
import {
  buildBgResultInjection,
  formatBgResultBody,
} from '../cli/commands/interactive/bg-result-notifier.js';
import { pushIfConfigured } from './push.js';
import { formatDuration } from '../cli/format-utils.js';
import { routeKey } from './route.js';
import { registerBgInjectionSource, unregisterBgInjectionSource } from './bg-injection.js';

/** Maximum number of pending injections kept; oldest dropped (matches REPL). */
const MAX_PENDING = 25;

/** Status emoji for the push notification. */
function statusEmoji(status: BackgroundJob['status']): string {
  switch (status) {
    case 'completed': return '✅';
    case 'failed':    return '❌';
    default:          return '⚙️';
  }
}

/**
 * Format the push for a settled background job: a one-line status header,
 * then the (16KB-capped) result body when there is one.
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
  const header = `${emoji} Background task ${job.status}: ${label} · ${duration}`;
  const body = formatBgResultBody(job).trim();
  return body ? `${header}\n\n${body}` : header;
}

export class TelegramBgResultNotifier {
  /** Settled jobs awaiting injection into this chat's next turn. */
  private pendingInjections: BackgroundJob[] = [];
  /** Route key this notifier is registered under, when bound to a chat. */
  private readonly routeKey: string | undefined;
  /**
   * Set to `true` by {@link dispose}. Guards the deferred microtask body so
   * that a push enqueued via `queueMicrotask` before `dispose()` runs does not
   * fire after teardown — i.e. covers the window where `settled` fires and
   * `dispose()` is called in the same synchronous frame.
   */
  private disposed = false;

  private readonly onSettled = (job: BackgroundJob): void => {
    // Skip cancelled jobs — same as the REPL notifier contract.
    if (job.status === 'cancelled') return;

    // Fire-and-forget: a push failure here is non-fatal — the job already
    // settled, its result is still injected next turn and join-able.
    // formatNotification (which calls formatBgResultBody) is deferred via
    // queueMicrotask so that a burst of settled events does not allocate
    // 16KB bodies synchronously on the event loop — formatting and push both
    // happen off the current synchronous call frame.
    queueMicrotask(() => {
      // Guard: if dispose() ran in the same synchronous frame as the settled
      // event (before this microtask ran), skip the push — the session is
      // already torn down and there is no valid operator to notify.
      if (this.disposed) return;
      void pushIfConfigured(formatNotification(job), {
        target: this.chatId,
        ...(this.threadId !== undefined ? { messageThreadId: this.threadId } : {}),
      }).catch((err: unknown) => {
        console.error(`[bg-notifier] push failed for job ${job.jobId}:`, err);
      });
    });

    this.pendingInjections.push(job);
    if (this.pendingInjections.length > MAX_PENDING) {
      this.pendingInjections.shift();
    }
  };

  /**
   * @param registry  The session's background agent registry.
   * @param chatId    Telegram chat id to push notifications to. When undefined,
   *                  pushIfConfigured uses the default notify targets and no
   *                  next-turn injection route is registered.
   * @param threadId  Telegram topic thread id. When set, notifications are
   *                  delivered to this specific topic thread instead of General.
   */
  constructor(
    private readonly registry: BackgroundAgentRegistry,
    private readonly chatId?: number,
    private readonly threadId?: number,
  ) {
    registry.on('settled', this.onSettled);
    if (chatId !== undefined) {
      this.routeKey = routeKey({ chatId, ...(threadId !== undefined ? { threadId } : {}) });
      registerBgInjectionSource(this.routeKey, this);
    }
  }

  /**
   * Drain and return the concatenated injection envelopes to prepend to the
   * next user message. Empty string when nothing is queued. Marks each job
   * delivered in the witness trace (same accounting as the REPL notifier).
   */
  drainInjections(): string {
    if (this.pendingInjections.length === 0) return '';
    const jobs = this.pendingInjections;
    this.pendingInjections = [];
    for (const job of jobs) this.registry.markDelivered(job.jobId);
    return jobs.map((j) => buildBgResultInjection(j)).join('\n') + '\n';
  }

  /** Unsubscribe from the registry and drop the route registration. Idempotent. */
  dispose(): void {
    this.disposed = true;
    this.registry.off('settled', this.onSettled);
    if (this.routeKey !== undefined) unregisterBgInjectionSource(this.routeKey, this);
    // Mark any buffered-but-undrained jobs delivered so the witness trace
    // accounts for them. dispose() is called at session teardown — drainInjections()
    // will not be called afterward, so this is the only accounting opportunity.
    for (const job of this.pendingInjections) this.registry.markDelivered(job.jobId);
    this.pendingInjections = [];
  }
}
