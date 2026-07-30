import { displayWidth, truncateDisplayWidth } from '../../display.js';
import { palette } from '../../palette.js';
import { styleForToolName } from '../../tool-category.js';
import {
  formatOutcome,
  sanitizeLabel,
  shortenPaths,
} from './tool-lane-format.js';
import type { ToolEntry } from './tool-lane-render.js';
import { clampLineToTerminal } from './tool-lane-render.js';

function groupedResultSuffix(
  entries: ToolEntry[],
  homeDir?: string,
): string {
  const completed = entries.filter((entry) => entry.result);
  const errors = completed.filter((entry) => entry.result!.isError);

  if (errors.length > 0) {
    const successCount = completed.length - errors.length;
    const lineCounts = completed
      .filter((entry) => !entry.result!.isError)
      .map((entry) => entry.result!.lineCount)
      .filter((count): count is number => count !== undefined);
    const totalLines = lineCounts.reduce((sum, count) => sum + count, 0);
    const parts: string[] = [];
    if (totalLines > 0) parts.push(`${totalLines} lines`);
    if (successCount > 0) parts.push(`${successCount} ok`);
    parts.push(palette.error(`${errors.length} error${errors.length > 1 ? 's' : ''}`));
    return palette.dim(' — ') + parts.join(palette.dim(', '));
  }

  const lineCounts = completed
    .map((entry) => entry.result?.lineCount)
    .filter((count): count is number => count !== undefined);
  if (lineCounts.length === completed.length && lineCounts.length > 0) {
    const allSame = lineCounts.every((count) => count === lineCounts[0]);
    if (allSame) return palette.dim(` — ${lineCounts[0]} lines each`);
    const total = lineCounts.reduce((sum, count) => sum + count, 0);
    return palette.dim(` — ${total} lines total`);
  }

  if (completed.length > 0) {
    const outcomes = completed.map((entry) =>
      formatOutcome(entry.result!, homeDir, 60, entry.toolName),
    );
    return palette.dim(' — ') + outcomes.join(palette.dim(', '));
  }

  return '';
}

/**
 * Render a root-level same-tool group as one terminal-width-safe row.
 *
 * Invariant: the result summary is more durable than the repeated argument
 * previews, so its display width is reserved before the joined targets are
 * truncated. A final clamp protects very narrow terminals where the fixed
 * tool identity plus summary cannot fit even after targets are removed.
 */
export function formatGroupedToolResults(
  toolName: string,
  entries: ToolEntry[],
  cols: number,
  homeDir?: string,
): string {
  const { color, glyph } = styleForToolName(toolName);
  const prefix =
    '  ' +
    color(glyph + ' ') +
    color.bold(toolName) +
    palette.dim(` ×${entries.length}`) +
    ' ';
  const suffix = groupedResultSuffix(entries, homeDir);
  const targets = entries
    .map((entry) => shortenPaths(sanitizeLabel(entry.toolInput)).trim())
    .join(', ');
  const targetWidth = Math.max(0, cols - displayWidth(prefix) - displayWidth(suffix));
  const targetPreview = truncateDisplayWidth(targets, targetWidth);

  return clampLineToTerminal(prefix + targetPreview + suffix, cols);
}
