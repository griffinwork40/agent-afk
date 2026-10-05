/**
 * Mid-stream transport termination classifier — shared across providers (#2780).
 *
 * Contract: returns true when `err` is the shape undici's fetch throws when the
 * response BODY socket closes after headers arrived (connection reset, peer
 * close) while the SSE stream is being read:
 *
 *   - a `TypeError` whose message is exactly `'terminated'` (undici wraps the
 *     socket failure as `new TypeError('terminated', { cause })`), OR
 *   - any error whose own `code`, or a `code` somewhere on its bounded `cause`
 *     chain, is one of {@link TERMINATION_CODES}.
 *
 * Deliberately NARROW. The loose message-substring `isNetworkError`
 * (src/utils/error-classifiers.ts) matches 'connect' / 'timeout' / 'network'
 * and would turn unrelated failures into re-drives, each of which burns a
 * partial generation. Callers are expected to evaluate this AFTER the TTFB,
 * stall, and user-abort branches (see stream-consumer.ts), so a termination
 * that is really the watchdog or the user tearing the socket down never
 * reaches it.
 *
 * Originally in anthropic-direct/loop/network-termination.ts (#2776); moved
 * here so the openai-compatible provider can import it without a cross-provider
 * dependency (#2780).
 *
 * Pure: no SDK import, no I/O.
 */

/** undici / node socket codes that mean "the transport dropped mid-read". */
const TERMINATION_CODES: ReadonlySet<string> = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'ECONNRESET',
]);

/** Cause-chain walk bound; also guards against a self-referential `cause`. */
const MAX_CAUSE_DEPTH = 5;

export function isMidStreamNetworkTermination(err: unknown): boolean {
  if (err instanceof TypeError && err.message === 'terminated') return true;
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (cur === null || typeof cur !== 'object') return false;
    const { code, cause } = cur as { code?: unknown; cause?: unknown };
    if (typeof code === 'string' && TERMINATION_CODES.has(code)) return true;
    if (cause === cur) return false;
    cur = cause;
  }
  return false;
}
