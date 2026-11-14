/** Shared export formatting and destination policy for the REPL and CLI. */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getAfkHome } from '../paths.js';
import { renderSessionMarkdown } from './slash/commands/export.render-md.js';
import { renderSessionHtml } from './slash/commands/export.render-html.js';
import type { SessionStats } from './slash/types.js';

export type ExportFormat = 'md' | 'html';

export function renderSessionExport(stats: SessionStats, format: ExportFormat): string {
  return format === 'html' ? renderSessionHtml(stats) : renderSessionMarkdown(stats);
}

export async function resolveExportOutputPath(
  format: ExportFormat,
  explicit: string | undefined,
  sessionId: string | undefined,
): Promise<string> {
  const ext = `.${format}`;
  if (explicit) return explicit.endsWith(ext) ? explicit : explicit + ext;
  const exportDir = join(getAfkHome(), 'exports');
  await mkdir(exportDir, { recursive: true });
  return join(exportDir, `${sessionId ?? `session-${Date.now()}`}${ext}`);
}
