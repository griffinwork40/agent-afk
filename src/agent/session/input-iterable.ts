/**
 * Async input stream feeding a provider for multi-turn sessions.
 *
 * The stream is provider-neutral: each yielded value is a `ProviderUserTurn`
 * consisting of the raw user text and the current harness session id (which
 * may be unset for the very first turn). Provider adapters (Anthropic, Codex)
 * translate these into their native input shapes.
 *
 * @module agent/session/input-iterable
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { ProviderUserTurn } from '../provider.js';

export class QueryInputStream {
  private pendingResolve: ((value: ProviderUserTurn) => void) | null = null;
  private bufferedMessages: Array<string | ContentBlockParam[]> = [];
  private getSessionId: () => string | undefined;

  constructor(getSessionId: () => string | undefined) {
    this.getSessionId = getSessionId;
  }

  pushUserMessage(content: string | ContentBlockParam[]): void {
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      const sessionId = this.getSessionId();
      resolve({
        content,
        ...(sessionId !== undefined ? { sessionId } : {}),
      });
      return;
    }
    this.bufferedMessages.push(content);
  }

  createIterable(): AsyncIterable<ProviderUserTurn> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ProviderUserTurn>> {
            if (self.bufferedMessages.length > 0) {
              const content = self.bufferedMessages.shift()!;
              const sessionId = self.getSessionId();
              return Promise.resolve({
                value: {
                  content,
                  ...(sessionId !== undefined ? { sessionId } : {}),
                },
                done: false,
              });
            }
            return new Promise((resolve) => {
              self.pendingResolve = (msg) => resolve({ value: msg, done: false });
            });
          },
          return(): Promise<IteratorResult<ProviderUserTurn>> {
            return Promise.resolve({ value: undefined as unknown as ProviderUserTurn, done: true });
          },
        };
      },
    };
  }
}
