/**
 * Lightweight output-event broadcast for AgentSession.
 *
 * Provides a push/subscribe channel so external observers (the mid-turn
 * task view, `/tasks:view`) can tail a running session's output events
 * without calling `sendMessageStream` (which would start a new turn).
 *
 * The channel is push-based: `sendMessageStreamInternal` calls `push()`
 * on each yielded event. Subscribers receive events via an async iterable.
 * Multiple concurrent subscribers are supported (each gets its own buffer).
 *
 * @module agent/session/output-broadcast
 */

import type { OutputEvent } from '../types/session-types.js';

/** A single subscriber's buffered queue with async-pull resolution. */
interface Subscriber {
  buffer: OutputEvent[];
  resolve: ((value: IteratorResult<OutputEvent>) => void) | null;
}

/**
 * Broadcast channel for output events. Subscribers receive a live
 * `AsyncIterable<OutputEvent>` that yields events as they are pushed.
 */
export class OutputBroadcast {
  private readonly subscribers = new Set<Subscriber>();
  private closed = false;

  /** Push an event to all active subscribers. */
  push(event: OutputEvent): void {
    for (const sub of this.subscribers) {
      if (sub.resolve) {
        // Subscriber is awaiting — resolve immediately.
        const r = sub.resolve;
        sub.resolve = null;
        r({ value: event, done: false });
      } else {
        // Subscriber has not pulled yet — buffer.
        sub.buffer.push(event);
      }
    }
  }

  /** Signal that no more events will arrive. */
  close(): void {
    this.closed = true;
    for (const sub of this.subscribers) {
      if (sub.resolve) {
        const r = sub.resolve;
        sub.resolve = null;
        r({ value: undefined as unknown as OutputEvent, done: true });
      }
    }
  }

  /** Create a new subscriber. Each subscriber gets its own buffered stream. */
  subscribe(): AsyncIterable<OutputEvent> {
    const sub: Subscriber = { buffer: [], resolve: null };
    this.subscribers.add(sub);

    const self = this;
    const iterator: AsyncIterator<OutputEvent> = {
      next(): Promise<IteratorResult<OutputEvent>> {
        // Drain buffered events first.
        if (sub.buffer.length > 0) {
          return Promise.resolve({ value: sub.buffer.shift()!, done: false });
        }
        // If closed and buffer empty, signal done.
        if (self.closed) {
          self.subscribers.delete(sub);
          return Promise.resolve({ value: undefined as unknown as OutputEvent, done: true });
        }
        // Park until next push.
        return new Promise((resolve) => { sub.resolve = resolve; });
      },
      return(): Promise<IteratorResult<OutputEvent>> {
        // FIX-5: Resolve any pending next() before removing the subscriber,
        // otherwise a caller awaiting next() will hang indefinitely.
        if (sub.resolve) {
          const r = sub.resolve;
          sub.resolve = null;
          r({ value: undefined as unknown as OutputEvent, done: true });
        }
        self.subscribers.delete(sub);
        return Promise.resolve({ value: undefined as unknown as OutputEvent, done: true });
      },
    };

    return { [Symbol.asyncIterator]: () => iterator };
  }
}
