/**
 * Shared helpers used by both `lsp-diagnostics.ts` (phase 1) and
 * `lsp-symbols.ts` (phase 2) of #3904: env timeouts and pooled-query error
 * mapping. The wire protocol itself lives in `agent/lsp/client.ts` (#4272).
 *
 * @module agent/tools/handlers/lsp-shared
 */

import { readFile } from 'node:fs/promises';
import { env } from '../../../config/env.js';
import { LspClientError } from '../../lsp/client.js';

/**
 * Map a pooled-query failure to the handler-facing error string. Unknown
 * errors (never expected) degrade to the generic server-error message.
 */
export function lspFailureMessage(err: unknown, timeoutMessage: string): string {
  if (!(err instanceof LspClientError)) return 'LSP server returned an error';
  switch (err.kind) {
    case 'timeout': return timeoutMessage;
    case 'aborted': return 'Aborted';
    case 'spawn': return 'Failed to spawn LSP server';
    case 'exited': return 'LSP server exited before responding';
    case 'response': return err.message === 'Unsupported file type' ? err.message : 'LSP server returned an error';
  }
}

/** Abort the I/O where supported AND race it: a stalled OS open may ignore abort. */
export async function readLspSource(filePath: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new LspClientError('aborted', 'Aborted');
  if (timeoutMs <= 0) throw new LspClientError('timeout', 'LSP source read timed out');
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    const fail = (kind: 'timeout' | 'aborted') => {
      reject(new LspClientError(kind, kind === 'aborted' ? 'Aborted' : 'LSP source read timed out'));
      controller.abort();
    };
    timer = setTimeout(() => fail('timeout'), timeoutMs);
    onAbort = () => fail('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([readFile(filePath, { encoding: 'utf8', signal: controller.signal }), guard]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
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
