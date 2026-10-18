/**
 * ACP JSON-RPC 2.0 stdio server implementation.
 *
 * Wire format: newline-delimited JSON (NDJSON) on stdin → NDJSON on stdout.
 *
 * Supported methods (ACP subset for this slice):
 *   initialize          — capability handshake; returns server info + capabilities
 *   session/new         — create a named session; returns { sessionId }
 *   session/prompt      — send a prompt; streams ACP updates, ends with done
 *   session/close       — tear down a session
 *
 * Each `session/prompt` call streams zero or more `{ id, result: { type:
 * "update", … } }` notifications followed by a final `{ id, result: { type:
 * "done", … } }` response frame.  Errors are returned as JSON-RPC error
 * objects.
 *
 * @module cli/commands/acp.server
 */

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AgentModelInput } from '../../agent/types.js';
import {
  buildAcpSession,
  closeAcpSession,
  type AcpSessionHandle,
} from './acp.session.js';

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

// Standard JSON-RPC 2.0 error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// ACP message helpers
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
// Server options
// ---------------------------------------------------------------------------

export interface AcpServerOptions {
  model: AgentModelInput;
  maxTurns: number;
  input: Readable;
  output: Writable;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface ServerState {
  initialized: boolean;
  sessions: Map<string, AcpSessionHandle>;
  nextSessionNum: number;
  opts: AcpServerOptions;
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

function writeJson(output: Writable, obj: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const line = JSON.stringify(obj) + '\n';
    const ok = output.write(line, (err) => {
      if (err) reject(err);
      else if (ok) resolve();
    });
    if (!ok) {
      const onDrain = (): void => {
        output.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        output.removeListener('drain', onDrain);
        reject(err);
      };
      output.once('drain', onDrain);
      output.once('error', onError);
    }
  });
}

