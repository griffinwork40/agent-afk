/**
 * Bounded wait on in-flight child terminal writes before a trace seal (#3714).
 *
 * @module agent/trace/pending-writes
 */

/**
 * Upper bound `TraceWriter.seal()` waits for pending child terminal writes.
 *
 * Mirrors `SUBAGENT_DRAIN_TIMEOUT_MS` (subagent/constants.ts; equality is
 * pinned by writer-seal-pending.test.ts). Kept local so the trace layer does
 * not import the subagent layer. The bound is mandatory: the promises handed
 * to `seal()` are exactly the ones the subagent drain gave up on, so an
 * unbounded wait here would turn a wedged child trace sink into a hung
 * shutdown and a process that never exits.
 */
export const SEAL_PENDING_WRITES_TIMEOUT_MS = 5000;

/**
 * Wait (all-settled) for `pending`, but never longer than `timeoutMs`.
 * Never rejects. On timeout, warns on stderr naming how many writes were
 * abandoned; the caller seals anyway. The timer is unref'd and cleared so a
 * fast settle leaves nothing behind keeping the event loop alive.
 */
export async function awaitPendingWritesBounded(
  pending: readonly Promise<void>[],
  timeoutMs: number,
  label: string,
): Promise<void> {
  let unsettled = pending.length;
  const tracked = pending.map((p) =>
    p.then(
      () => { unsettled--; },
      () => { unsettled--; },
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  const outcome = await Promise.race([Promise.all(tracked), bound]);
  clearTimeout(timer);
  if (outcome === 'timeout' && unsettled > 0) {
    console.warn(
      `[${label}] seal: abandoned ${unsettled} of ${pending.length} pending child ` +
        `terminal write(s) after ${timeoutMs}ms — sealing anyway; their rows may be missing`,
    );
  }
}
