/** Server-instance-scoped, ephemeral command choices and progress (never ledger records). */
import type { ChoiceRequest, ChoiceProgressEvent, ChoiceSsePayload } from './shared/choice-wire.js';

export type ChoiceAnswerResult = 'answered' | 'unknown' | 'wrong_session' | 'invalid_value';
type Subscriber = (event: ChoiceSsePayload) => void;
interface PendingChoice {
  sessionId: string;
  request: ChoiceRequest;
  resolve: (value: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ChoiceBroker {
  private readonly pending = new Map<string, PendingChoice>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(private readonly timeoutMs = 120_000) {}

  /** Register before starting ledger replay so interactive requests cannot be lost. */
  subscribe(sessionId: string, subscriber: Subscriber): () => void {
    const set = this.subscribers.get(sessionId) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(sessionId, set);
    this.replayPending(sessionId, subscriber);
    return () => {
      set.delete(subscriber);
      if (set.size > 0) return;
      this.subscribers.delete(sessionId);
      // Once the last attached browser disconnects there is nobody left to answer.
      // A later command can still create a fresh choice on reconnect.
      this.cancelSession(sessionId);
    };
  }

  /** Re-send only live choices after a durable stream reset clears browser state. */
  replayPending(sessionId: string, subscriber: Subscriber): void {
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) this.deliver(subscriber, { type: 'choice_request', request: pending.request });
    }
  }

  choose(sessionId: string, request: ChoiceRequest, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return Promise.resolve(null);
    if (!request.corrId || this.pending.has(request.corrId)) {
      throw new Error('duplicate or empty choice correlation id');
    }
    if (!request.options.length || new Set(request.options.map((option) => option.value)).size !== request.options.length) {
      throw new Error('choice options must have unique values');
    }
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => this.settle(request.corrId, null), this.timeoutMs);
      timer.unref?.();
      const pending: PendingChoice = { sessionId, request, resolve, timer };
      this.pending.set(request.corrId, pending);
      // Re-check after registration: signal may have fired between the guard and set.
      if (signal?.aborted) { this.settle(request.corrId, null); return; }
      if (signal) {
        const onAbort = (): void => { this.settle(request.corrId, null); };
        signal.addEventListener('abort', onAbort, { once: true });
        const originalResolve = pending.resolve;
        pending.resolve = (value) => {
          signal.removeEventListener('abort', onAbort);
          originalResolve(value);
        };
        if (signal.aborted) this.settle(request.corrId, null);
      }
      if (this.pending.has(request.corrId)) this.publish(sessionId, { type: 'choice_request', request });
    });
  }

  answer(sessionId: string, corrId: string, value: string | null): ChoiceAnswerResult {
    const pending = this.pending.get(corrId);
    if (!pending) return 'unknown';
    if (pending.sessionId !== sessionId) return 'wrong_session';
    if (value === null ? !pending.request.cancellable : !pending.request.options.some((option) => option.value === value)) {
      return 'invalid_value';
    }
    this.settle(corrId, value);
    return 'answered';
  }

  progress(sessionId: string, event: ChoiceProgressEvent): void {
    this.publish(sessionId, { type: 'progress', ...event });
  }

  cancelSession(sessionId: string): void {
    for (const [corrId, pending] of this.pending) {
      if (pending.sessionId === sessionId) this.settle(corrId, null);
    }
  }

  cancelAll(): void {
    for (const corrId of this.pending.keys()) this.settle(corrId, null);
    this.subscribers.clear();
  }

  private settle(corrId: string, value: string | null): void {
    const pending = this.pending.get(corrId);
    if (!pending) return;
    this.pending.delete(corrId); // single-answer claim, before callbacks or promise continuations
    clearTimeout(pending.timer);
    this.publish(pending.sessionId, { type: 'choice_settled', corrId });
    pending.resolve(value);
  }

  private publish(sessionId: string, event: ChoiceSsePayload): void {
    for (const subscriber of this.subscribers.get(sessionId) ?? []) this.deliver(subscriber, event);
  }

  private deliver(subscriber: Subscriber, event: ChoiceSsePayload): void {
    // An individual SSE transport is not part of command execution. A failed
    // write must neither prevent peer delivery nor strand the choose promise.
    try { subscriber(event); } catch { /* transport cleanup belongs to its owner */ }
  }
}
