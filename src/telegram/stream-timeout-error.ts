/**
 * StreamTimeoutError — thrown by the Telegram streaming inactivity watchdog
 * when no event arrives within the timeout window.
 *
 * Invariant: this lives in its OWN module (not `streaming.ts`) so that the
 * message handler can `import { StreamTimeoutError }` and use `instanceof`
 * WITHOUT being affected by the many tests that `vi.mock('./streaming.js')`.
 * Those mocks replace streaming.ts's exports with stubs, which would make a
 * `StreamTimeoutError` imported from there resolve to `undefined` — turning
 * `error instanceof StreamTimeoutError` into a TypeError at runtime. Keeping the
 * class here keeps the class identity stable across the mock boundary.
 *
 * @module telegram/stream-timeout-error
 */

/**
 * Distinct error type for an inactivity timeout, so the Telegram message
 * handler can surface an honest "timed out" message instead of misclassifying
 * it as a network or (Claude) rate-limit error.
 */
export class StreamTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamTimeoutError';
  }
}
