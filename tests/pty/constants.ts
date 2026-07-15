/**
 * PTY harness constants shared by the in-pty driver and the parent harness
 * (issue #541). Kept side-effect-free so the parent can import the sentinel
 * without executing the driver's top-level `main()`.
 */

/**
 * Completion marker emitted by the driver once a scenario has rendered its
 * final frame. An APC string (ESC _ ... ESC \): xterm ignores APC entirely, so
 * it produces no glyphs and triggers no scroll. The parent captures only the
 * bytes BEFORE this marker, so it never perturbs the geometry under test.
 */
export const PTY_DONE_SENTINEL = '\x1b_AFK_PTY_DONE\x1b\\';

// Invariant (resize handshake — the parent owns the winsize, the driver owns
// the timing): a scenario that wants a MID-STREAM width resize emits this APC
// marker at the exact point it wants the geometry changed, carrying the target
// `<cols>x<rows>`. Like the DONE sentinel it is an APC string, so xterm emits no
// glyphs and no scroll for it. The parent watches the byte stream, and on the
// FIRST complete marker (a) calls node-pty `child.resize(cols, rows)` — which
// SIGWINCHes the driver so its own `process.stdout` 'resize' fires and the
// compositor re-renders — and (b) records the marker's byte OFFSET so replay
// can split the captured stream into a pre-resize half (written at the OLD
// geometry) and a post-resize half (written after the emulator is resized).
// Faithful reflow requires constructing the emulator at the OLD width, writing
// the pre-bytes, calling emulator.resize(), THEN writing the post-bytes — a
// terminal reflows scrollback on resize, so building at the new width and
// writing old-width bytes would NOT model the real width-change under test.
const PTY_RESIZE_PREFIX = '\x1b_AFK_PTY_RESIZE:';
const PTY_RESIZE_SUFFIX = '\x1b\\';

/** Build the resize-handshake marker for a `<cols>x<rows>` target geometry. */
export function buildResizeMarker(cols: number, rows: number): string {
  return `${PTY_RESIZE_PREFIX}${cols}x${rows}${PTY_RESIZE_SUFFIX}`;
}

/** A located resize marker: its target geometry and byte span within the stream. */
export interface ResizeMarker {
  cols: number;
  rows: number;
  /** Byte offset of the marker's first char (split point for pre-resize bytes). */
  start: number;
  /** Byte offset one past the marker (split point for post-resize bytes). */
  end: number;
}

/**
 * Find the FIRST complete resize marker in `buf`, or null if none has fully
 * arrived yet (the marker may be split across pty read chunks — the caller
 * scans the ACCUMULATED buffer each chunk, so a partial marker simply resolves
 * on a later chunk). Malformed payloads (no `<n>x<n>`) are treated as absent.
 */
export function findResizeMarker(buf: string): ResizeMarker | null {
  const start = buf.indexOf(PTY_RESIZE_PREFIX);
  if (start < 0) return null;
  const payloadStart = start + PTY_RESIZE_PREFIX.length;
  const suffixStart = buf.indexOf(PTY_RESIZE_SUFFIX, payloadStart);
  if (suffixStart < 0) return null; // suffix not arrived yet — try again next chunk
  const payload = buf.slice(payloadStart, suffixStart);
  const m = /^(\d+)x(\d+)$/.exec(payload);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { cols: Number(m[1]), rows: Number(m[2]), start, end: suffixStart + PTY_RESIZE_SUFFIX.length };
}
