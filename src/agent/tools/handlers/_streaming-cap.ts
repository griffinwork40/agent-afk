/**
 * Streaming head+tail output collector for spawn-based tool handlers.
 *
 * Contract: {@link createStreamingCap} returns a collector whose `push()`
 * accepts raw stdout/stderr chunks in arrival order and retains at most
 * `maxBytes` of them — the first half from the head of the stream, the last
 * half from a sliding tail ring — while counting every byte and every newline
 * it ever observed. `render()` returns the retained text joined by a marker
 * naming exactly how many bytes were dropped and how many lines the FULL
 * stream actually contained, so a bounded view never masquerades as complete.
 *
 * Why this exists: the previous design accumulated a child's entire output
 * into one JS string and reduced it to the model budget only at close, so a
 * broad search buffered up to 8MB in order to show the model 100KB, and the
 * mid-stream SIGKILL at that ceiling returned a partial view with no way to
 * say how much was missing. Discarding the interior AS IT STREAMS bounds
 * memory at the model budget itself, which removes the memory rationale for
 * the byte-triggered kill and lets the search run on to report honest totals.
 *
 * Not a replacement for `_output-cap.ts`: that module caps a string a caller
 * already holds in full (`capForModel`, `headAndTail`). This one caps a
 * stream the caller never holds in full. `bash` keeps the former because its
 * decisive signal (exit summary, final error) lands at the true tail of a
 * bounded-volume stream; `grep` needs the latter because match output is
 * homogeneous and its volume scales with corpus size, without any ceiling.
 *
 * @module agent/tools/handlers/_streaming-cap
 */

/**
 * Reserve (bytes) withheld from the byte budget for the elision marker so the
 * rendered string still fits within `maxBytes`. The marker embeds four
 * decimal integers plus surrounding text; 200 bytes covers 10-digit values.
 */
const MARKER_RESERVE_BYTES = 200;

/**
 * Scan-volume ceiling, in bytes (256MB), for a streamed search.
 *
 * Invariant: this bounds WORK, not memory. A {@link createStreamingCap}
 * collector holds at most its budget regardless of how much the child emits,
 * so the V8 max-string-length rationale that justified the old 8MB
 * accumulator kill no longer applies. What remains worth bounding is a search
 * that never stops producing.
 *
 * Sizing is measured, not guessed: the broadest possible pattern (a single
 * letter) over this repo emits 62.8MB in 47ms — ~1.3GB/s — so a ceiling at
 * 64MB would sit at 98% of the realistic worst case and start firing
 * routinely on any larger tree, reinstating the very failure this replaced.
 * 256MB gives 4x headroom over that measurement and still bounds a true
 * runaway (a search rooted at `/`) to roughly 200ms of discarded work.
 */
export const SCAN_CAP_BYTES = 256_000_000;

/**
 * In-band sentinel appended when the scan ceiling was crossed and the child
 * was SIGKILL'd (the search did NOT finish, so its totals are lower bounds).
 * Starts with `[output truncated` so existing consumers keying on that prefix
 * — both provider loops — still match. Takes the effective cap so an injected
 * test ceiling reports itself accurately.
 */
export function scanCapKillNote(capBytes: number): string {
  return `\n[output truncated — search exceeded the ${capBytes}-byte scan ceiling and was terminated]`;
}

/** Count newline bytes in a chunk without materialising a JS string. */
function countNewlines(buf: Buffer): number {
  let count = 0;
  let idx = buf.indexOf(0x0a);
  while (idx !== -1) {
    count++;
    idx = buf.indexOf(0x0a, idx + 1);
  }
  return count;
}

/**
 * Drop leading UTF-8 continuation bytes so a tail slice taken at an arbitrary
 * byte offset begins on a code-point boundary.
 */
function trimPartialLeading(buf: Buffer): Buffer {
  let start = 0;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
  return start === 0 ? buf : buf.subarray(start);
}

/**
 * Drop an incomplete multi-byte sequence from the end of a head slice taken
 * at an arbitrary byte offset, so it ends on a code-point boundary.
 */
