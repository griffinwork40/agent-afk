import { env } from '../../../config/env.js';
import type { DiffPayload, DiffLine } from '../../../utils/diff.js';
import { palette } from '../../palette.js';
import { stripAnsi } from '../../display.js';

/**
 * Maximum number of diff body lines to render in the live overlay before
 * eliding with a `… +N more` footer. The overlay is bounded tightly so a
 * 200-line edit doesn't fill the screen while live.
 */
export const MAX_OVERLAY_DIFF_LINES = 8;

/**
 * Default maximum number of diff body lines to render in scrollback (flush
 * mode) before eliding with a footer naming the hidden-line count.
 *
 * 30 is the empirically-chosen threshold where a diff stops being
 * "scannable while reading the model's reply" and starts being "the thing
 * on the screen." Small edits (one function, ≤3 hunks) typically fit
 * without truncation; large refactors get truncated with a clear escape
 * hatch (`AFK_DIFF_LINES=0`) named in the footer.
 *
 * Overridable per-call via `AFK_DIFF_LINES` env var. `0` means uncapped
 * (the pre-change behavior — useful when a power user wants full
 * accountability during a large refactor).
 */
export const FLUSH_DIFF_LINES_DEFAULT = 30;

/**
 * Resolve the flush-mode body-line cap from the environment.
 *
 * Reads `AFK_DIFF_LINES` at call time so tests and one-off invocations
 * can override without a config reload. Invalid values (non-numeric,
 * negative, decimal, trailing garbage) fail open to {@link
 * FLUSH_DIFF_LINES_DEFAULT}.
 *
 * Returns `0` only when the user explicitly set `AFK_DIFF_LINES=0`,
 * which the caller interprets as "no cap."
 *
 * The regex (`/^\d+$/`) is intentionally stricter than `parseInt`:
 * `parseInt('1.5xyz', 10)` silently returns `1`, which would let a typo
 * collapse the diff to a single line without warning. Whole non-negative
 * integers only — anything else is rejected.
 */
function diffFlushMaxLines(): number {
  const raw = env.AFK_DIFF_LINES;
  if (raw === undefined) return FLUSH_DIFF_LINES_DEFAULT;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return FLUSH_DIFF_LINES_DEFAULT;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return FLUSH_DIFF_LINES_DEFAULT;
  return n;
}

/**
 * Opt-out switch for the inline diff render. Reads `AFK_SHOW_DIFFS` at
 * call time so tests and one-off invocations can override without a
 * config reload. Recognized falsy values: `"0"`, `"false"`, `"no"`, `"off"`
 * (case-insensitive). Anything else (including unset) → diffs render.
 *
 * Default: ON. The diff payload is still produced by the handler regardless
 * — this only suppresses the render. That keeps the JSON-output / Telegram
 * surfaces unaffected if they choose to surface diffs independently.
 */
