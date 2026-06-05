/**
 * Replay-fixture slicer.
 *
 * Given an absolute path to a witness `trace.jsonl` and the highest `seq`
 * value an eval-case wants to retain, returns a byte-identical slice of the
 * source trace from line 1 through the line whose event carries that `seq`,
 * along with line count and SHA-256.
 *
 * ## Contract
 *
 * The output bytes are **literally a prefix of the source bytes** — no
 * re-encoding, no normalisation. Every byte (including any trailing
 * newline on the chosen end-line) is copied verbatim. This is the
 * load-bearing property: the fixture file the writer commits is what the
 * future eval-runner replays, and it must equal `source[0..endByteOffset]`
 * to the bit.
 *
 * ## Why scan by JSON, not regex
 *
 * Each event line's `seq` lives at the top level of its JSON object. A
 * naive `/"seq":(\d+)/` regex could match a nested `seq` inside a
 * payload. We `JSON.parse` each candidate line and read `parsed.seq`
 * directly. Lines that fail to parse are counted (so byte offsets stay
 * correct) but never match — this mirrors `improve/scan/reader.ts`'s
 * defensive parse.
 *
 * ## Sprint 3 scope
 *
 * Only prefix slices (`startLine: 1`) are emitted. The schema reserves a
 * windowed mode for a later sprint; passing `startLine !== 1` here is a
 * runtime error so the seam is explicit rather than silent.
 *
 * @module improve/eval-gen/replay-fixture
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';

/** Error kinds the slicer can throw. Stable for CLI error handling. */
export type EvalGenErrorCode =
  | 'source-not-found'
  | 'source-empty'
  | 'seq-not-found'
  | 'unsupported-window'
  | 'fixture-mismatch'
  | 'card-not-found'
  | 'card-pattern-unknown'
  | 'evidence-row-out-of-range'
  | 'proposal-not-found';

export class EvalGenError extends Error {
  public readonly code: EvalGenErrorCode;
  constructor(message: string, code: EvalGenErrorCode) {
    super(message);
    this.name = 'EvalGenError';
    this.code = code;
  }
}

export interface SliceTraceOptions {
  /** Inclusive `seq` value the slice runs through. Required. */
  endSeq: number;
  /**
   * 1-based source-line where the slice begins. Defaults to 1.
   *
   * Sprint 3 only supports `startLine === 1` (prefix slices). Other values
   * throw — the field exists so a future windowed mode can be added
   * additively without renaming.
   */
  startLine?: number;
}

export interface SliceTraceResult {
  /** A detached copy of the source bytes for the chosen range. */
  bytes: Buffer;
  /** 1-based, inclusive — always 1 in Sprint 3. */
  startLine: number;
  /** 1-based, inclusive — the line carrying `endSeq`. */
  endLine: number;
  /** `endLine - startLine + 1`. */
  sliceLineCount: number;
  /** SHA-256 of `bytes`, lowercase hex. */
  sliceSha256: string;
  /** Number of lines in the source file (informational; not used by writer). */
  sourceLineCount: number;
}

/**
 * Slice a witness trace prefix that ends at the line carrying `endSeq`.
 *
 * Pure (modulo the disk read). No knowledge of `$AFK_HOME` or schemas —
 * callers pass an absolute path and a target `seq`.
 *
 * @throws EvalGenError {'source-not-found'}     source path does not exist
 * @throws EvalGenError {'source-empty'}         source file has zero bytes
 * @throws EvalGenError {'seq-not-found'}        no parseable line carries seq=endSeq
 * @throws EvalGenError {'unsupported-window'}   startLine !== 1 in Sprint 3
 */
