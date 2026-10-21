/**
 * Shared LSP wire-protocol helpers used by both `lsp-diagnostics.ts` (phase 1)
 * and `lsp-symbols.ts` (phase 2) of #3904.
 *
 * Extracted to eliminate cross-file duplication (jscpd clone gate) while keeping
 * both modules' public APIs unchanged.
 *
 * @module agent/tools/handlers/lsp-shared
 */

import type { ChildProcess } from 'node:child_process';
import { env } from '../../../config/env.js';

/** Encode a JSON-RPC message with LSP Content-Length framing. */
export function encodeMessage(obj: unknown): Buffer {
  const body = JSON.stringify(obj);
  const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from(body, 'utf8')]);
}

/** Kill a child process and close its stdin, ignoring errors. */
export function killProc(proc: ChildProcess): void {
  try { proc.stdin?.end(); } catch { /* ignore */ }
  try {
    // On win32, proc.kill() calls TerminateProcess on the direct child only.
    // On POSIX, SIGTERM to the direct child is sufficient.
    proc.kill();
  } catch { /* ignore */ }
}

/**
 * Parse all complete LSP messages from `buf`. Returns parsed JSON objects and
 * the remaining unparsed bytes.
 */
export function parseMessages(buf: Buffer): { messages: unknown[]; remaining: Buffer } {
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
 * Map file extension to LSP languageId (TS/JS family).
 * Returns undefined for unsupported extensions.
 */
export function languageIdForExt(ext: string): string | undefined {
  switch (ext) {
    case '.ts': return 'typescript';
    case '.tsx': return 'typescriptreact';
    case '.js': return 'javascript';
    case '.jsx': return 'javascriptreact';
    default: return undefined;
  }
}

/** Return the LSP diagnostics timeout from env, defaulting to 1500 ms. */
export function getTimeoutMs(): number {
  const raw = env.AFK_LSP_DIAGNOSTICS_TIMEOUT_MS;
  if (!raw) return 1500;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

/**
 * Return the LSP symbols timeout from env, defaulting to 5000 ms.
 *
 * Symbol queries (go-to-definition, find-references) may trigger a cold-start
 * project index build inside typescript-language-server. 5 s is a practical
 * budget for most repos; raise AFK_LSP_SYMBOLS_TIMEOUT_MS for large monorepos.
 */
export function getSymbolsTimeoutMs(): number {
  const raw = env.AFK_LSP_SYMBOLS_TIMEOUT_MS;
  if (!raw) return 5000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}
