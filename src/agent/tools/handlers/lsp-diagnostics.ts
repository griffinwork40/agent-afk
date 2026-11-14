/**
 * Opt-in post-edit LSP diagnostics for the edit_file and write_file tools.
 *
 * Phase 1 of #3904: after a successful file write, query a language server for
 * diagnostics on the touched file and append any new errors/warnings to the
 * tool result. Off by default (AFK_LSP_DIAGNOSTICS=1 to enable). A missing or
 * slow server never fails or stalls the edit — the call times out and returns
 * an empty array.
 *
 * Design constraints:
 *   - Hard timeout (AFK_LSP_DIAGNOSTICS_TIMEOUT_MS, default 1500 ms).
 *   - Silent degradation: any error → empty result, never an exception.
 *   - TypeScript only in this phase; Python (pyright) is a follow-up.
 *   - LSP server binary: `typescript-language-server --stdio` on PATH.
 *   - Persistent server (#4272): the file is synced into the warm pooled
 *     server for its workspace root (didOpen first, then didChange with
 *     version++ on content change) and the handler waits for the
 *     publishDiagnostics for that uri (version-matched when reported) within
 *     the timeout. A cold start counts against the same budget.
 *
 * @module agent/tools/handlers/lsp-diagnostics
 */

import path from 'node:path';
import { env } from '../../../config/env.js';
import { getTimeoutMs, readLspSource } from './lsp-shared.js';
import { awaitSyncDiagnostics, withPooledFile } from '../../lsp/query.js';
import {
  DEFAULT_LSP_CMD,
  TYPESCRIPT_SERVER_DEFINITION,
  typescriptRootFor,
  typescriptSpecFromCommand,
} from '../../lsp/typescript-default.js';

/** A single LSP diagnostic item (subset of the full LSP spec). */
export interface LspDiagnostic {
  /** LSP severity: 1=Error, 2=Warning, 3=Information, 4=Hint. */
  severity: number;
  /** Human-readable message. */
  message: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  col: number;
}

/** Severity labels matching LSP spec values 1–4. */
const SEVERITY_LABEL: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

/**
 * Return true when the LSP diagnostics feature is enabled.
 * Reads AFK_LSP_DIAGNOSTICS from env — truthy iff "1" or "true".
 */
export function isLspDiagnosticsEnabled(): boolean {
  const raw = env.AFK_LSP_DIAGNOSTICS;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Query typescript-language-server for diagnostics on `filePath`.
 *
 * Returns an empty array on any error (server not found, timeout, parse
 * failure). Never throws.
 *
 * @param filePath - Absolute path to the file to diagnose.
 * @param serverCmd - LSP server binary + args (injectable for tests).
 */
export async function queryLspDiagnostics(
  filePath: string,
  serverCmd: readonly string[] = DEFAULT_LSP_CMD,
  signal?: AbortSignal,
): Promise<LspDiagnostic[]> {
  if (!TYPESCRIPT_SERVER_DEFINITION.languageIds[path.extname(filePath).toLowerCase()]) return [];
  const t0 = Date.now();
  const budgetMs = getTimeoutMs();
  let content: string;
  try {
    content = await readLspSource(filePath, budgetMs, signal);
  } catch {
    return [];
  }
  const spec = typescriptSpecFromCommand(serverCmd);
  try {
    // F4: subtract the time spent reading the file so the withPooledFile
    // deadline covers the full budget, not just what remains after the read.
    const elapsed = Date.now() - t0;
    const published = await withPooledFile(
      spec, filePath, content,
      { root: typescriptRootFor(filePath), timeoutMs: Math.max(0, budgetMs - elapsed), signal },
      (ctx) => awaitSyncDiagnostics(ctx, signal),
    );
    return published ? published.diagnostics.filter(isObject).map(toDiagnostic) : [];
  } catch (err) {
    if (env.AFK_DEBUG) process.stderr.write(`[afk:lsp-diagnostics] ${String(err)}\n`);
    return [];
  }
}

function isObject(d: unknown): d is object {
  return typeof d === 'object' && d !== null;
}

/** Normalize one raw LSP diagnostic (0-based) to `LspDiagnostic` (1-based). */
function toDiagnostic(d: object): LspDiagnostic {
  const dr = d as {
    severity?: number;
    message?: string;
    range?: { start?: { line?: number; character?: number } };
  };
  return {
    severity: typeof dr.severity === 'number' ? dr.severity : 1,
    message: typeof dr.message === 'string' ? dr.message : '',
    line: (typeof dr.range?.start?.line === 'number' ? dr.range.start.line : 0) + 1,
    col: (typeof dr.range?.start?.character === 'number' ? dr.range.start.character : 0) + 1,
  };
}

/**
 * Format a diagnostics array into a compact, human-readable string appended
 * to the tool result. Returns an empty string when there are no diagnostics.
 *
 * Example output:
 *   \n[LSP] 2 diagnostic(s) in foo.ts:\n  error L3:1 — Type 'string' is not assignable to type 'number'.
 */
export function formatDiagnostics(filePath: string, diags: LspDiagnostic[]): string {
  if (diags.length === 0) return '';
  const header = `\n[LSP] ${diags.length} diagnostic(s) in ${filePath}:`;
  const lines = diags.map((d) => {
    const sev = SEVERITY_LABEL[d.severity] ?? 'diagnostic';
    return `  ${sev} L${d.line}:${d.col} — ${d.message}`;
  });
  return [header, ...lines].join('\n');
}

/**
 * Run LSP diagnostics for `filePath` and return a formatted suffix to append
 * to the tool result string. Returns '' when the feature is disabled, the
 * server is absent, or any error occurs.
 *
 * This is the single call site used by edit_file and write_file.
 */
export async function appendLspDiagnostics(
  filePath: string,
  serverCmd?: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  if (!isLspDiagnosticsEnabled()) return '';
  try {
    const diags = await queryLspDiagnostics(filePath, serverCmd, signal);
    return formatDiagnostics(filePath, diags);
  } catch {
    return '';
  }
}
