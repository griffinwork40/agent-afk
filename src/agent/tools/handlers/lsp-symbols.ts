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
 * @module agent/tools/handlers/lsp-symbols
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { env } from '../../../config/env.js';

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

// ── Internal helpers (mirrors lsp-diagnostics.ts) ────────────────────────────

/** Encode a JSON-RPC message with LSP Content-Length framing. */
function encodeMessage(obj: unknown): Buffer {
  const body = JSON.stringify(obj);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from(body, 'utf8')]);
}

/** Kill a child process and close its stdin, ignoring errors. */
function killProc(proc: ChildProcess): void {
  try { proc.stdin?.end(); } catch { /* ignore */ }
  try {
    // On win32, proc.kill() calls TerminateProcess on the direct child only.
    // On POSIX, SIGTERM to the direct child is sufficient.
    proc.kill();
  } catch { /* ignore */ }
}

/**
 * Parse all complete LSP messages from `buf`. Returns parsed JSON objects and
 * the remaining unparsed bytes. Identical algorithm to lsp-diagnostics.ts.
 */
function parseMessages(buf: Buffer): { messages: unknown[]; remaining: Buffer } {
  const messages: unknown[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const headerEnd = buf.indexOf('\r\n\r\n', offset);
    if (headerEnd === -1) break;
    const headerSection = buf.subarray(offset, headerEnd).toString('utf8');
    const clMatch = headerSection.match(/Content-Length:\s*(\d+)/i);
    if (!clMatch || clMatch[1] === undefined) break;
    const contentLength = parseInt(clMatch[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (bodyEnd > buf.length) break;
    const body = buf.subarray(bodyStart, bodyEnd).toString('utf8');
    try { messages.push(JSON.parse(body)); } catch { /* malformed — skip */ }
    offset = bodyEnd;
  }
  return { messages, remaining: buf.subarray(offset) };
}

/**
 * Map file extension to LSP languageId (same set as phase 1).
 * Returns undefined for unsupported extensions.
 */
function languageIdForExt(ext: string): string | undefined {
  switch (ext) {
    case '.ts': return 'typescript';
    case '.tsx': return 'typescriptreact';
    case '.js': return 'javascript';
    case '.jsx': return 'javascriptreact';
    default: return undefined;
  }
}

/** Parse an LSP Location or LocationLink into an LspLocation. */
function parseLocation(raw: unknown): LspLocation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  // LSP Location: { uri, range: { start: { line, character } } }
  const loc = raw as {
    uri?: string;
    range?: { start?: { line?: number; character?: number } };
    targetUri?: string;
    targetRange?: { start?: { line?: number; character?: number } };
  };
  const uri = loc.targetUri ?? loc.uri;
  const range = loc.targetRange ?? loc.range;
  if (typeof uri !== 'string') return null;
  let filePath: string;
  try { filePath = fileURLToPath(uri); } catch { return null; }
  const line = (typeof range?.start?.line === 'number' ? range.start.line : 0) + 1;
  const col = (typeof range?.start?.character === 'number' ? range.start.character : 0) + 1;
  return { filePath, line, col };
}

// ── Timeout helper ────────────────────────────────────────────────────────────

function getTimeoutMs(): number {
  const raw = env.AFK_LSP_DIAGNOSTICS_TIMEOUT_MS;
  if (!raw) return 1500;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1500;
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
 * @param serverCmd  - LSP server binary + args (injectable for tests).
 */
export async function queryLspSymbol(
  filePath: string,
  subcommand: SymbolSubcommand,
  line: number,
  col: number,
  serverCmd: readonly string[] = ['typescript-language-server', '--stdio'],
): Promise<LspSymbolResult> {
  const timeoutMs = getTimeoutMs();
  const langId = languageIdForExt(path.extname(filePath));
  if (!langId) {
    return { locations: [], error: `Unsupported file type: ${path.extname(filePath)}` };
  }

  // Invariant: proc is hoisted so done() can kill it on every exit path.
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

    const timer = setTimeout(() => done({ locations: [], error: 'LSP server timed out' }), timeoutMs);
    timer.unref();

    readFile(filePath, 'utf8')
      .then((fileContent) => {
        if (settled) return;

        const [cmd, ...args] = serverCmd as [string, ...string[]];
        try {
          proc = spawn(cmd, args, {
            stdio: ['pipe', 'pipe', 'ignore'],
            shell: process.platform === 'win32',
          });
        } catch {
          done({ locations: [], error: 'Failed to spawn LSP server' });
          return;
        }

        proc.on('error', () => done({ locations: [], error: 'LSP server process error' }));

        const uri = pathToFileURL(filePath).toString();
        let reqId = 0;
        const chunks: Buffer[] = [];

        const send = (msg: unknown) => {
          try { proc!.stdin!.write(encodeMessage(msg)); } catch { /* stdin closed */ }
        };

        // 1. Initialize
        send({
          jsonrpc: '2.0',
          id: ++reqId,
          method: 'initialize',
          params: { processId: process.pid, rootUri: null, capabilities: {} },
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
          params['context'] = { includeDeclaration: true };
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
              // Single Location (definition can return one object, not array)
              const loc = parseLocation(raw);
              if (loc) locations.push(loc);
            }

            done({ locations });
            return;
          }
        });

        proc.on('close', () => done({ locations: [], error: 'LSP server exited before responding' }));
      })
      .catch(() => done({ locations: [], error: 'Failed to read source file' }));
  });
}

/**
 * Format an LspSymbolResult for display as a tool result string.
 *
 * Example:
 *   [LSP] definition for symbol at foo.ts:5:3 → 1 location(s):
 *     src/bar.ts:12:1
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
 * Returns a formatted result string. When the feature is disabled, returns a
 * user-friendly message. Never throws.
 */
export async function handleCodeSymbols(
  input: {
    file_path: string;
    subcommand: SymbolSubcommand;
    line: number;
    col: number;
  },
  serverCmd?: readonly string[],
): Promise<string> {
  if (!isLspSymbolsEnabled()) {
    return (
      'code_symbols requires AFK_LSP_DIAGNOSTICS=1 and typescript-language-server on PATH. ' +
      'Set AFK_LSP_DIAGNOSTICS=1 to enable the LSP surface.'
    );
  }
  try {
    const result = serverCmd !== undefined
      ? await queryLspSymbol(input.file_path, input.subcommand, input.line, input.col, serverCmd)
      : await queryLspSymbol(input.file_path, input.subcommand, input.line, input.col);
    return formatSymbolResult(input.file_path, input.subcommand, input.line, input.col, result);
  } catch {
    return '[LSP] code_symbols: unexpected error';
  }
}