export function sliceTracePrefix(
  sourceAbsPath: string,
  options: SliceTraceOptions,
): SliceTraceResult {
  if (!existsSync(sourceAbsPath)) {
    throw new EvalGenError(
      `replay-fixture: source trace not found: ${sourceAbsPath}`,
      'source-not-found',
    );
  }

  const startLine = options.startLine ?? 1;
  if (startLine !== 1) {
    throw new EvalGenError(
      `replay-fixture: only startLine=1 (prefix slice) is supported in Sprint 3 (got ${startLine})`,
      'unsupported-window',
    );
  }

  const bytes = readFileSync(sourceAbsPath);
  if (bytes.length === 0) {
    throw new EvalGenError(
      `replay-fixture: source trace is empty: ${sourceAbsPath}`,
      'source-empty',
    );
  }

  // Walk byte offsets to map each line → its source byte range.
  // Indices are byte positions inside `bytes`; line numbers are 1-based.
  const lineRanges = computeLineByteRanges(bytes);
  const sourceLineCount = lineRanges.length;

  // Find the 1-based line index whose parsed JSON has top-level seq === endSeq.
  // Defensive parse: lines that fail JSON.parse are skipped (matches
  // improve/scan/reader.ts behavior) but still counted toward line numbers.
  let endLine = -1;
  for (let i = 0; i < lineRanges.length; i++) {
    const range = lineRanges[i]!;
    if (range.contentEnd === range.start) continue; // empty line
    const lineStr = bytes.subarray(range.start, range.contentEnd).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(lineStr);
    } catch {
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'seq' in parsed &&
      typeof (parsed as { seq: unknown }).seq === 'number' &&
      (parsed as { seq: number }).seq === options.endSeq
    ) {
      endLine = i + 1;
      break;
    }
  }

  if (endLine === -1) {
    throw new EvalGenError(
      `replay-fixture: seq ${options.endSeq} not found in ${sourceAbsPath} (scanned ${sourceLineCount} lines)`,
      'seq-not-found',
    );
  }

  // Byte boundary for the slice: include the trailing newline of the chosen
  // line if the source has one, so the slice ends on a record boundary.
  const lastRange = lineRanges[endLine - 1]!;
  const endByteOffset = lastRange.byteEnd;

  // Detached copy — callers may write the buffer to disk or hold references.
  const sliceBytes = Buffer.from(bytes.subarray(0, endByteOffset));
  const sliceSha256 = createHash('sha256').update(sliceBytes).digest('hex');

  return {
    bytes: sliceBytes,
    startLine: 1,
    endLine,
    sliceLineCount: endLine,
    sliceSha256,
    sourceLineCount,
  };
}

/**
 * Compute SHA-256 of a buffer. Exposed so the writer can re-verify the
 * fixture file after it has been written to disk.
 */
export function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface LineByteRange {
  /** Byte offset of the first character of the line content. */
  start: number;
  /** Byte offset one past the last content byte (excludes a trailing \n). */
  contentEnd: number;
  /**
   * Byte offset one past the line's record terminator. Equals `contentEnd`
   * when the line has no trailing newline (only possible on the very last
   * line of a file without a final newline). Equals `contentEnd + 1`
   * otherwise. This is the right value to use as the slice's `endByteOffset`
   * because including the trailing newline keeps the fixture on a record
   * boundary.
   */
  byteEnd: number;
}

/**
 * Walk the buffer, returning one descriptor per source line. Pure;
 * preserves byte counts exactly so the slice can be byte-faithful.
 *
 * Trailing newline handling: a file ending in `\n` produces N ranges where
 * each `byteEnd` includes its newline. A file ending without `\n` produces
 * a final range whose `byteEnd === contentEnd === bytes.length`.
 */
function computeLineByteRanges(bytes: Buffer): LineByteRange[] {
  const ranges: LineByteRange[] = [];
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i++) {
    // 0x0a is LF. We assume the trace writer uses LF (Node's default for
    // writeFileSync). If a CRLF source ever lands here, the \r stays at the
    // tail of the line content and the fixture preserves it byte-for-byte.
    if (bytes[i] === 0x0a) {
      ranges.push({ start: lineStart, contentEnd: i, byteEnd: i + 1 });
      lineStart = i + 1;
    }
  }
  if (lineStart < bytes.length) {
    // Trailing line without a final newline.
    ranges.push({
      start: lineStart,
      contentEnd: bytes.length,
      byteEnd: bytes.length,
    });
  }
  return ranges;
}
