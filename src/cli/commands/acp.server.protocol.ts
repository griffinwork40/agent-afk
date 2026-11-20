/**
 * ACP v1 JSON-RPC framing helpers: error codes, response factories, the
 * serialized NDJSON writer, inbound frame classification and prompt
 * normalization (profile §1, §3, §9).
 *
 * @module cli/commands/acp.server.protocol
 */

import type { Writable } from 'node:stream';
import type { RequestId, RpcFrame, RpcRequest, RpcResponse } from './acp.wire.js';

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const RESOURCE_NOT_FOUND = -32002;

/** Public messages per profile §9. Never include provider or path details. */
export const ERROR_MESSAGES: Readonly<Record<number, string>> = {
  [PARSE_ERROR]: 'Parse error',
  [INVALID_REQUEST]: 'Invalid request',
  [METHOD_NOT_FOUND]: 'Method not found',
  [INVALID_PARAMS]: 'Invalid params',
  [INTERNAL_ERROR]: 'Internal error',
  [RESOURCE_NOT_FOUND]: 'Resource not found',
};

/** Maximum inbound line size in bytes, excluding the newline (1 MiB). */
export const MAX_LINE_BYTES = 1_048_576;

/** Write one JSON frame as an NDJSON line, honouring backpressure. */
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

/** Serialize all protocol writes so frames never interleave. */
export function createSerialWriter(output: Writable): (frame: RpcFrame) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (frame) => {
    const next = chain.then(() => writeJson(output, frame));
    chain = next.catch(() => undefined);
    return next;
  };
}

export function successResponse(id: RequestId, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** Error response with the profile's generic public message for `code`. */
export function errorResponse(id: RequestId, code: number): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message: ERROR_MESSAGES[code] ?? 'Internal error' } };
}

export type InboundFrame =
  | { kind: 'request'; frame: RpcRequest }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'response'; frame: RpcResponse }
  | { kind: 'error'; response: RpcResponse };

function isId(v: unknown): v is string | number {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

/** Classify one non-empty inbound line (profile §1, §9). */
export function classifyLine(line: string): InboundFrame {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    return { kind: 'error', response: errorResponse(null, INVALID_REQUEST) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { kind: 'error', response: errorResponse(null, PARSE_ERROR) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'error', response: errorResponse(null, INVALID_REQUEST) };
  }
  const o = parsed as Record<string, unknown>;
  const id = o['id'];
  const usableId = isId(id) ? id : null;
  if (o['jsonrpc'] !== '2.0') {
    return { kind: 'error', response: errorResponse(usableId, INVALID_REQUEST) };
  }
  if (typeof o['method'] === 'string') {
    if (!('id' in o)) return { kind: 'notification', method: o['method'], params: o['params'] };
    if (usableId === null) return { kind: 'error', response: errorResponse(null, INVALID_REQUEST) };
    return { kind: 'request', frame: { jsonrpc: '2.0', id: usableId, method: o['method'], params: o['params'] } };
  }
  if ('method' in o) return { kind: 'error', response: errorResponse(usableId, INVALID_REQUEST) };
  if (usableId !== null && ('result' in o || 'error' in o)) {
    return { kind: 'response', frame: o as unknown as RpcResponse };
  }
  return { kind: 'error', response: errorResponse(usableId, INVALID_REQUEST) };
}

function blockText(b: unknown): string | null {
  if (typeof b !== 'object' || b === null) return null;
  const o = b as Record<string, unknown>;
  if (o['type'] === 'text') return typeof o['text'] === 'string' ? o['text'] : null;
  if (o['type'] === 'resource_link') {
    return typeof o['name'] === 'string' && typeof o['uri'] === 'string' ? `${o['name']} (${o['uri']})` : null;
  }
  if (o['type'] === 'resource') {
    const r = o['resource'];
    if (typeof r !== 'object' || r === null) return null;
    const res = r as Record<string, unknown>;
    if (typeof res['uri'] !== 'string') return null;
    if (typeof res['text'] === 'string') return `${res['uri']}\n${res['text']}`;
    if (typeof res['blob'] === 'string') return `${res['uri']} (binary resource omitted)`;
  }
  return null; // image, audio, unknown types and bad shapes
}

/**
 * Normalize a `session/prompt` content array to AFK text (profile §3).
 * Returns null when the prompt is invalid params.
 */
export function normalizePrompt(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  const parts: string[] = [];
  for (const b of raw) {
    const t = blockText(b);
    if (t === null) return null;
    parts.push(t);
  }
  return parts.join('\n');
}
