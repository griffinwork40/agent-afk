/**
 * Opt-in LSP symbol lookup for the `code_symbols` tool (phase 2 of #3904).
 *
 * Exposes go-to-definition and find-references backed by the same
 * typescript-language-server plumbing introduced in phase 1
 * (`lsp-diagnostics.ts`). Off by default behind the same
 * `AFK_LSP_DIAGNOSTICS` flag — no new env var is introduced; the flag
 * enables the whole LSP surface.
 *
 * Design constraints (mirrors phase 1):
 *   - Hard timeout (AFK_LSP_DIAGNOSTICS_TIMEOUT_MS, default 1500 ms).
 *   - Silent degradation: any error → structured error result, never throws.
 *   - TypeScript / JS only in this phase; Python (pyright) is a follow-up.
 *   - LSP server binary: `typescript-language-server --stdio` on PATH.
 *   - Persistent server (#4272): queries share one warm server per
 *     (workspace root, language) via `LspServerPool`; a crashed server is
 *     evicted and the next query spawns a fresh one.
 *
 * Security: the input `filePath` is resolved through `resolveAndContain`
 * (read-denylist + root containment) before any file read or LSP query, and
 * LSP response locations are filtered through `decidePathAccess` so
 * denylisted paths are never surfaced in tool output.
 *
 * @module agent/tools/handlers/lsp-symbols
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../../../config/env.js';
import { resolveAndContain } from './_cwd-utils.js';
import { decidePathAccess } from './path-policy.js';
import type { ToolHandlerContext } from '../types.js';
import { getSymbolsTimeoutMs, lspFailureMessage } from './lsp-shared.js';
import { realpathSafe } from './_cwd-utils.js';
import { withPooledFile } from '../../lsp/query.js';
import {
  DEFAULT_LSP_CMD,
  TYPESCRIPT_SERVER_DEFINITION,
  typescriptRootFor,
  typescriptSpecFromCommand,
} from '../../lsp/typescript-default.js';

// ── Public types ─────────────────────────────────────────────────────────────

/** A single resolved location (definition or reference). */
export interface LspLocation {
  /** Absolute file path. */
  filePath: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  col: number;
}

/** Result returned by `queryLspSymbol`. */
export interface LspSymbolResult {
  /** Resolved locations (may be empty). */
  locations: LspLocation[];
  /** Human-readable error when the query failed (server absent, timeout…). */
  error?: string;
}

/** Subcommand accepted by the `code_symbols` tool. */
export type SymbolSubcommand = 'definition' | 'references';

/** Default LSP server command — shared by `queryLspSymbol` and `handleCodeSymbols`. */
export { DEFAULT_LSP_CMD };

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Parse an LSP Location or LocationLink into an LspLocation. */
export function parseLocation(raw: unknown): LspLocation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const loc = raw as {
    uri?: string;
    range?: { start?: { line?: number; character?: number } };
    targetUri?: string;
    targetRange?: { start?: { line?: number; character?: number } };
  };
  const uri = loc.targetUri ?? loc.uri;
  const range = loc.targetRange ?? loc.range;
  // Treat missing uri or range.start as malformed — skip rather than defaulting.
  if (typeof uri !== 'string') return null;
  if (typeof range?.start?.line !== 'number' || typeof range?.start?.character !== 'number') return null;
  let filePath: string;
  try { filePath = fileURLToPath(uri); } catch { return null; }

  // Security: resolve symlinks via realpathSafe before access-policy check so
  // symlinks cannot escape read roots (e.g. a symlink pointing outside the
  // workspace would otherwise bypass decidePathAccess).
  try { filePath = realpathSafe(filePath); } catch { return null; }

  // Security (finding 2): filter out locations pointing at denylisted paths
  // so credential paths from LSP responses are never surfaced in tool output.
  const decision = decidePathAccess(filePath, 'read');
  if (decision.kind === 'deny') return null;

  const line = range.start.line + 1;
  const col = range.start.character + 1;
  return { filePath, line, col };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return true when the LSP feature is enabled (same flag as phase 1).
 * Reads AFK_LSP_DIAGNOSTICS — truthy iff "1" or "true".
 */
