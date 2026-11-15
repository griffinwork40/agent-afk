/** Non-interactive session export using the same renderers as /export. */
import { Command, InvalidArgumentError } from 'commander';
import { basename } from 'node:path';
import { handleCommandError } from '../errors/index.js';
import { findSession, type FoundSession } from '../session-store.js';
import { createSessionStats } from '../slash/session-stats.js';
import { renderSessionExport, resolveExportOutputPath, type ExportFormat } from '../session-export.js';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';
import { loadTrace } from './trace.js';
import { journalSessionCandidates } from './trace-results.js';

/** Accept saved names/ids, plus the witness selectors accepted by trace show. */
async function resolveExportSession(selector: string): Promise<FoundSession> {
  // A saved session does not need a witness trace (tracing may be disabled).
  if (selector !== 'latest') {
    const saved = findSession(selector);
    if (saved) return saved;
  }
  const trace = await loadTrace(selector);
  // Fresh witness labels differ from durable ids. Reuse trace show's journal
  // bridge to find the durable session sidecar for the selected trace.
  const candidates = journalSessionCandidates(trace.sessionId, trace.events);
  // Legacy sidecars may have no session_id_assigned phase. Their ledger label
  // is still handled by loadTrace when the selector is a durable session id.
  for (const id of candidates) {
    const saved = findSession(id);
    if (saved) return saved;
  }
  throw new Error(`No saved transcript found for session "${selector}". A witness trace alone does not contain conversation text.`);
}

export async function exportSavedSession(
  selector: string,
  options: { format: ExportFormat; out?: string },
): Promise<string> {
  const found = await resolveExportSession(selector);
  const stored = found.data;
  const stats = {
    ...createSessionStats(stored.model),
    ...stored,
    sessionId: stored.sessionId ?? found.id,
    sessionStartTime: stored.startedAt,
    unpricedTurns: stored.unpricedTurns ?? 0,
  };
  const content = renderSessionExport(stats, options.format);
  // Use the validated sidecar filename, not an untrusted display name or id
  // embedded in its JSON, as the default output stem.
  const outPath = await resolveExportOutputPath(options.format, options.out, basename(found.path, '.json'));
  await atomicWriteFileAsync(outPath, content, { encoding: 'utf8', mode: 0o600, mkdirp: false });
  return outPath;
}

export function registerExportCommand(program: Command): void {
  program
    .command('export <session>')
    .description('Export a saved session by name, id, witness label, or latest as a self-contained file')
    .option('--format <format>', 'Output format (md or html)', 'md')
    .option('--out <path>', 'Destination file (default: AFK_HOME/exports/<session>.md or .html)')
    .action(async (session: string, options: { format: ExportFormat; out?: string }) => {
      if (options.format !== 'md' && options.format !== 'html') {
        throw new InvalidArgumentError(`Invalid format "${options.format}". Allowed values: md, html.`);
      }
      try {
        const outPath = await exportSavedSession(session, options);
        process.stdout.write(`Exported ${options.format.toUpperCase()} → ${outPath}\n`);
        process.stderr.write('This file may contain code, file paths, and command output. Review before sharing.\n');
      } catch (err) {
        handleCommandError(err);
      }
    });
}
