import type { BandRowMeta } from './terminal-compositor.types.js';
import { hardWrapToWidth } from './wrap.js';
import { buildBandMeta } from './terminal-compositor.scrollback.js';

export interface CommitText {
  logicalLines: string[];
  hasTrailingSeparator: boolean;
  contentLines: string[];
  contentMeta: BandRowMeta[];
  contentLineCount: number;
  separatorMeta: BandRowMeta;
}

/**
 * Decompose a raw commit text string into its logical lines, physical
 * content rows (hard-wrapped to `cols`), per-row provenance metadata, and
 * separator detection — everything the caller needs for geometry/routing
 * without doing any terminal I/O.
 */
export function decomposeCommitText(text: string, cols: number): CommitText {
  // Strip trailing newline (line terminator, not its own row).
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text;

  // Separate a block's CONTENT from its trailing blank SEPARATOR.
  //
  // commitBlock commits prose as `trimmed + '\n\n'` — the TUI rhythm contract:
  // every block owns exactly one trailing blank (docs/tui-rhythm.md). After the
  // single-'\n' strip above, a separator-terminated block's `stripped` still
  // ends with '\n', so split('\n') yields a trailing '' — the separator row. A
  // block with NO separator (`commitAbove('A\nB')`, or the single-terminator
  // `commitAbove('A\nB\n')`) leaves no trailing '' (its lone '\n' was stripped).
  //
  // Pop the trailing '' so `contentLines` / `contentLineCount` describe ONLY
  // real content: a phantom trailing '' previously made textLines.length =
  // count+1, and in the exact-fit scenario (content height === above-frame
  // room) the tail-slice dropped a table's top border and painted the '' into
  // the bottom slot (d86f2a2). The separator is RE-ADDED as a painted blank row
  // below — but only when there is room for it beyond the content (a block that
  // exactly fills the room keeps all its content and drops the separator, so the
  // newest content still sits against the frame). The length>1 guard keeps
  // `commitAbove('')` painting its single blank row (the subagent-done path).
  const logicalLines = stripped.split('\n');
  let hasTrailingSeparator = false;
  while (logicalLines.length > 1 && logicalLines[logicalLines.length - 1] === '') {
    logicalLines.pop();
    hasTrailingSeparator = true;
  }

  // Wrap-aware physical CONTENT rows: a logical line wider than the terminal
  // occupies >1 physical row. hardWrapToWidth (pure char wrap, ANSI-preserving,
  // matches the terminal) makes commitAbove position/scroll/paint exactly one
  // terminal row per array entry — so a wide line's wrapped tail is not "eaten"
  // by the next commit's paint, and the band-hold row math is exact.
  const contentLines = logicalLines.flatMap((l) => hardWrapToWidth(l, cols).split('\n'));
  const contentLineCount = Math.max(1, contentLines.length);

  // #540 axis-2 (retained logical source): the per-physical-row provenance for
  // `contentLines`, index-aligned 1:1. Recorded from the SAME logical lines +
  // width that produced the physical rows above, so the scrollback-flush sites
  // can later emit the logical line (terminal-soft-wrapped, reflow-clean)
  // instead of these pre-hard-wrapped rows. The separator blank row (added to
  // textLines/bandTextLines below) is its own logical line ''.
  const contentMeta = buildBandMeta(logicalLines, cols);
  const separatorMeta: BandRowMeta = { logicalText: '', isHead: true };

  return {
    logicalLines,
    hasTrailingSeparator,
    contentLines,
    contentMeta,
    contentLineCount,
    separatorMeta,
  };
}
