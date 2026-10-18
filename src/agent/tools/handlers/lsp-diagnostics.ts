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
 *   - No persistent server process — each call spawns, queries, and exits.
 *     Lightweight for the opt-in / single-file phase; a persistent client is a
 *     follow-up when the feature proves valuable.
 *
 * LSP wire protocol (JSON-RPC 2.0 over stdio):
 *   Content-Length: <n>\r\n\r\n<json>
 *
 * Sequence:
 *   1. Send `initialize` request.
 *   2. Send `initialized` notification.
 *   3. Send `textDocument/didOpen` with the file content.
 *   4. Wait up to timeout for a `textDocument/publishDiagnostics` notification.
 *   5. Send `shutdown` request, then `exit` notification.
 *
 * @module agent/tools/handlers/lsp-diagnostics
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { env } from '../../../config/env.js';

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
 * Map file extension to LSP languageId.
 * Returns undefined for unsupported extensions (caller should skip LSP).
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
 * Return the configured timeout in milliseconds.
 * Reads AFK_LSP_DIAGNOSTICS_TIMEOUT_MS; defaults to 1500.
 *
 * Tradeoff: the default is intentionally low (1500 ms) because this runs
 * inline inside edit_file / write_file tool responses. A slow language server
 * adds perceived latency to every edit. The env var lets operators raise the
 * ceiling when their server is slow but the diagnostics are valuable enough
 * to wait for.
 */
function getTimeoutMs(): number {
  const raw = env.AFK_LSP_DIAGNOSTICS_TIMEOUT_MS;
  if (!raw) return 1500;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

/** Encode a JSON-RPC message with the LSP Content-Length framing. */
function encodeMessage(obj: unknown): Buffer {
  const body = JSON.stringify(obj);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from(body, 'utf8')]);
}

/** Kill a child process and close its stdin, ignoring errors. */
function killProc(proc: ChildProcess): void {
  try { proc.stdin?.end(); } catch { /* ignore */ }
  try {
    // Invariant: on win32, proc.kill() calls TerminateProcess on the direct
    // child only — child-of-child processes (e.g. a .cmd shim spawning node)
    // are orphaned.  Spawning with shell: true on win32 means the direct child
    // IS the shell; TerminateProcess on the shell tears down its child tree.
    // On POSIX, SIGTERM to the direct child is sufficient.
    proc.kill();
  } catch { /* ignore */ }
}

/**
 * Parse all complete LSP messages from `buf`. Returns parsed JSON objects and
 * the remaining unparsed bytes.
 */