function successResponse(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

async function handleInitialize(
  state: ServerState,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  state.initialized = true;
  return successResponse(req.id, {
    serverInfo: { name: 'afk', version: 'acp/1.0' },
    capabilities: {
      methods: ['initialize', 'session/new', 'session/prompt', 'session/close'],
      streaming: true,
    },
  });
}

async function handleSessionNew(
  state: ServerState,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  if (!state.initialized) {
    return errorResponse(req.id, INVALID_REQUEST, 'Server not initialized — call initialize first');
  }
  const sessionId = `acp-${Date.now()}-${state.nextSessionNum++}`;
  const handle = await buildAcpSession({
    model: state.opts.model,
    maxTurns: state.opts.maxTurns,
  });
  state.sessions.set(sessionId, handle);
  return successResponse(req.id, { sessionId });
}

/**
 * Stream a prompt through the session.
 *
 * Emits zero or more intermediate `{ id, result: { type: "update", update } }`
 * frames via `output`, then a final `{ id, result: { type: "done", … } }`.
 * On error, emits a JSON-RPC error response and leaves the session open so
 * the client can retry.
 */
async function handleSessionPrompt(
  state: ServerState,
  req: JsonRpcRequest,
): Promise<void> {
  if (!state.initialized) {
    await writeJson(
      state.opts.output,
      errorResponse(req.id, INVALID_REQUEST, 'Server not initialized — call initialize first'),
    );
    return;
  }

  const params = req.params as { sessionId?: string; prompt?: string } | undefined;
  const sessionId = params?.sessionId;
  const prompt = params?.prompt;

  if (typeof sessionId !== 'string' || !sessionId) {
    await writeJson(
      state.opts.output,
      errorResponse(req.id, INVALID_PARAMS, 'params.sessionId must be a non-empty string'),
    );
    return;
  }
  if (typeof prompt !== 'string' || !prompt) {
    await writeJson(
      state.opts.output,
      errorResponse(req.id, INVALID_PARAMS, 'params.prompt must be a non-empty string'),
    );
    return;
  }

  const handle = state.sessions.get(sessionId);
  if (!handle) {
    await writeJson(
      state.opts.output,
      errorResponse(req.id, INVALID_PARAMS, `Unknown sessionId: ${sessionId}`),
    );
    return;
  }

  try {
    const stream = handle.session.sendMessageStream(prompt);
    let assistantText = '';
    let finalCost: number | undefined;
    let finalSessionId: string | undefined;

    for await (const event of stream) {
      if (event.type === 'chunk' && event.chunk.type === 'content') {
        const delta = (event.chunk as { type: 'content'; content: string }).content;
        assistantText += delta;
        const update: AcpUpdate = { type: 'text_delta', delta };
        await writeJson(state.opts.output, successResponse(req.id, { type: 'update', update }));
      } else if (event.type === 'progress') {
        // Tool use start/end surfaced as ACP tool events
        const prog = event.progress as { phase?: string; toolName?: string };
        if (prog.phase === 'tool_start' && prog.toolName) {
          const update: AcpUpdate = { type: 'tool_start', toolName: prog.toolName };
          await writeJson(state.opts.output, successResponse(req.id, { type: 'update', update }));
        } else if (prog.phase === 'tool_end' && prog.toolName) {
          const update: AcpUpdate = { type: 'tool_end', toolName: prog.toolName };
          await writeJson(state.opts.output, successResponse(req.id, { type: 'update', update }));
        }
      } else if (event.type === 'rate_limit') {
        const update: AcpUpdate = {
          type: 'rate_limit',
          retryAfterMs: event.retryAfterMs,
        };
        await writeJson(state.opts.output, successResponse(req.id, { type: 'update', update }));
      } else if (event.type === 'done') {
        const rawCost = event.metadata?.['costUsd'];
        finalCost = typeof rawCost === 'number' ? rawCost : undefined;
        finalSessionId = event.metadata?.sessionId !== undefined
          ? String(event.metadata.sessionId)
          : undefined;
      } else if (event.type === 'error') {
        const update: AcpUpdate = { type: 'error', error: event.error.message };
        await writeJson(state.opts.output, errorResponse(
          req.id,
          INTERNAL_ERROR,
          event.error.message,
          { update },
        ));
        return;
      }
    }

    // Final done frame
    const doneUpdate: AcpUpdate = {
      type: 'done',
      ...(finalSessionId !== undefined ? { sessionId: finalSessionId } : {}),
      ...(finalCost !== undefined ? { costUsd: finalCost } : {}),
    };
    await writeJson(
      state.opts.output,
      successResponse(req.id, { type: 'done', update: doneUpdate, text: assistantText }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeJson(
      state.opts.output,
      errorResponse(req.id, INTERNAL_ERROR, msg),
    );
  }
}

async function handleSessionClose(
  state: ServerState,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const params = req.params as { sessionId?: string } | undefined;
  const sessionId = params?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) {
    return errorResponse(req.id, INVALID_PARAMS, 'params.sessionId must be a non-empty string');
  }
  const handle = state.sessions.get(sessionId);
  if (!handle) {
    return errorResponse(req.id, INVALID_PARAMS, `Unknown sessionId: ${sessionId}`);
  }
  state.sessions.delete(sessionId);
  await closeAcpSession(handle);
  return successResponse(req.id, { closed: true });
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch one parsed request.  Returns a response object for all methods
 * EXCEPT `session/prompt`, which writes its own frames and returns undefined.
 */
async function dispatchRequest(
  state: ServerState,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse | undefined> {
  switch (req.method) {
    case 'initialize':
      return handleInitialize(state, req);
    case 'session/new':
      return handleSessionNew(state, req);
    case 'session/prompt':
      // Streaming: writes its own frames, returns nothing
      await handleSessionPrompt(state, req);
      return undefined;
    case 'session/close':
      return handleSessionClose(state, req);
    default:
      return errorResponse(req.id, METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}

// ---------------------------------------------------------------------------
// Main server loop
// ---------------------------------------------------------------------------

/**
 * Run the ACP stdio server.
 *
 * Reads NDJSON from `options.input`, writes NDJSON to `options.output`.
 * Resolves when the input stream ends (client disconnected).
 */
export async function runAcpServer(options: AcpServerOptions): Promise<void> {
  const state: ServerState = {
    initialized: false,
    sessions: new Map(),
    nextSessionNum: 0,
    opts: options,
  };

  const rl = createInterface({ input: options.input, crlfDelay: Infinity });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: JsonRpcRequest;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as Record<string, unknown>)['jsonrpc'] !== '2.0' ||
        typeof (parsed as Record<string, unknown>)['method'] !== 'string'
      ) {
        await writeJson(
          options.output,
          errorResponse(
            typeof (parsed as Record<string, unknown>)?.['id'] === 'string' ||
            typeof (parsed as Record<string, unknown>)?.['id'] === 'number'
              ? (parsed as Record<string, unknown>)['id'] as string | number
              : null,
            INVALID_REQUEST,
            'Invalid JSON-RPC 2.0 request',
          ),
        );
        continue;
      }
      req = parsed as JsonRpcRequest;
    } catch {
      await writeJson(options.output, errorResponse(null, PARSE_ERROR, 'Parse error'));
      continue;
    }

    try {
      const response = await dispatchRequest(state, req);
      if (response !== undefined) {
        await writeJson(options.output, response);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await writeJson(options.output, errorResponse(req.id, INTERNAL_ERROR, msg));
    }
  }

  // Clean up all open sessions on disconnect
  for (const [, handle] of state.sessions) {
    try {
      await closeAcpSession(handle);
    } catch {
      // best-effort
    }
  }
}
