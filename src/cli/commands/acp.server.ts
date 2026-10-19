/**
 * ACP JSON-RPC 2.0 stdio server implementation.
 *
 * Wire format: newline-delimited JSON (NDJSON) on stdin → NDJSON on stdout.
 *
 * Supported methods:
 *   initialize          — capability handshake
 *   session/new         — create a session; returns { sessionId }
 *   session/prompt      — stream a prompt; intermediate frames are notifications
 *   session/close       — tear down a session
 *   session/cancel      — abort a running prompt
 *
 * @module cli/commands/acp.server
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { AgentModelInput } from '../../agent/types.js';
import {
  buildAcpSession,
  closeAcpSession,
  type AcpSessionHandle,
} from './acp.session.js';
import {
  writeJson,
  successResponse,
  errorResponse,
  notificationFrame,
  normalizePrompt,
  MAX_LINE_BYTES,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type AcpUpdate,
} from './acp.server.protocol.js';

// Re-export types the test file imports from this module
export type { JsonRpcRequest, JsonRpcResponse } from './acp.server.protocol.js';
export { writeJson, successResponse, errorResponse } from './acp.server.protocol.js';

// ---------------------------------------------------------------------------
// Server options
// ---------------------------------------------------------------------------

export interface AcpServerOptions {
  model: AgentModelInput;
  maxTurns: number;
  input: Readable;
  output: Writable;
  /** When true, sessions run in bypassPermissions mode (fix #1). */
  dangerouslySkipPermissions?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Invariant: cwd must be an absolute path that (a) exists as a directory and
 * (b) is rooted at process.cwd() — prevents path-traversal from a malicious
 * client supplying e.g. '/etc' or '../../..'.
 *
 * Returns the resolved absolute path on success, or a string error message
 * on failure (caller converts to INVALID_PARAMS).
 */
