/**
 * Fallback-notice helpers for `afk chat` (non-streaming paths).
 *
 * When the primary model hits a usage limit or is rejected, the runtime emits
 * a `{ type: 'notice', kind: 'model-fallback', fallback: { from, to, reason } }`
 * OutputEvent on the session's output broadcast DURING the `sendMessage` call.
 * Because `sendMessage` only surfaces `chunk`/`message`/`error`/`done`, the
 * notice is otherwise invisible in the text and JSON one-shot paths.
 *
 * Strategy: subscribe to `session.getOutputStream()` concurrently with the
 * `sendMessage` call, collect any `model-fallback` notices, and return them to
 * the caller after the message resolves. No files outside cli/commands/chat*
 * need to change — `getOutputStream()` is already on the public `IAgentSession`
 * interface (src/agent/types/session-types.ts line 441).
 *
 * @module cli/commands/chat.fallback-notice
 */

import type { OutputEvent } from '../../agent/types/session-types.js';

/** Subset of IAgentSession used by this module. */
export interface SessionWithOutputStream {
  getOutputStream?(): AsyncIterable<OutputEvent>;
}

/** A captured model-fallback notice. */
export interface FallbackNotice {
  /** Ready-to-display sentence produced by the runtime. */
  text: string;
  fallback: { from: string; to: string; reason: string };
}

/**
 * Subscribe to `session.getOutputStream()` and collect every
 * `notice`/`model-fallback` event emitted while `work` runs.
 *
 * Returns the first fallback notice captured (there is at most one per turn),
 * or `undefined` when no fallback occurred.
 *
 * The collector is a fire-and-forget async loop that races the work promise;
 * once `work` settles the loop is left to drain naturally — it will exit on the
 * next `done` event (emitted by every turn). No resources leak.
 */
export async function collectFallbackNotice(
  session: SessionWithOutputStream,
  work: Promise<unknown>,
): Promise<FallbackNotice | undefined> {
  let captured: FallbackNotice | undefined;

  // `getOutputStream` is on IAgentSession but test mocks may omit it.
  // When absent, skip collection — no fallback can be detected.
  if (typeof session.getOutputStream !== 'function') {
    await work;
    return undefined;
  }

  // Start consuming the output stream concurrently with `work`. We do NOT
  // await this loop directly; instead we race it against `work` via Promise.all
  // so the caller is never blocked by the stream iteration.
  const collect = (async () => {
    for await (const event of session.getOutputStream!()) {
      if (
        event.type === 'notice' &&
        event.kind === 'model-fallback' &&
        event.fallback !== undefined &&
        captured === undefined
      ) {
        captured = {
          text: event.text,
          fallback: {
            from: event.fallback.from,
            to: event.fallback.to,
            reason: String(event.fallback.reason),
          },
        };
      }
      // `done` signals the end of this turn's events; stop iterating.
      if (event.type === 'done') break;
      // `error` also ends the turn.
      if (event.type === 'error') break;
    }
  })();

  // Await both: `work` for the actual result, `collect` to ensure we've seen
  // any notice emitted before the `done` event.
  await Promise.all([work, collect]);

  return captured;
}
