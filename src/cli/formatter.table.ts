import { type Tokens } from 'marked';
import { displayWidth, padDisplay, truncateDisplayWidth } from './display.js';
import { wrapToWidth } from './wrap.js';
import { palette } from './palette.js';

function visualWidth(s: string): number {
  return displayWidth(s);
}
function padCell(
  content: string,
  width: number,
  align: 'left' | 'right' | 'center' | null,
): string {
  return padDisplay(content, width, align ?? 'left');
}

/**
 * Render a GFM table token to ANSI-styled terminal output.
 *
 * Accepts a `renderInline` callback so the caller (renderMarkdownToTerminal)
 * can thread its own inline renderer — keeping inline styling (bold, italic,
 * codespan, links) consistent across the whole document without duplicating
 * the renderer here.
 *
 * Column widths are computed with a floor-based water-filling squeeze
 * algorithm so the table always fits within `maxTableWidth` without crushing
 * narrow single-word columns to an ellipsis.  See the inline comments for the
 * full invariant.
 */
export function renderTable(
  table: Tokens.Table,
  maxTableWidth: number | undefined,
  renderInline: (tokens?: Tokens.Generic[]) => string,
): string {
  const renderCell = (cell: Tokens.TableCell) =>
    cell.tokens ? renderInline(cell.tokens as Tokens.Generic[]) : cell.text;
  const headerCells = table.header.map(renderCell);
  const dataRows = table.rows.map((row) => row.map(renderCell));
  const colCount = headerCells.length;
  const widths: number[] = new Array<number>(colCount).fill(0);
  // longestWord[i] = widest UNBREAKABLE token in column i. A word cannot
  // be wrapped, so it is the column's incompressible minimum — used by the
  // squeeze below as a per-column floor so a narrow single-word column
  // (e.g. a "Verdict" of CONFIRMED/OVERSTATED) is never crushed below its
  // own content and chopped to an ellipsis.
  const longestWord: number[] = new Array<number>(colCount).fill(0);
  const wordWidth = (s: string): number => {
    let max = 0;
    for (const tok of s.split(/\s+/)) {
      if (tok) max = Math.max(max, visualWidth(tok));
    }
    return max;
  };
  for (let i = 0; i < colCount; i++) {
    let w = visualWidth(headerCells[i] ?? '');
    let lw = wordWidth(headerCells[i] ?? '');
    for (const row of dataRows) {
      w = Math.max(w, visualWidth(row[i] ?? ''));
      lw = Math.max(lw, wordWidth(row[i] ?? ''));
    }
    widths[i] = w;
    longestWord[i] = lw;
  }

  const targetWidth = maxTableWidth ?? Number.POSITIVE_INFINITY;
  const chromeWidth = (3 * colCount) + 1;
  const availableContentWidth = Math.max(0, targetWidth - chromeWidth);
  const totalContentWidth = widths.reduce((sum, width) => sum + width, 0);
  if (Number.isFinite(targetWidth) && totalContentWidth > availableContentWidth) {
    // Invariant: after this block sum(widths) <= availableContentWidth, so
    // every emitted row fits maxTableWidth and the commit-time second
    // wrapToWidth pass (markdown-stream-format.ts) stays a no-op for tables
    // (a row even 1 col over budget would re-split at its last space into a
    // fragment + orphan '│' line and desync the compositor's row count).
    //
    // Allocation is floor-based water-filling, NOT uniform proportional
    // shrink. Proportional shrink scaled every column by the same factor,
    // so a high overflow ratio crushed narrow single-word columns (a
    // "Verdict" of CONFIRMED/OVERSTATED) below their content width and
    // truncateDisplayWidth chopped them to "Verd…". Instead: floor each
    // column at min(natural, longestWord, WORD_FLOOR_CAP) — its
    // incompressible width, capped so one long token (a path/URL) cannot
    // starve the rest — then hand the leftover budget to columns in
    // proportion to their reducible slack (natural - floor). All the
    // squeeze lands on genuinely wide columns; narrow ones stay readable.
    const WORD_FLOOR_CAP = 14;
    const floors = widths.map((w, i) =>
      Math.min(w, Math.max(1, Math.min(longestWord[i] ?? 1, WORD_FLOOR_CAP))),
    );
    const floorTotal = floors.reduce((sum, w) => sum + w, 0);
    const constrained = floors.slice();
    if (floorTotal <= availableContentWidth) {
      const slack = widths.map((w, i) => Math.max(0, w - (floors[i] ?? 0)));
      const slackTotal = slack.reduce((sum, s) => sum + s, 0);
      const leftover = availableContentWidth - floorTotal;
      if (slackTotal > 0 && leftover > 0) {
        for (let i = 0; i < colCount; i++) {
          constrained[i] = (floors[i] ?? 0) +
            Math.floor(((slack[i] ?? 0) / slackTotal) * leftover);
        }
        // Hand the Math.floor remainder to the widest-slack columns until
        // the total reaches exactly availableContentWidth (never over it).
        const order = constrained
          .map((_, i) => i)
          .sort((a, b) => (slack[b] ?? 0) - (slack[a] ?? 0));
        let used = constrained.reduce((sum, w) => sum + w, 0);
        let guard = 0;
        while (used < availableContentWidth && order.length > 0 && guard < colCount * 4) {
          const i = order[guard % order.length]!;
          if ((constrained[i] ?? 0) < (widths[i] ?? 0)) {
            constrained[i] = (constrained[i] ?? 0) + 1;
            used += 1;
          }
          guard += 1;
        }
      }
    } else {
      // Degenerate: even the floors exceed the budget (too many columns
      // for the width — chromeWidth alone can dominate). Shrink the floors
      // proportionally to fit, preserving relative column sizes. The
      // return-line cap below still guarantees no line exceeds the budget.
      const scale = availableContentWidth / floorTotal;
      for (let i = 0; i < colCount; i++) {
        constrained[i] = Math.max(1, Math.floor((floors[i] ?? 0) * scale));
      }
      let constrainedTotal = constrained.reduce((sum, w) => sum + w, 0);
      while (constrainedTotal > availableContentWidth) {
        let widest = -1;
        for (let i = 0; i < colCount; i++) {
          if ((constrained[i] ?? 0) > 1 &&
              (widest === -1 || (constrained[i] ?? 0) > (constrained[widest] ?? 0))) {
            widest = i;
          }
        }
        if (widest === -1) break;
        constrained[widest] = (constrained[widest] ?? 0) - 1;
        constrainedTotal -= 1;
      }
      // Grow back budget lost to flooring in the scale step: Math.floor
      // discards fractional units, so the total can land BELOW
      // availableContentWidth (e.g. natural widths [37,3,3,3,3] at
      // maxWidth 30 use 11 of 14). Hand the reclaimed slack to the widest
      // columns first (by natural width), capped at each column's natural
      // width so none is padded past its content, until the budget is met.
      // Keeps the table as wide as the budget allows. Bounded: the deficit
      // is < colCount, so one pass over growOrder suffices.
      const growOrder = constrained
        .map((_, i) => i)
        .sort((a, b) => (widths[b] ?? 0) - (widths[a] ?? 0) || a - b);
      let grow = 0;
      while (constrainedTotal < availableContentWidth && grow < colCount * 4) {
        const i = growOrder[grow % growOrder.length]!;
        if ((constrained[i] ?? 0) < (widths[i] ?? 0)) {
          constrained[i] = (constrained[i] ?? 0) + 1;
          constrainedTotal += 1;
        }
        grow += 1;
      }
    }
    for (let i = 0; i < colCount; i++) {
      widths[i] = constrained[i] ?? widths[i] ?? 0;
    }
  }

  const aligns = table.align;
  const borderLine = (left: string, mid: string, right: string) =>
    palette.dim(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right);
  const wrapCell = (content: string, width: number) => {
    if (width <= 0) return [''];
    const rendered = wrapToWidth(content, width);
    return rendered.split('\n').map((line) => truncateDisplayWidth(line, width));
  };
  const dataLines = (cells: string[], header = false) => {
    const wrapped = cells.map((cell, i) =>
      wrapCell(
        header ? palette.bold(cell) : cell,
        widths[i] ?? 0,
      ),
    );
    const rowHeight = Math.max(1, ...wrapped.map((lines) => lines.length));
    const lines: string[] = [];
    for (let row = 0; row < rowHeight; row++) {
      lines.push(
        palette.dim('│') +
          wrapped
            .map((cellLines, i) => ' ' + padCell(cellLines[row] ?? '', widths[i] ?? 0, aligns[i] ?? null) + ' ')
            .join(palette.dim('│')) +
          palette.dim('│'),
      );
    }
    return lines;
  };
  const lines: string[] = [borderLine('┌', '┬', '┐')];
  lines.push(...dataLines(headerCells, true));
  lines.push(borderLine('├', '┼', '┤'));

  for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
    lines.push(...dataLines(dataRows[rowIdx]!));
    // Add a thin row separator between data rows (but not after the last row)
    if (rowIdx < dataRows.length - 1) {
      lines.push(borderLine('├', '┼', '┤'));
    }
  }

  lines.push(borderLine('└', '┴', '┘'));
  // Safety net: hard-cap every emitted line to the budget. In the normal
  // and degenerate squeeze paths the rows already fit, so this is a no-op;
  // it only bites in pathological cases (e.g. chromeWidth alone exceeds
  // targetWidth), guaranteeing the downstream wrapToWidth never re-splits
  // a structural table row regardless of column math.
  if (!Number.isFinite(targetWidth)) {
    return lines.join('\n') + '\n';
  }
  const lineCap = Math.floor(targetWidth);
  return lines.map((line) => truncateDisplayWidth(line, lineCap)).join('\n') + '\n';
}