export function isLspSymbolsEnabled(): boolean {
  const raw = env.AFK_LSP_DIAGNOSTICS;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Query typescript-language-server for go-to-definition or find-references at
 * a position in `filePath`.
 *
 * Returns `{ locations: [], error: '...' }` on any failure. Never throws.
 *
 * @param filePath   - Absolute path to the file.
 * @param subcommand - `'definition'` or `'references'`.
 * @param line       - 1-based line number.
 * @param col        - 1-based column number.
 * @param rootDir    - Workspace root for rootUri (session cwd). When provided,
 *                     enables cross-file definition/references.
 * @param serverCmd  - LSP server binary + args (injectable for tests).
 * @param signal     - Optional AbortSignal; resolves immediately with an error
 *                     when aborted before the LSP server responds.
 */
export async function queryLspSymbol(
  filePath: string,
  subcommand: SymbolSubcommand,
  line: number,
  col: number,
  rootDir?: string,
  serverCmd: readonly string[] = DEFAULT_LSP_CMD,
  signal?: AbortSignal,
): Promise<LspSymbolResult> {
  if (signal?.aborted) return { locations: [], error: 'Aborted' };
  const ext = path.extname(filePath);
  if (!TYPESCRIPT_SERVER_DEFINITION.languageIds[ext.toLowerCase()]) {
    return { locations: [], error: `Unsupported file type: ${ext}` };
  }
  const t0 = Date.now();
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return { locations: [], error: 'Failed to read source file' };
  }
  const spec = typescriptSpecFromCommand(serverCmd);
  const root = rootDir ?? typescriptRootFor(filePath);
  const lspMethod = subcommand === 'definition' ? 'textDocument/definition' : 'textDocument/references';
  // F4: subtract the time spent reading the file so the withPooledFile
  // deadline covers the full budget, not just what remains after the read.
  const elapsed = Date.now() - t0;
  const timeoutMs = Math.max(0, getSymbolsTimeoutMs() - elapsed);
  try {
    const raw = await withPooledFile(spec, filePath, content, { root, timeoutMs, signal }, (ctx) => {
      const params: Record<string, unknown> = {
        textDocument: { uri: ctx.sync.uri },
        // LSP uses 0-based positions.
        position: { line: line - 1, character: col - 1 },
      };
      // includeDeclaration:false — report call-sites only; the declaration
      // itself is a separate go-to-definition query.
      if (subcommand === 'references') params['context'] = { includeDeclaration: false };
      return ctx.client.request<unknown>(lspMethod, params, { timeoutMs: ctx.remainingMs(), signal });
    });
    const items = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
    const locations: LspLocation[] = [];
    for (const item of items) {
      const loc = parseLocation(item);
      if (loc) locations.push(loc);
    }
    return { locations };
  } catch (err) {
    const error = lspFailureMessage(err, 'LSP symbols timed out (increase AFK_LSP_SYMBOLS_TIMEOUT_MS)');
    if (env.AFK_DEBUG) process.stderr.write(`[afk:lsp-symbols] ${error}\n`);
    return { locations: [], error };
  }
}

/**
 * Format an LspSymbolResult for display as a tool result string.
 */
export function formatSymbolResult(
  filePath: string,
  subcommand: SymbolSubcommand,
  line: number,
  col: number,
  result: LspSymbolResult,
): string {
  if (result.error) {
    return `[LSP] ${subcommand} unavailable: ${result.error}`;
  }
  if (result.locations.length === 0) {
    return `[LSP] ${subcommand} for symbol at ${filePath}:${line}:${col} — no locations found`;
  }
  const header = `[LSP] ${subcommand} for symbol at ${filePath}:${line}:${col} → ${result.locations.length} location(s):`;
  const lines = result.locations.map((l) => `  ${l.filePath}:${l.line}:${l.col}`);
  return [header, ...lines].join('\n');
}

/**
 * Handler entry point for the `code_symbols` tool.
 *
 * Security (finding 1): the input `file_path` is resolved through
 * `resolveAndContain` with the session's handler context and fallback cwd,
 * enforcing both read-denylist and root containment before any file read.
 */
export async function handleCodeSymbols(
  input: {
    file_path: string;
    subcommand: SymbolSubcommand;
    line: number;
    col: number;
  },
  context?: ToolHandlerContext,
  cwd?: string,
  serverCmd?: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  if (!isLspSymbolsEnabled()) {
    return (
      'code_symbols requires AFK_LSP_DIAGNOSTICS=1 and typescript-language-server on PATH. ' +
      'Set AFK_LSP_DIAGNOSTICS=1 to enable the LSP surface.'
    );
  }

  // Finding 1: enforce read-denylist + root containment on the input path.
  let resolvedPath: string;
  try {
    resolvedPath = resolveAndContain(input.file_path, context, 'read', cwd);
  } catch (err) {
    return `[LSP] code_symbols: ${(err as Error).message}`;
  }

  try {
    const rootDir = context?.resolveBase ?? cwd;
    const result = await queryLspSymbol(
      resolvedPath, input.subcommand, input.line, input.col, rootDir,
      serverCmd ?? DEFAULT_LSP_CMD,
      signal,
    );
    return formatSymbolResult(input.file_path, input.subcommand, input.line, input.col, result);
  } catch {
    return '[LSP] code_symbols: unexpected error';
  }
}