function parseMessages(buf: Buffer): { messages: unknown[]; remaining: Buffer } {
  const messages: unknown[] = [];
  let offset = 0;

  while (offset < buf.length) {
    // Find end of headers: \r\n\r\n
    const headerEnd = buf.indexOf('\r\n\r\n', offset);
    if (headerEnd === -1) break;

    const headerSection = buf.subarray(offset, headerEnd).toString('utf8');
    const clMatch = headerSection.match(/Content-Length:\s*(\d+)/i);
    if (!clMatch || clMatch[1] === undefined) break;

    const contentLength = parseInt(clMatch[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;

    if (bodyEnd > buf.length) break; // incomplete — wait for more data

    const body = buf.subarray(bodyStart, bodyEnd).toString('utf8');
    try {
      messages.push(JSON.parse(body));
    } catch {
      // malformed — skip
    }
    offset = bodyEnd;
  }

  return { messages, remaining: buf.subarray(offset) };
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
  serverCmd: readonly string[] = ['typescript-language-server', '--stdio'],
): Promise<LspDiagnostic[]> {
  const timeoutMs = getTimeoutMs();
  const langId = languageIdForExt(path.extname(filePath));
  if (!langId) return []; // unsupported extension — skip

  // Invariant: `proc` is hoisted so that `done()` can kill it on every exit
  // path (timeout, error, close, diagnostics received). Without this, a
  // timed-out or errored query leaves an orphaned typescript-language-server.
  let proc: ChildProcess | null = null;

  return new Promise<LspDiagnostic[]>((resolve) => {
    let settled = false;
    const done = (result: LspDiagnostic[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc) killProc(proc);
      resolve(result);
    };

    // Hard timeout — never stall the edit.
    const timer = setTimeout(() => done([]), timeoutMs);
    timer.unref();

    let fileContent = '';

    // Read file content, then spawn server.
    readFile(filePath, 'utf8')
      .then((content) => {
        fileContent = content;
        if (settled) return;

        const [cmd, ...args] = serverCmd as [string, ...string[]];
        try {
          // Invariant: on win32 npm-installed binaries are .cmd shims that
          // spawn() cannot resolve without shell: true.  On POSIX shell is
          // unnecessary for direct executables, but harmless.
          proc = spawn(cmd, args, {
            stdio: ['pipe', 'pipe', 'ignore'],
            shell: process.platform === 'win32',
          });
        } catch {
          done([]);
          return;
        }

        proc.on('error', () => done([]));

        const uri = pathToFileURL(filePath).toString();
        let reqId = 0;
        const chunks: Buffer[] = [];

        const send = (msg: unknown) => {
          try {
            proc!.stdin!.write(encodeMessage(msg));
          } catch {
            // stdin closed — ignore
          }
        };

        // 1. Initialize
        send({
          jsonrpc: '2.0',
          id: ++reqId,
          method: 'initialize',
          params: {
            processId: process.pid,
            rootUri: null,
            capabilities: {},
          },
        });

        // 2. Initialized notification (sent after we receive the initialize result)
        // 3. didOpen (sent after initialized)
        // We send them together after a single read, relying on the server's
        // sequential processing. This avoids a round-trip wait per step.
        send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        send({
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri,
              languageId: langId,
              version: 1,
              text: fileContent,
            },
          },
        });

        proc.stdout!.on('data', (chunk: Buffer) => {
          if (settled) return;
          chunks.push(chunk);
          const buf = Buffer.from(Buffer.concat(chunks));
          const { messages, remaining } = parseMessages(buf);
          // Reset chunks to just the unparsed remainder.
          chunks.length = 0;
          chunks.push(remaining);

          for (const msg of messages) {
            if (
              typeof msg === 'object' &&
              msg !== null &&
              (msg as { method?: string }).method === 'textDocument/publishDiagnostics'
            ) {
              const params = (msg as { params?: { uri?: string; diagnostics?: unknown[] } }).params;
              if (!params || params.uri !== uri) continue;

              const raw = params.diagnostics ?? [];
              const diags: LspDiagnostic[] = [];
              for (const d of raw) {
                if (typeof d !== 'object' || d === null) continue;
                const dr = d as {
                  severity?: number;
                  message?: string;
                  range?: { start?: { line?: number; character?: number } };
                };
                diags.push({
                  severity: typeof dr.severity === 'number' ? dr.severity : 1,
                  message: typeof dr.message === 'string' ? dr.message : '',
                  line: (typeof dr.range?.start?.line === 'number' ? dr.range.start.line : 0) + 1,
                  col: (typeof dr.range?.start?.character === 'number' ? dr.range.start.character : 0) + 1,
                });
              }

              // Graceful shutdown — proc is killed by done() regardless,
              // but try a clean exit first.
              send({ jsonrpc: '2.0', id: ++reqId, method: 'shutdown', params: null });
              send({ jsonrpc: '2.0', method: 'exit', params: null });

              done(diags);
              return;
            }
          }
        });

        proc.on('close', () => done([]));
      })
      .catch(() => done([]));
  });
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
): Promise<string> {
  if (!isLspDiagnosticsEnabled()) return '';
  try {
    const diags = serverCmd !== undefined
      ? await queryLspDiagnostics(filePath, serverCmd)
      : await queryLspDiagnostics(filePath);
    return formatDiagnostics(filePath, diags);
  } catch {
    return '';
  }
}
