/**
 * Shared output-capping primitives for the shell-facing tool handlers
 * (`bash`, `grep`).
 *
 * Two independent thresholds — deliberately decoupled, because the single
 * 100KB cap they replace conflated two unrelated concerns and resolved both
 * by SIGKILLing the child process the instant output crossed 100KB:
 *
 *   1. {@link HARD_CAP_BYTES} — the accumulator + mid-stream-kill threshold.
 *      Its ONLY job is to bound the in-memory JS string so a genuine runaway
 *      producer (`yes`, an accidental `cat` of a huge binary) cannot grow a
 *      single string past V8's ~512MB max-string-length limit and crash the
 *      host with `RangeError: Invalid string length`. Set far above any
 *      legitimate command's output so the mid-stream kill is a true
 *      runaway circuit-breaker, not a routine event. 8MB leaves ~64x
 *      headroom under the V8 ceiling even with a combined stdout+stderr
 *      counter and several tool calls running concurrently.
 *
 *   2. {@link MODEL_CAP_BYTES} — the budget of output actually fed back to
 *      the model. A soft context-cost limit, unchanged from the prior 100KB.
 *
 * Why this matters: the prior design killed the child at 100KB, so a verbose
 * but legitimate command (a full `pnpm test` run, a large `git diff`, a broad
 * grep) was terminated mid-flight — the agent never saw the real exit code
 * and lost the *tail* of the output (head-only truncation keeps the least
 * useful 100KB, while test/build summaries and final errors live at the END).
 * Raising the kill threshold lets such commands run to completion; capping the
 * model-facing view with {@link headAndTail} keeps the decisive start AND end.
 *
 * @module agent/tools/handlers/_output-cap
 */

/**
 * Accumulator + mid-stream SIGKILL threshold, in bytes (8MB).
 *
 * The child is killed only when combined stdout+stderr crosses this — a
 * genuine runaway. Legitimate verbose output (well under 8MB) runs to
 * completion so the real exit code and tail survive.
 */
export const HARD_CAP_BYTES = 8_000_000;

/**
 * Model-facing output budget, in bytes (100KB). Output larger than this is
 * reduced to head+tail via {@link headAndTail}; the underlying command is
 * NOT affected. Matches the prior model-context cost.
 */
export const MODEL_CAP_BYTES = 100_000;

/**
 * Truncate a UTF-8 Buffer to at most `maxBytes` from the FRONT without
 * splitting a multi-byte code point. Walks back off any trailing
 * continuation byte (0x80–0xBF). Returns a zero-copy subarray view.
 */
function utf8SafeHead(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/**
 * Keep at most `maxBytes` from the END of a UTF-8 Buffer without splitting a
 * multi-byte code point. Advances the start offset forward off any leading
 * continuation byte so the retained tail begins on a code-point boundary.
 */
function utf8SafeTail(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) return buf;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return buf.subarray(start);
}

/**
 * Reserve (bytes) held back from the byte budget for the elision marker, so
 * the returned string still fits within `maxBytes`. The marker embeds three
 * decimal integers (elided count + head/tail lengths); 160 bytes covers even
 * 10-digit values plus the surrounding text.
 */
const MARKER_RESERVE_BYTES = 160;

/**
 * Reduce `text` to at most ~`maxBytes` UTF-8 bytes while preserving BOTH
 * ends, joined by a one-line marker naming how many bytes were elided from
 * the middle. Returns `text` unchanged when it already fits.
 *
 * The dominant large-output producers (test runners, builds, `git diff`) put
 * the decisive signal — pass/fail counts, the final error — at the END, so
 * head-only truncation discards exactly what the agent needs. Keeping head +
 * tail rescues it. UTF-8 safe at both cut points.
 */
export function headAndTail(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;

  const budget = Math.max(0, maxBytes - MARKER_RESERVE_BYTES);
  const headBudget = Math.ceil(budget / 2);
  const tailBudget = budget - headBudget;

  const head = utf8SafeHead(buf, headBudget);
  const tail = utf8SafeTail(buf, tailBudget);
  const elided = buf.length - head.length - tail.length;

  const marker = `\n\n… [${elided} bytes truncated: showing first ${head.length} + last ${tail.length} of ${buf.length}] …\n\n`;
  return head.toString('utf8') + marker + tail.toString('utf8');
}

/**
 * Cap arbitrary tool output for model consumption. Returns the capped
 * `content` (head+tail when over budget) and a `truncated` flag callers plumb
 * into `ToolResult.truncated` — the structured signal non-model consumers
 * (subagent traces, hooks) read instead of substring-scanning `content`.
 */
export function capForModel(text: string): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MODEL_CAP_BYTES) {
    return { content: text, truncated: false };
  }
  return { content: headAndTail(text, MODEL_CAP_BYTES), truncated: true };
}

/**
 * The in-band sentinel appended to model-facing content when the mid-stream
 * hard cap fired and the child was SIGKILL'd (i.e. the command did NOT finish
 * — its exit code is unavailable and its true tail was never produced).
 * Starts with `[output truncated` so existing consumers keying on that prefix
 * still match.
 */
export const HARD_CAP_KILL_NOTE = `\n[output truncated — command exceeded the ${HARD_CAP_BYTES}-byte output cap and was terminated]`;
