/**
 * Module-scope router for MCP elicitation requests.
 *
 * The SDK's `Options.onElicitation` is a single callback per session. In
 * agent-afk, multiple surfaces might want to serve elicitations:
 *   - the interactive REPL (prompt the user on stdin);
 *   - the Telegram bridge (forward to a chat);
 *   - the iMessage bridge (likewise).
 *
 * Rather than thread a handler through every session-construction site,
 * we install one module-scope handler at surface startup. `buildQueryOptions`
 * threads a thin shim as `options.onElicitation`; the shim delegates to
 * whatever handler is currently installed. If no handler is installed,
 * the shim auto-declines (matching the SDK's documented default) so the
 * session keeps working even when nobody has opted into elicitation UX.
 *
 * Guarantees:
 *   - Handler rejection → `{ action: 'decline' }`. Never propagate errors
 *     into the SDK's request/response plumbing.
 *   - Abort → `{ action: 'decline' }`. `route()` races the handler against
 *     the turn's abort signal, so a pending question is always unblocked on
 *     teardown — even if the handler itself never observes its signal (e.g.
 *     the legacy readline fallback that blocks inside `rl.question`).
 *   - Pre-aborted signal → `{ action: 'decline' }`. If the session is
 *     already being torn down we don't prompt.
 *
 * Non-guarantee, by design: there is NO time-based deadline. A question to an
 * AFK operator may legitimately wait minutes or hours for an answer; the
 * router never auto-declines on a timer. The wait ends only when the handler
 * resolves/rejects or the turn is aborted. (A 5-minute timeout lived here
 * until it was removed — it auto-declined real operators who simply stepped
 * away, which is exactly the AFK case this tool exists to serve.)
 */

import type { ElicitationRequest, ElicitationResult } from './types/sdk-types.js';

export type ElicitationHandler = (
  request: ElicitationRequest,
  options: { signal: AbortSignal },
) => Promise<ElicitationResult>;

const DECLINE: ElicitationResult = { action: 'decline' };

class ElicitationRouter {
  private handler: ElicitationHandler | null = null;
  private queue: Promise<void> = Promise.resolve();
  private queueDepth = 0;

  install(handler: ElicitationHandler): void {
    this.handler = handler;
  }

  uninstall(): void {
    this.handler = null;
  }

  /** Number of requests currently waiting in (or executing from) the queue. */
  pendingCount(): number {
    return this.queueDepth;
  }

  route(
    request: ElicitationRequest,
    options: { signal: AbortSignal },
  ): Promise<ElicitationResult> {
    // Fast-path: already aborted before entering the queue
    if (options.signal.aborted) return Promise.resolve(DECLINE);

    this.queueDepth += 1;
    let resolveResult!: (result: ElicitationResult) => void;
    const resultPromise = new Promise<ElicitationResult>((resolve) => {
      resolveResult = resolve;
    });

    // Capture handler at enqueue time so a later install() doesn't affect
    // requests already in the queue.
    const capturedHandler = this.handler;

    // Chain onto the serial queue; each call waits for all prior calls to finish.
    this.queue = this.queue.then(async () => {
      try {
        // Re-check abort after waiting in queue
        if (options.signal.aborted) {
          resolveResult(DECLINE);
          return;
        }
        if (!capturedHandler) {
          resolveResult(DECLINE);
          return;
        }

        // Invariant: a pending elicitation is unblocked by EITHER the handler
        // settling OR the turn's abort signal — and by nothing else. There is
        // deliberately no time-based deadline (an AFK operator may take
        // minutes/hours to answer). Racing the handler against an abort-driven
        // decline keeps the SDK's elicitation request unblockable on teardown
        // even for a handler that never observes its own signal (e.g. the
        // legacy readline fallback blocked inside `rl.question`). The listener
        // is removed on every exit path so a long-lived per-turn signal never
        // accumulates listeners across successive questions.
        let onAbort!: () => void;
        const abortPromise = new Promise<ElicitationResult>((resolve) => {
          onAbort = () => resolve(DECLINE);
          options.signal.addEventListener('abort', onAbort, { once: true });
        });

        try {
          const result = await Promise.race([
            capturedHandler(request, options).catch(() => DECLINE),
            abortPromise,
          ]);
          resolveResult(result);
        } finally {
          options.signal.removeEventListener('abort', onAbort);
        }
      } finally {
        this.queueDepth -= 1;
        // Safety net: resultPromise must always resolve so the SDK's
        // elicitation request never hangs. The inner `.catch(() => DECLINE)`
        // covers handler rejections, but a non-async handler that
        // *synchronously* throws would bubble past the inner try and be
        // swallowed by `.catch(() => {})` on the queue chain, leaving
        // `resultPromise` pending forever. Idempotent: Promise resolve ignores
        // later calls, so on the happy path this is a no-op.
        resolveResult(DECLINE);
      }
    }).catch(() => {});

    return resultPromise;
  }
}

export const elicitationRouter = new ElicitationRouter();

/**
 * The shim {@link buildQueryOptions} installs as `options.onElicitation`.
 * Indirection lets surfaces (`src/cli/commands/interactive.ts`, telegram)
 * hot-swap handlers without reconstructing the session.
 */
export async function routeElicitation(
  request: ElicitationRequest,
  options: { signal: AbortSignal },
): Promise<ElicitationResult> {
  return elicitationRouter.route(request, options);
}
