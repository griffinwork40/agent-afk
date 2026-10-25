/**
 * ACP JSON-RPC 2.0 wire-format helpers.
 *
 * Extracted from acp.server.ts to stay under the 350-line file ceiling.
 * Contains: type definitions, error-code constants, write helpers,
 * response factories, and the normalizePrompt utility.
 *
 * @module cli/commands/acp.server.protocol
 */

import type { Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** ACP notification frame (no `id` field — not a response). */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// Standard JSON-RPC 2.0 error codes
// ---------------------------------------------------------------------------

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// ACP update types
// ---------------------------------------------------------------------------

/** ACP update event types surfaced per OutputEvent. */
export type AcpUpdateType =
  | 'text_delta'
  | 'tool_start'
  | 'tool_end'
  | 'rate_limit'
  | 'done'
  | 'error';

export interface AcpUpdate {
  type: AcpUpdateType;
  delta?: string;
  toolName?: string;
  retryAfterMs?: number;
  sessionId?: string;
  costUsd?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Line-length guard
// ---------------------------------------------------------------------------

/** Maximum allowed request line size (1 MiB). */
export const MAX_LINE_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Write a JSON object as an NDJSON line.
 * Correctly removes both drain and error listeners when either fires,
 * preventing listener leaks under backpressure (fix #5).
 */
export function writeJson(output: Writable, obj: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const line = JSON.stringify(obj) + '\n';
    const ok = output.write(line, (err) => {
      if (err) reject(err);
      else if (ok) resolve();
    });
    if (!ok) {
      const cleanup = (): void => {
        output.removeListener('drain', onDrain);
        output.removeListener('error', onError);
      };
      const onDrain = (): void => { cleanup(); resolve(); };
      const onError = (err: Error): void => { cleanup(); reject(err); };
      output.once('drain', onDrain);
      output.once('error', onError);
    }
  });
}

// ---------------------------------------------------------------------------
// Response factories
// ---------------------------------------------------------------------------

export function successResponse(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

/** Build a JSON-RPC notification (no id — must not be a response). */
export function notificationFrame(method: string, params: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

// ---------------------------------------------------------------------------
// Prompt normalisation (fix #4)
// ---------------------------------------------------------------------------

/**
 * Accept `string | ContentBlock[]` as a prompt value.
 * Extracts text from text-type content blocks when an array is supplied.
 * Returns null when the result is empty (caller should reject).
 */
export function normalizePrompt(raw: unknown): string | null {
  if (typeof raw === 'string') return raw || null;
  if (Array.isArray(raw)) {
    const text = raw
      .filter(
        (b): b is { type: 'text'; text: string } =>
          typeof b === 'object' &&
          b !== null &&
          (b as Record<string, unknown>)['type'] === 'text' &&
          typeof (b as Record<string, unknown>)['text'] === 'string',
      )
      .map((b) => b.text)
      .join('');
    return text || null;
  }
  return null;
}
