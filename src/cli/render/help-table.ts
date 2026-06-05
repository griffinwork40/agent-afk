import { displayWidth, padDisplayRight } from '../display.js';
import { getTerminalWidth } from '../terminal-size.js';
import { wrapToWidth } from '../wrap.js';
import { palette } from '../palette.js';

// ─── Help Table ───────────────────────────────────────────────────────────────

/** A command/description pair inside a help section. */
export interface HelpEntry {
  /** Command text shown in the left column, e.g. `"/exit, /quit"`. */
  cmd: string;
  /** Description shown in the right column. */
  desc: string;
}

/** A named group of help entries. */
export interface HelpSection {
  /** Section heading, e.g. `"Commands"`. */
  title: string;
  /** Entries within this section. */
  entries: HelpEntry[];
}

/**
 * Render a structured help table with aligned command / description columns.
 *
 * Example output (no ANSI):
 * ```
 * Commands
 * ─────────────────────────────────────────
 *   /exit, /quit    Exit the session
 *   /clear          Clear conversation history
 * ```
 *
 * @param sections - Help sections to render.
 */
export function helpTable(sections: HelpSection[]): string {
  const lines: string[] = [''];
  const terminalWidth = Math.max(20, getTerminalWidth());

  for (const sec of sections) {
    lines.push(palette.heading(sec.title));
    lines.push(palette.dim('─'.repeat(Math.min(44, terminalWidth))));

    const cmdW =
      Math.min(
        sec.entries.reduce((m, e) => Math.max(m, displayWidth(e.cmd)), 0) + 2,
        Math.max(8, Math.floor((terminalWidth - 2) * 0.45)),
      );
    const descW = Math.max(8, terminalWidth - 2 - cmdW);

    for (const entry of sec.entries) {
      const wrappedDesc = wrapToWidth(entry.desc, descW).split('\n');
      const paddedCmd = padDisplayRight(palette.warning(entry.cmd), cmdW);
      lines.push('  ' + paddedCmd + palette.dim(wrappedDesc[0] ?? ''));
      for (const extraLine of wrappedDesc.slice(1)) {
        lines.push('  ' + ' '.repeat(cmdW) + palette.dim(extraLine));
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
