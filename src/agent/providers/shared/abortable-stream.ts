/**
 * Contract: wraps a source async-iterable so consumption stops PROMPTLY when
 * `signal` fires — within the current event-loop turn — instead of waiting for
 * the source's in-flight `next()` (e.g. a parked SSE read) to settle. Each pull
 * is raced against the abort; when the abort wins, the wrapper throws an
 * AbortError and abandons the in-flight read. The abandoned read's eventual
 * rejection is swallowed so it can never surface as an `unhandledRejection`
 * (the underlying transport is already being cancelled via the SAME `signal`,
 * which the caller also handed to `messages.create`). On any exit the wrapper
 * closes the source iterator via `return()` so the HTTP stream is released.
 *
 * Non-abort behaviour is transparent: values pass through unchanged, `done`
 * ends the generator, and a source rejection propagates unchanged (only an
 * abort-won race swallows the trailing read — real errors are never masked).
 *
 * Why this exists: a provider streaming loop passes the turn signal to its
 * SDK's stream call, so an abort DOES cancel the fetch — but the SDK's SSE
 * async-iterator surfaces that abort only once its pending read settles, which
 * for a mid-stream extended-thinking (Opus) response can lag seconds behind the
 * ESC keypress (there is no per-delta abort check in the translate loop).
 * Racing each pull against the signal makes the halt deterministic regardless
 * of the transport's read cadence.
 *
 * History: extracted from `anthropic-direct/abortable-stream.ts` to this
 * provider-neutral `shared/` home so the `openai-compatible` provider can reuse
 * the exact same racing wrapper (its SDK — openai@6 — actually SWALLOWS a
 * mid-stream abort and ends its iterator cleanly rather than rejecting the
 * parked read, so without this wrapper an interrupt both lags AND slips past the
 * stream-incomplete guard as a spurious `error` event). Both providers now wrap
 * their SDK stream with this helper. See the interrupt-halt regression tests
 * alongside this module and in each provider.
 */
export async function* abortableStream<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  // Already aborted before the first pull — never touch the source.
  if (signal.aborted) throw abortErrorFrom(signal);

  const iterator = source[Symbol.asyncIterator]();

  // Single long-lived abort listener for the whole stream (not per-event: a
  // high-frequency thinking-delta stream would otherwise add/remove a listener
  // per token). `aborted` resolves at most once, with the ABORTED sentinel, and
  // is re-raced against a fresh `next()` promise on every iteration.
  const ABORTED = Symbol('aborted');
  let onAbort!: () => void;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    while (true) {
      const nextP = iterator.next();
      const result = await Promise.race([nextP, aborted]);
      if (result === ABORTED) {
        // Abandon the in-flight read; the transport is already aborting via the
        // same `signal`. Attach a no-op catch so the abandoned read's eventual
        // rejection cannot crash the process as an unhandledRejection.
        void Promise.resolve(nextP).catch(() => { /* transport aborting */ });
        throw abortErrorFrom(signal);
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Best-effort: signal the source we are done so the SDK closes the HTTP
    // stream instead of leaking a dangling connection. `return()` is optional
    // on the async-iterator protocol; swallow if absent or if it rejects.
    await Promise.resolve(iterator.return?.()).catch(() => { /* best-effort */ });
  }
}

/**
 * Contract: derive a throwable Error from an aborted signal's reason. Reuses the
 * reason when it is already an Error (preserving the original stack/identity);
 * otherwise synthesizes an `AbortError` whose message is the string reason (e.g.
 * `'interrupted'` from the ESC soft-stop) or a generic fallback. The provider's
 * loop distinguishes an interrupt from a real error via `signal.aborted`, not
 * the error identity, so the exact shape here is for logs/debuggability.
 */
function abortErrorFrom(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(
    typeof reason === 'string' && reason.length > 0 ? reason : 'The operation was aborted',
  );
  err.name = 'AbortError';
  return err;
}
