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
 *   - No persistent server — each call spawns, queries, and exits.
 *
 * LSP sequence for symbol lookup:
 *   1. Send `initialize` request.
 *   2. Send `initialized` notification.
 *   3. Send `textDocument/didOpen` with the file content.
 *   4. Send `textDocument/definition` or `textDocument/references` request.
 *   5. Await the response (id matches step-4 request id).
 *   6. Send `shutdown` + `exit`.
 *
 * Security: the input `filePath` is resolved through `resolveAndContain`
 * (read-denylist + root containment) before any file read or LSP query, and
 * LSP response locations are filtered through `decidePathAccess` so
 * denylisted paths are never surfaced in tool output.
 *
 * @module agent/tools/handlers/lsp-symbols
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { env } from '../../../config/env.js';
import { resolveAndContain } from './_cwd-utils.js';
import { decidePathAccess } from './path-policy.js';
import type { ToolHandlerContext } from '../types.js';
import {
  encodeMessage,
  killProc,
  parseMessages,
  languageIdForExt,
  getSymbolsTimeoutMs,
} from './lsp-shared.js';
import { realpathSafe } from './_cwd-utils.js';

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
  serverCmd: readonly string[] = ['typescript-language-server', '--stdio'],
  signal?: AbortSignal,
): Promise<LspSymbolResult> {
  if (signal?.aborted) return { locations: [], error: 'Aborted' };
  const timeoutMs = getSymbolsTimeoutMs();
  const langId = languageIdForExt(path.extname(filePath));
  if (!langId) {
    return { locations: [], error: `Unsupported file type: ${path.extname(filePath)}` };
  }

  let proc: ChildProcess | null = null;

  return new Promise<LspSymbolResult>((resolve) => {
    let settled = false;
    const done = (result: LspSymbolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc) killProc(proc);
      resolve(result);
    };

    const timer = setTimeout(() => {
      if (env.AFK_DEBUG) {
        process.stderr.write(`[afk:lsp-symbols] timeout after ${timeoutMs}ms — server did not respond\n`);
      }
      done({ locations: [], error: 'LSP symbols timed out (increase AFK_LSP_SYMBOLS_TIMEOUT_MS)' });
    }, timeoutMs);
    timer.unref();

    // Honour abort signal: resolve immediately if the caller cancels.
    const onAbort = () => done({ locations: [], error: 'Aborted' });
    signal?.addEventListener('abort', onAbort, { once: true });

    readFile(filePath, 'utf8')
      .then((fileContent) => {
        if (settled) return;

        const [cmd, ...args] = serverCmd as [string, ...string[]];
        try {
          proc = spawn(cmd, args, {
            stdio: ['pipe', 'pipe', 'ignore'],
            shell: process.platform === 'win32',
          });
        } catch (spawnErr) {
          if (env.AFK_DEBUG) {
            process.stderr.write(`[afk:lsp-symbols] spawn failed: ${String(spawnErr)}\n`);
          }
          done({ locations: [], error: 'Failed to spawn LSP server' });
          return;
        }

        proc.on('error', (procErr) => {
          if (env.AFK_DEBUG) {
            process.stderr.write(`[afk:lsp-symbols] process error: ${String(procErr)}\n`);
          }
          done({ locations: [], error: 'LSP server process error' });
        });

        const uri = pathToFileURL(filePath).toString();
        // Finding 5: send session cwd as rootUri so cross-file
        // definition/references work instead of sending null.
        const rootUri = rootDir ? pathToFileURL(rootDir).toString() : null;
        let reqId = 0;
        const chunks: Buffer[] = [];

        const send = (msg: unknown) => {
          try { proc!.stdin!.write(encodeMessage(msg)); } catch { /* stdin closed */ }
        };

        // 1. Initialize — with rootUri and workspaceFolders for cross-file support.
        send({
          jsonrpc: '2.0',
          id: ++reqId,
          method: 'initialize',
          params: {
            processId: process.pid,
            rootUri,
            ...(rootUri ? { workspaceFolders: [{ uri: rootUri, name: 'workspace' }] } : {}),
            capabilities: {},
          },
        });

        // 2. Initialized notification
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });

        // 3. didOpen
        send({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: {
            textDocument: { uri, languageId: langId, version: 1, text: fileContent },
          },
        });

        // 4. Symbol request — LSP uses 0-based positions.
        const symbolReqId = ++reqId;
        const lspMethod = subcommand === 'definition'
          ? 'textDocument/definition'
          : 'textDocument/references';
        const params: Record<string, unknown> = {
          textDocument: { uri },
          position: { line: line - 1, character: col - 1 },
        };
        if (subcommand === 'references') {
          // includeDeclaration:false — report call-sites only; the declaration
          // itself is a separate go-to-definition query.
          params['context'] = { includeDeclaration: false };
        }
        send({ jsonrpc: '2.0', id: symbolReqId, method: lspMethod, params });

        // 5. Read responses — wait for the reply whose id === symbolReqId.
        proc.stdout!.on('data', (chunk: Buffer) => {
          if (settled) return;
          chunks.push(chunk);
          const buf = Buffer.from(Buffer.concat(chunks));
          const { messages, remaining } = parseMessages(buf);
          chunks.length = 0;
          chunks.push(remaining);

          for (const msg of messages) {
            if (typeof msg !== 'object' || msg === null) continue;
            const m = msg as { id?: unknown; result?: unknown; error?: unknown };
            if (m.id !== symbolReqId) continue;
            // Skip messages that carry neither result nor error — not a valid
            // JSON-RPC response for our request (e.g. a stray notification).
            if (!('result' in m) && !('error' in m)) continue;

            // 6. Graceful shutdown.
            send({ jsonrpc: '2.0', id: ++reqId, method: 'shutdown', params: null });
            send({ jsonrpc: '2.0', method: 'exit', params: null });

            if (m.error !== undefined) {
              done({ locations: [], error: 'LSP server returned an error' });
              return;
            }

            const raw = m.result;
            const locations: LspLocation[] = [];
            if (Array.isArray(raw)) {
              for (const item of raw) {
                const loc = parseLocation(item);
                if (loc) locations.push(loc);
              }
            } else if (raw !== null && raw !== undefined) {
              const loc = parseLocation(raw);
              if (loc) locations.push(loc);
            }

            done({ locations });
            return;
          }
        });

        proc.on('close', (code) => {
          if (env.AFK_DEBUG) {
            process.stderr.write(`[afk:lsp-symbols] server closed (code=${code ?? 'null'}) before responding\n`);
          }
          done({ locations: [], error: 'LSP server exited before responding' });
        });
      })
      .catch(() => done({ locations: [], error: 'Failed to read source file' }));
  });
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
      serverCmd ?? ['typescript-language-server', '--stdio'],
      signal,
    );
    return formatSymbolResult(input.file_path, input.subcommand, input.line, input.col, result);
  } catch {
    return '[LSP] code_symbols: unexpected error';
  }
}