function diffsDisabled(): boolean {
  const raw = env.AFK_SHOW_DIFFS;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

/**
 * Format the one-line stat header that prefixes every rendered diff:
 *
 *     `+12 -5 across 3 hunks`
 *
 * The `+12` and `-5` use the same green/red palette as the body so the
 * header is glanceable, the hunk-count suffix is dim. When the body is
 * truncated by the flush cap, this header survives — the user always
 * knows the scale of the edit even if they don't expand the body.
 */
function formatStatHeader(diff: DiffPayload): string {
  const adds = palette.diffAdd(`+${diff.addedLines}`);
  const dels = palette.diffRemove(`-${diff.removedLines}`);
  const hunkCount = diff.hunks.length;
  const hunkSuffix = palette.dim(`across ${hunkCount} hunk${hunkCount === 1 ? '' : 's'}`);
  return `${adds} ${dels} ${hunkSuffix}`;
}

/**
 * Color a single diff line. Returns the line including a leading single
 * character (`+`/`-`/` `) and the original text. No trailing newline.
 *
 * Non-TTY surfaces: chalk auto-disables itself via {@link palette} when
 * stdout isn't a TTY, so the returned strings degrade to plain text
 * without changes here.
 */
// Intent: diff-body variant. Preserves TAB (0x09) for code indentation and
// LF (0x0A) for paragraph breaks; strips every other C0 (0x00–0x1F) plus
// DEL (0x7F) and the C1 control range (0x7F–0x9F). stripAnsi handles
// ESC-prefixed sequences (CSI/OSC/DCS); this regex catches bare control
// bytes that would still hit the terminal otherwise — most notably BEL
// (0x07) which rings the terminal, and lone CR (0x0D) which repositions
// the cursor. Newlines cannot appear in a single DiffLine.text because the
// diff engine splits on them upstream, so we preserve them defensively
// (multi-line DiffLine.text would be a bug, but stripping LF here would
// silently merge lines if it happened — better to let the renderer surface
// it). C1 controls (U+0080–U+009F) are stripped because their UTF-8 wire
// bytes can be interpreted as CSI introducers by some 8-bit-mode terminals.
//
// USE FOR: diff-line content (preserves visual structure).
// DON'T USE FOR: label / paragraph contexts (LF passes through).
const CONTROL_CHAR_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

function colorDiffLine(line: DiffLine): string {
  // Strip any ANSI escape sequences already present in the file content
  // before applying diff coloring. Without stripping, a file that contains
  // ANSI codes (e.g. a generated log file or test fixture) would inject
  // raw escape sequences into the terminal output, potentially corrupting
  // the display or introducing unintended color spans. Bare C0 controls
  // (BEL, CR, etc.) are also scrubbed so adversarial file content cannot
  // ring the terminal bell or reposition the cursor via the diff render path.
  const safeText = stripAnsi(line.text).replace(CONTROL_CHAR_RE, '');
  if (line.kind === '+') return palette.diffAdd('+ ' + safeText);
  if (line.kind === '-') return palette.diffRemove('- ' + safeText);
  return palette.dim('  ' + safeText);
}

/**
 * Two-level memoization cache for {@link formatDiffBlock}.
 *
 * Outer key: `DiffPayload` reference (WeakMap — payload is GC-eligible once
 * the tool lane drops its reference, so the cache never retains payloads
 * past their natural lifetime).
 * Inner key: `mode + '|' + indent` string (the two parameters that vary the
 * rendered output for the same payload).
 * Value: the `string[]` returned by the last call with those exact arguments.
 *
 * We return the SAME array reference on a cache hit so callers can use
 * reference equality to detect unchanged output (useful for overlay
 * reconciliation). We deliberately do NOT cache when `diffsDisabled()` is
 * true — the empty-array fast-path is trivial and caching it could mask
 * later re-enables of the feature flag.
 */
const _diffBlockCache = new WeakMap<DiffPayload, Map<string, string[]>>();

/**
 * Format a {@link DiffPayload} as a list of rendered lines.
 *
 * Indent is applied to every emitted line so the block sits visually
 * under its owning tool entry's `⎿` connector.
 *
 * Every diff is prefixed with a one-line stat header (`+N -M across K
 * hunks`) — see {@link formatStatHeader}. This header survives even when
 * the body is truncated, giving the user a glance-grade scale signal.
 *
 * - `overlay` mode caps body lines at {@link MAX_OVERLAY_DIFF_LINES}
 *   and appends a `… +N more` footer when truncated.
 * - `flush` mode caps body lines at the value of `AFK_DIFF_LINES` (default
 *   {@link FLUSH_DIFF_LINES_DEFAULT}). When truncated, the footer names
 *   the env var to set to expand the diff — discoverability without docs.
 *   Set `AFK_DIFF_LINES=0` to disable the flush cap entirely.
 *
 * Hunk headers (`@@ -X,Y +A,B @@`) do NOT count against either cap —
 * they're structural markers, and counting them would let a diff with
 * many small hunks swallow its own body lines.
 *
 * Results are memoized per `(payload, mode, indent, cap)` using a
 * module-private `WeakMap` so re-renders on every overlay tick are O(1)
 * cache lookups after the first call. The cache is bypassed when
 * `diffsDisabled()` is true.
 */
export function formatDiffBlock(
  diff: DiffPayload,
  mode: 'overlay' | 'flush',
  indent: string,
): string[] {
  // Opt-out: AFK_SHOW_DIFFS=0 suppresses the rendered block but leaves the
  // diff payload intact on the chunk for other surfaces to consume.
  // Do NOT cache the empty-array fast-path — the feature flag may be toggled
  // during a session and caching would mask the re-enable.
  if (diffsDisabled()) return [];

  // Empty-diff defensive guard. `computeLineDiff` returns null (and the
  // handlers skip attaching `render.diff`) when there are no hunks, so
  // this path is unreachable in practice — but the short-circuit keeps
  // the stat-header invariant ("emitted iff there's something to describe")
  // legible at the top of the function.
  if (diff.hunks.length === 0) return [];

  // Resolve the body-line cap. Overlay is a fixed module constant; flush
  // reads AFK_DIFF_LINES each call so tests and ad-hoc overrides work
  // without a config reload. `cap === 0` means "uncapped" (flush only).
  const cap = mode === 'overlay' ? MAX_OVERLAY_DIFF_LINES : diffFlushMaxLines();

  // Memo key must include the cap value — same payload + same mode +
  // same indent + different cap = different rendered output.
  const cacheKey = mode + '|' + indent + '|' + cap;
  const existing = _diffBlockCache.get(diff);
  if (existing !== undefined) {
    const hit = existing.get(cacheKey);
    if (hit !== undefined) return hit;
  }

  const out: string[] = [];

  // Stat header — always first line when there's content to describe.
  // Survives body truncation so the user knows the scale of the edit
  // even when only a fraction of the body is rendered.
  out.push(indent + formatStatHeader(diff));

  // Collect every renderable line so we can apply the body cap uniformly.
  type Item =
    | { kind: 'header'; text: string }
    | { kind: 'body'; text: string };
  const items: Item[] = [];

  for (const hunk of diff.hunks) {
    const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    items.push({ kind: 'header', text: palette.diffHunk(header) });
    for (const line of hunk.lines) {
      items.push({ kind: 'body', text: colorDiffLine(line) });
    }
  }

  // Uncapped path: cap === 0 only occurs in flush mode when the user set
  // AFK_DIFF_LINES=0. Emit every item without truncation.
  if (cap === 0) {
    for (const it of items) out.push(indent + it.text);
    _diffBlockCacheStore(diff, cacheKey, out);
    return out;
  }

  // Count body items to decide whether truncation is needed at all.
  // (Headers are unconditionally retained either way.)
  let totalBody = 0;
  for (const it of items) if (it.kind === 'body') totalBody++;

  if (totalBody <= cap) {
    // Under cap — emit everything, no footer.
    for (const it of items) out.push(indent + it.text);
    _diffBlockCacheStore(diff, cacheKey, out);
    return out;
  }

  // Over cap — keep all hunk headers, keep the first `cap` body lines,
  // drop the rest, and emit a footer naming the hidden-line count.
  let bodyCount = 0;
  for (const it of items) {
    if (it.kind === 'header') {
      out.push(indent + it.text);
    } else if (bodyCount < cap) {
      out.push(indent + it.text);
      bodyCount++;
    }
  }

  const hidden = totalBody - cap;
  const noun = `line${hidden === 1 ? '' : 's'}`;
  // Flush-mode footer names the env var that disables the cap. Overlay
  // mode is space-constrained and the cap isn't user-tunable, so it gets
  // the shorter footer matching the pre-change behavior.
  const hint = mode === 'flush' ? ' (set AFK_DIFF_LINES=0 to expand)' : '';
  out.push(indent + palette.dim(`… +${hidden} more diff ${noun}${hint}`));

  _diffBlockCacheStore(diff, cacheKey, out);
  return out;
}

/** Write a rendered block to the memoization cache. */
function _diffBlockCacheStore(diff: DiffPayload, key: string, result: string[]): void {
  let inner = _diffBlockCache.get(diff);
  if (inner === undefined) {
    inner = new Map<string, string[]>();
    _diffBlockCache.set(diff, inner);
  }
  inner.set(key, result);
}

