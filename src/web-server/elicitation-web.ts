/**
 * Bridges agent elicitations (approvals, questions) to connected browsers.
 *
 * Invariant: `elicitationRouter` is a SINGLE-SLOT, last-writer-wins,
 * process-wide singleton — `install()` bare-overwrites whatever handler is
 * already registered. Consequences that shape this module:
 *
 *   - Install exactly ONCE, at server bootstrap, and uninstall on stop().
 *     Installing per-session or per-connection would clobber the previous
 *     handler and strand its pending requests forever.
 *   - Only sessions running INSIDE this process can be served. A REPL, daemon,
 *     or Telegram session in another OS process has its own handler in its own
 *     memory; nothing here can reach it. Those sessions are attach-only, which
 *     is why the routes layer rejects prompt/approve for them with 409.
 */

import { elicitationRouter } from '../agent/elicitation-router.js';
import type { ElicitationRequest, ElicitationResult } from '../agent/types/sdk-types.js';

/** A request awaiting an answer from a browser. */
export interface PendingElicitation {
  id: string;
  request: ElicitationRequest;
  sessionId?: string;
  createdAt: string;
}

type Waiter = {
  resolve: (result: ElicitationResult) => void;
  pending: PendingElicitation;
};

/** Listener notified when the pending set changes, so SSE clients can update. */
export type PendingListener = (pending: PendingElicitation[]) => void;

export class WebElicitationBridge {
  private readonly waiters = new Map<string, Waiter>();
  private readonly listeners = new Set<PendingListener>();
  private counter = 0;
  private installed = false;

  /** Install this bridge as THE process elicitation handler. Idempotent. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    elicitationRouter.install((request, options) => this.enqueue(request, options));
  }

  /** Remove the handler and decline anything still outstanding. */
  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    elicitationRouter.uninstall();
    for (const id of [...this.waiters.keys()]) {
      // Contract: never leave a caller awaiting a promise that can no longer be
      // answered — a stranded elicitation hangs the agent turn indefinitely.
      this.settle(id, { action: 'decline' });
    }
  }

  /** Currently unanswered requests, oldest first. */
  list(): PendingElicitation[] {
    return [...this.waiters.values()].map((w) => w.pending);
  }

  onChange(listener: PendingListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Answer a pending request. Returns false when the id is unknown (already
   * answered, aborted, or never existed) so the route can reply 404 instead of
   * pretending success.
   */
  resolve(id: string, response: unknown): boolean {
    const waiter = this.waiters.get(id);
    if (!waiter) return false;
    this.settle(id, normalizeResult(response));
    return true;
  }

  private enqueue(
    request: ElicitationRequest,
    options: { signal: AbortSignal },
  ): Promise<ElicitationResult> {
    this.counter += 1;
    const id = `el_${this.counter}`;
    // Contract: the router passes `onActive`/`sessionId` at runtime but the
    // published ElicitationHandler type declares only `signal`. Read the extras
    // defensively rather than widening the handler signature, so this stays
    // assignable to the type the router actually accepts.
    const extras = options as { onActive?: () => void; sessionId?: string };
    extras.onActive?.();

    return new Promise<ElicitationResult>((resolve) => {
      const pending: PendingElicitation = {
        id,
        request,
        createdAt: new Date().toISOString(),
        ...(extras.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
      };
      this.waiters.set(id, { resolve, pending });
      this.emit();

      // An aborted turn must release the waiter, or the agent hangs on a
      // question no one will ever see.
      const onAbort = (): void => {
        this.settle(id, { action: 'cancel' });
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private settle(id: string, result: ElicitationResult): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    waiter.resolve(result);
    this.emit();
  }

  private emit(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken SSE client must never break the elicitation path.
      }
    }
  }
}

/**
 * Coerce a browser-supplied response body into an ElicitationResult.
 *
 * Contract: `ElicitationResult.content` is a `Record<string, unknown>`, so a
 * bare scalar from the browser is wrapped rather than cast. An unrecognized
 * `action` falls back to 'accept' only when the payload is object-shaped;
 * anything else declines, so a malformed body can never be read as approval.
 */
function normalizeResult(response: unknown): ElicitationResult {
  if (typeof response !== 'object' || response === null) {
    return response === undefined
      ? { action: 'decline' }
      : { action: 'accept', content: { value: response } };
  }
  const record = response as Record<string, unknown>;
  const action = record['action'];
  if (action === 'accept' || action === 'decline' || action === 'cancel' || action === 'skip') {
    const content = record['content'];
    return typeof content === 'object' && content !== null
      ? { action, content: content as Record<string, unknown> }
      : { action };
  }
  return { action: 'accept', content: record };
}