function validateCwd(raw: string): string | Error {
  const resolved = path.resolve(raw);
  if (!existsSync(resolved)) {
    return new Error(`cwd does not exist: ${resolved}`);
  }
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return new Error(`cwd is not accessible: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    return new Error(`cwd is not a directory: ${resolved}`);
  }
  const serverCwd = process.cwd();
  // Allow exactly process.cwd() or any strict subdirectory.
  if (resolved !== serverCwd && !resolved.startsWith(serverCwd + path.sep)) {
    return new Error(`cwd is outside server working directory: ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface SessionEntry {
  handle: AcpSessionHandle;
  abort: AbortController;
}

interface ServerState {
  initialized: boolean;
  sessions: Map<string, SessionEntry>;
  opts: AcpServerOptions;
}

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

async function handleInitialize(
  state: ServerState,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  state.initialized = true;
  // Fix #3: include protocolVersion and agentCapabilities
  return successResponse(req.id, {
    protocolVersion: '1.0',
    agentCapabilities: {
      streaming: true,
      methods: ['initialize', 'session/new', 'session/prompt', 'session/close', 'session/cancel'],
    },
    serverInfo: { name: 'afk', version: 'acp/1.0' },
  });
}

async function handleSessionNew(
  state: ServerState,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  if (!state.initialized) {
    return errorResponse(req.id, INVALID_REQUEST, 'Server not initialized — call initialize first');
  }
  // Fix non-blocking extra: use crypto.randomUUID()
  const sessionId = randomUUID();
  const params = req.params as { cwd?: string } | undefined;
  let validatedCwd: string | undefined;
  if (params?.cwd !== undefined) {
    const cwdResult = validateCwd(params.cwd);
    if (cwdResult instanceof Error) {
      return errorResponse(req.id, INVALID_PARAMS, cwdResult.message);
    }
    validatedCwd = cwdResult;
  }
  const handle = await buildAcpSession({
    model: state.opts.model,
    maxTurns: state.opts.maxTurns,
    dangerouslySkipPermissions: state.opts.dangerouslySkipPermissions,
    cwd: validatedCwd,
  });
  const abort = new AbortController();
  state.sessions.set(sessionId, { handle, abort });
  return successResponse(req.id, { sessionId });
}

/**
 * Stream a prompt through the session.
 *
 * Fix #2: Intermediate frames are JSON-RPC notifications (method: session/update,
 * no id). Only the final done frame is a response with the request id.
 * Fix #6: Internal errors are not leaked to the client.
 * Fix #8: AbortController stored per session; signal passed to stream.
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

  const params = req.params as { sessionId?: string; prompt?: unknown } | undefined;
  const sessionId = params?.sessionId;
  // Fix #4: accept string | ContentBlock[]
  const prompt = normalizePrompt(params?.prompt);

  if (typeof sessionId !== 'string' || !sessionId) {
    await writeJson(
      state.opts.output,
      errorResponse(req.id, INVALID_PARAMS, 'params.sessionId must be a non-empty string'),
    );
    return;
  }
  if (!prompt) {
    await writeJson(
      state.opts.output,
      errorResponse(req.id, INVALID_PARAMS, 'params.prompt must be a non-empty string'),
    );
    return;
  }

  const entry = state.sessions.get(sessionId);
  if (!entry) {
    await writeJson(
      state.opts.output,
      errorResponse(req.id, INVALID_PARAMS, `Unknown sessionId: ${sessionId}`),
    );
    return;
  }

  try {
    const stream = entry.handle.session.sendMessageStream(prompt);
    let assistantText = '';
    let finalCost: number | undefined;
    let finalSessionId: string | undefined;

    for await (const event of stream) {
      // Fix #8: honour abort signal
      if (entry.abort.signal.aborted) break;

      if (event.type === 'chunk' && event.chunk.type === 'content') {
        const delta = (event.chunk as { type: 'content'; content: string }).content;
        assistantText += delta;
        const update: AcpUpdate = { type: 'text_delta', delta };
        // Fix #2: intermediate frame is a notification, not a response
        await writeJson(
          state.opts.output,
          notificationFrame('session/update', { type: 'update', update, sessionId }),
        );
      } else if (event.type === 'progress') {
        const prog = event.progress as { phase?: string; toolName?: string };
        if (prog.phase === 'tool_start' && prog.toolName) {
          const update: AcpUpdate = { type: 'tool_start', toolName: prog.toolName };
          await writeJson(
            state.opts.output,
            notificationFrame('session/update', { type: 'update', update, sessionId }),
          );
        } else if (prog.phase === 'tool_end' && prog.toolName) {
          const update: AcpUpdate = { type: 'tool_end', toolName: prog.toolName };
          await writeJson(
            state.opts.output,
            notificationFrame('session/update', { type: 'update', update, sessionId }),
          );
        }
      } else if (event.type === 'rate_limit') {
        const update: AcpUpdate = { type: 'rate_limit', retryAfterMs: event.retryAfterMs };
        await writeJson(
          state.opts.output,
          notificationFrame('session/update', { type: 'update', update, sessionId }),
        );
      } else if (event.type === 'done') {
        const rawCost = event.metadata?.['costUsd'];
        finalCost = typeof rawCost === 'number' ? rawCost : undefined;
        finalSessionId = event.metadata?.sessionId !== undefined
          ? String(event.metadata.sessionId)
          : undefined;
      } else if (event.type === 'error') {
        // H2: remove errored session so subsequent prompts don't hit a dead handle
        state.sessions.delete(sessionId);
        // Fix #6: don't forward internal error message
        const safeMsg = 'Internal server error';
        process.stderr.write(`[acp] ${event.error.stack ?? event.error.message}\n`);
        await writeJson(
          state.opts.output,
          errorResponse(req.id, INTERNAL_ERROR, safeMsg),
        );
        return;
      }
    }

    // H1: if the loop exited due to abort, send a cancellation error instead of done
    if (entry.abort.signal.aborted) {
      await writeJson(
        state.opts.output,
        errorResponse(req.id, -32001, 'Cancelled'),
      );
      return;
    }

    // Final done frame — only this carries the request id (fix #2)
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
    // H2: remove session on unexpected error so the handle isn't reused
    state.sessions.delete(sessionId);
    // H3: guard writeJson against a broken pipe so the throw doesn't escape
    // Fix #6: log full error, send generic message to client
    if (err instanceof Error) process.stderr.write(`[acp] ${err.stack ?? err.message}\n`);
    try {
      await writeJson(state.opts.output, errorResponse(req.id, INTERNAL_ERROR, 'Internal server error'));
    } catch {
      // output is closed; nothing more to do
    }
  }
}

/**
 * Resolve a session entry from params.sessionId, returning either the entry or
 * a ready-to-send error response. Extracted to eliminate the duplicated
 * lookup prologue shared by handleSessionClose and handleSessionCancel.
 */
function resolveSessionEntry(
  state: ServerState,
  req: JsonRpcRequest,
): SessionEntry | JsonRpcResponse {
  const params = req.params as { sessionId?: string } | undefined;
  const sessionId = params?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) {
    return errorResponse(req.id, INVALID_PARAMS, 'params.sessionId must be a non-empty string');
  }
  const entry = state.sessions.get(sessionId);
  if (!entry) {
    return errorResponse(req.id, INVALID_PARAMS, `Unknown sessionId: ${sessionId}`);
  }
  return entry;
}

async function handleSessionClose(
  state: ServerState,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const result = resolveSessionEntry(state, req);
  if (!('handle' in result)) return result;
  const params = req.params as { sessionId: string };
  state.sessions.delete(params.sessionId);
  await closeAcpSession(result.handle);
  return successResponse(req.id, { closed: true });
}

// Fix #8: session/cancel handler
async function handleSessionCancel(
  state: ServerState,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const result = resolveSessionEntry(state, req);
  if (!('handle' in result)) return result;
  result.abort.abort();
  result.handle.session.abort('acp-cancel');
  return successResponse(req.id, { cancelled: true });
}

// ---------------------------------------------------------------------------
// Request dispatcher
// ---------------------------------------------------------------------------

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
      // Streaming: writes its own frames — caller handles fire-and-forget
      await handleSessionPrompt(state, req);
      return undefined;
    case 'session/close':
      return handleSessionClose(state, req);
    case 'session/cancel':
      return handleSessionCancel(state, req);
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
 *
 * Fix #7: enforces MAX_LINE_BYTES before JSON.parse.
 * Fix #8: session/prompt is dispatched without await so cancel can be read
 *         concurrently; pending promises are awaited on shutdown.
 */
export async function runAcpServer(options: AcpServerOptions): Promise<void> {
  const state: ServerState = {
    initialized: false,
    sessions: new Map(),
    opts: options,
  };

  const rl = createInterface({ input: options.input, crlfDelay: Infinity });

  // Fix #8: track in-flight prompt promises so we can await them on shutdown
  const pendingPrompts = new Set<Promise<void>>();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Fix #7: reject oversized lines before parsing
    if (Buffer.byteLength(trimmed) > MAX_LINE_BYTES) {
      await writeJson(options.output, errorResponse(null, PARSE_ERROR, 'Request too large'));
      continue;
    }

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

    // Fix #8: fire-and-forget session/prompt so cancel can be read concurrently
    if (req.method === 'session/prompt') {
      const p = handleSessionPrompt(state, req).finally(() => { pendingPrompts.delete(p); });
      pendingPrompts.add(p);
      continue;
    }

    try {
      const response = await dispatchRequest(state, req);
      if (response !== undefined) {
        await writeJson(options.output, response);
      }
    } catch (err) {
      // Fix #6: log full error, send generic message
      const safeMsg = 'Internal server error';
      if (err instanceof Error) process.stderr.write(`[acp] ${err.stack ?? err.message}\n`);
      await writeJson(options.output, errorResponse(req.id, INTERNAL_ERROR, safeMsg));
    }
  }

  // Wait for any in-flight prompts to finish
  if (pendingPrompts.size > 0) {
    await Promise.allSettled([...pendingPrompts]);
  }

  // Clean up all open sessions on disconnect
  for (const [, entry] of state.sessions) {
    try {
      await closeAcpSession(entry.handle);
    } catch {
      // best-effort
    }
  }
}
