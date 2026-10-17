/**
 * /export [md|html] [path] — self-contained session export.
 *
 * Writes a portable artifact containing the full transcript, collapsible
 * tool-call blocks (args + result), and a trace summary.
 *
 * Formats:
 *   md   — GitHub-flavoured markdown with <details> collapsibles
 *   html — single self-contained file, inline CSS, no external assets
 *
 * Secrets are passed through `redactSecrets` before writing; the user is
 * reminded the file may contain code and paths.
 *
 * Usage:
 *   /export           → md to ~/.afk/exports/<sessionId>.md (default)
 *   /export html      → html to ~/.afk/exports/<sessionId>.html
 *   /export md ./out  → md to ./out.md (extension added if missing)
 *   /export html /tmp/run.html
 *
 * @module cli/slash/commands/export
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getAfkHome } from '../../../paths.js';
import { renderSessionMarkdown } from './export.render-md.js';
import { renderSessionHtml } from './export.render-html.js';
import type { SlashCommand } from '../types.js';

type ExportFormat = 'md' | 'html';

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseArgs(raw: string): { format: ExportFormat; outPath: string | undefined } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  let format: ExportFormat = 'md';
  let outPath: string | undefined;

  for (const part of parts) {
    if (part === 'md' || part === 'html') {
      format = part;
    } else {
      outPath = part;
    }
  }
  return { format, outPath };
}

// ---------------------------------------------------------------------------
// path resolution
// ---------------------------------------------------------------------------

async function resolveOutputPath(
  format: ExportFormat,
  explicit: string | undefined,
  sessionId: string | undefined,
): Promise<string> {
  const ext = `.${format}`;
  if (explicit) {
    // Add extension if caller omitted it.
    return explicit.endsWith(ext) ? explicit : explicit + ext;
  }
  const exportDir = path.join(getAfkHome(), 'exports');
  await fs.mkdir(exportDir, { recursive: true });
  const stem = sessionId ?? `session-${Date.now()}`;
  return path.join(exportDir, `${stem}${ext}`);
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

export const exportCmd: SlashCommand = {
  name: '/export',
  summary: 'Export session as a self-contained md or html file',
  usage: '/export [md|html] [path]',
  hint: 'When you want a portable artifact of the full session — transcript, tool calls, and cost summary — to share or archive offline.',
  async handler(ctx, args) {
    const { stats, out } = ctx;

    if (stats.turns.length === 0) {
      out.info('Nothing to export — no turns in this session yet.');
      return 'continue';
    }

    const { format, outPath: explicitPath } = parseArgs(args);
    const outPath = await resolveOutputPath(format, explicitPath, stats.sessionId);

    let content: string;
    try {
      content = format === 'html'
        ? renderSessionHtml(stats)
        : renderSessionMarkdown(stats);
    } catch (err) {
      out.error(`Export render failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'continue';
    }

    try {
      await fs.writeFile(outPath, content, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      out.error(`Could not write export to ${outPath}: ${err instanceof Error ? err.message : String(err)}`);
      return 'continue';
    }

    const kb = (Buffer.byteLength(content, 'utf8') / 1024).toFixed(1);
    out.success(`Exported ${format.toUpperCase()} (${kb} KB) → ${outPath}`);
    out.warn('This file may contain code, file paths, and command output. Review before sharing.');

    return 'continue';
  },
};