function trimPartialTrailing(buf: Buffer): Buffer {
  let i = buf.length - 1;
  let continuations = 0;
  while (i >= 0 && (buf[i]! & 0xc0) === 0x80) {
    continuations++;
    i--;
  }
  if (i < 0) return buf.subarray(0, 0);
  const lead = buf[i]!;
  let needed: number;
  if ((lead & 0x80) === 0) needed = 1;
  else if ((lead & 0xe0) === 0xc0) needed = 2;
  else if ((lead & 0xf0) === 0xe0) needed = 3;
  else if ((lead & 0xf8) === 0xf0) needed = 4;
  else return buf; // Invalid lead byte — leave the caller's bytes untouched.
  return continuations + 1 === needed ? buf : buf.subarray(0, i);
}

/** A bounded streaming collector. See {@link createStreamingCap}. */
export interface StreamingCap {
  /** Feed one chunk in arrival order. Safe to call after the budget fills. */
  push(chunk: Buffer): void;
  /** Total bytes observed across every chunk, including discarded interior. */
  totalBytes(): number;
  /** Total newlines observed — for grep, the true matching-line count. */
  totalLines(): number;
  /** True once any byte has been discarded from the interior. */
  truncated(): boolean;
  /** Retained head + elision marker + retained tail, as UTF-8 text. */
  render(): string;
}

/**
 * Create a collector that retains at most `maxBytes` of a stream while
 * counting all of it.
 *
 * Invariant: retained bytes never exceed `maxBytes`. The head fills first and
 * is then immutable; every later byte enters the tail ring, which evicts from
 * its front to stay within budget. Both cut points are trimmed to UTF-8
 * code-point boundaries at render time, never mid-stream, so eviction stays
 * O(1) per chunk and no partial sequence is ever re-encoded.
 */
export function createStreamingCap(maxBytes: number): StreamingCap {
  const budget = Math.max(0, maxBytes - MARKER_RESERVE_BYTES);
  const headBudget = Math.ceil(budget / 2);
  const tailBudget = budget - headBudget;

  const head: Buffer[] = [];
  let headBytes = 0;
  const tail: Buffer[] = [];
  let tailBytes = 0;
  let totalBytes = 0;
  let totalLines = 0;

  function push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    totalBytes += chunk.length;
    totalLines += countNewlines(chunk);

    let rest = chunk;
    if (headBytes < headBudget) {
      const take = Math.min(headBudget - headBytes, rest.length);
      head.push(rest.subarray(0, take));
      headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;

    tail.push(rest);
    tailBytes += rest.length;
    // Evict whole chunks from the front, then partially slice the new front,
    // until the ring is back within budget. Bounded work per push.
    while (tailBytes > tailBudget && tail.length > 0) {
      const front = tail[0]!;
      const excess = tailBytes - tailBudget;
      if (front.length <= excess) {
        tail.shift();
        tailBytes -= front.length;
      } else {
        tail[0] = front.subarray(excess);
        tailBytes -= excess;
      }
    }
  }

  function render(): string {
    const headBuf = Buffer.concat(head);
    const tailBuf = Buffer.concat(tail);
    const retained = headBuf.length + tailBuf.length;
    if (retained >= totalBytes) {
      // Nothing was discarded — emit the stream verbatim.
      return Buffer.concat([headBuf, tailBuf]).toString('utf8');
    }
    const safeHead = trimPartialTrailing(headBuf);
    const safeTail = trimPartialLeading(tailBuf);
    const omitted = totalBytes - safeHead.length - safeTail.length;
    const marker =
      `\n\n… [${omitted} bytes truncated: showing first ${safeHead.length} + last ` +
      `${safeTail.length} of ${totalBytes}; ${totalLines} matching lines total] …\n\n`;
    return safeHead.toString('utf8') + marker + safeTail.toString('utf8');
  }

  return {
    push,
    totalBytes: () => totalBytes,
    totalLines: () => totalLines,
    truncated: () => headBytes + tailBytes < totalBytes,
    render,
  };
}
