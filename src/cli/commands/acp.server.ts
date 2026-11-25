/**
 * ACP v1 JSON-RPC 2.0 stdio server (Agent Client Protocol, version 1).
 *
 * Transport and dispatch only; method semantics live in acp.handlers.ts and
 * the prompt turn in acp.prompt-turn.ts. Stdout carries protocol frames only;
 * diagnostics go to stderr. See docs/acp-profile.md for the contract.
 *
 * @module cli/commands/acp.server
 */

import type { Readable, Writable } from 'node:stream';
import type { AgentModelInput } from '../../agent/types.js';
import { createAcpRpcPeer } from './acp.rpc-peer.js';
import { readLines } from './acp.lines.js';
import { installAcpConsoleRedirect } from './acp.server.console.js';
import {
  AcpError, handleCancel, handleClose, handleInitialize, handleRestore, handleSessionNew,
  releaseSession, startPrompt, type ServerContext,
} from './acp.handlers.js';
import { cancelTurn } from './acp.prompt-turn.js';
import { withDeadline } from './acp.session.resources.js';
import {
  INTERNAL_ERROR, INVALID_REQUEST, MAX_LINE_BYTES, METHOD_NOT_FOUND, PARSE_ERROR,
  classifyLine, createSerialWriter, errorResponse, successResponse,
} from './acp.server.protocol.js';
import type { RpcFrame, RpcRequest } from './acp.wire.js';

export interface AcpServerOptions {
  model: AgentModelInput;
  maxTurns: number;
  input: Readable;
  output: Writable;
  /** Diagnostics sink; defaults to stderr. Never stdout. */
  log?: (line: string) => void;
  /** How long a cancelled turn keeps draining queued updates (ms). */
  cancelGraceMs?: number;
  /** D17: bound on EOF teardown per phase (in-flight replies, then session close); tests shorten it. */
  shutdownDeadlineMs?: number;
}

/**
 * D17: generous next to a normal close (tens of ms) so the journal close and
 * trace seal inside AgentSession.close() finish; a close still running at the
 * deadline is abandoned, and the trace writer's exit backstop seals its trace.
 */
export const SHUTDOWN_DEADLINE_MS = 10_000;

function toErrorFrame(ctx: ServerContext, id: RpcRequest['id'], err: unknown): RpcFrame {
  if (err instanceof AcpError) {
    if (err.detail) ctx.log(`[acp] request ${String(id)} failed: ${err.detail}`);
    return errorResponse(id, err.code, err.data);
  }
  ctx.log(`[acp] request ${String(id)} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return errorResponse(id, INTERNAL_ERROR);
}

async function dispatch(ctx: ServerContext, req: RpcRequest): Promise<unknown> {
  switch (req.method) {
    case 'initialize': return handleInitialize(ctx, req.params);
    case 'session/new': return handleSessionNew(ctx, req.params);
    case 'session/load': return handleRestore(ctx, req.params, 'load');
    case 'session/resume': return handleRestore(ctx, req.params, 'resume');
    case 'session/close': return handleClose(ctx, req.params);
    default: throw new AcpError(METHOD_NOT_FOUND, `unknown method ${req.method}`);
  }
}

/**
 * Run the ACP stdio server. Resolves when input ends; on EOF every pending
 * outbound request is rejected and every live session is cancelled/released.
 */
export async function runAcpServer(options: AcpServerOptions): Promise<void> {
  const restoreConsole = installAcpConsoleRedirect();
  try { await runConnection(options); }
  finally { restoreConsole(); }
}

async function runConnection(options: AcpServerOptions): Promise<void> {
  const log = options.log ?? ((line: string) => { process.stderr.write(line.endsWith('\n') ? line : `${line}\n`); });
  let outputBroken = false;
  const onOutputError = (): void => {
    outputBroken = true;
    // Wake the pending input read; the finally block owns the same bounded teardown as EOF.
    options.input.destroy();
  };
  const rawWrite = createSerialWriter(options.output, () => !outputBroken);
  const write = async (frame: RpcFrame): Promise<void> => {
    if (outputBroken) return;
    try { await rawWrite(frame); }
    catch { onOutputError(); }
  };
  const peer = createAcpRpcPeer({ write });
  const ctx: ServerContext = {
    opts: {
      model: options.model, maxTurns: options.maxTurns,
      ...(options.cancelGraceMs !== undefined ? { cancelGraceMs: options.cancelGraceMs } : {}),
    },
    peer, initialized: false,
    sessions: new Map(), restoring: new Set(), promptWrites: new Map(), log,
  };
  const inflight = new Set<Promise<void>>();
  const track = (p: Promise<void>): void => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };
  const send = (frame: RpcFrame): Promise<void> =>
    write(frame).catch((err: unknown) => log(`[acp] write failed: ${String(err)}`));

  const handleRequest = (req: RpcRequest): void => {
    if (req.method === 'session/prompt') {
      let turn: Promise<unknown>;
      try {
        turn = startPrompt(ctx, req.params);
      } catch (err) {
        track(send(toErrorFrame(ctx, req.id, err)));
        return;
      }
      const sessionId = (req.params as { sessionId: string }).sessionId;
      const written = turn.then(
        (result) => send(successResponse(req.id, result)),
        (err: unknown) => send(toErrorFrame(ctx, req.id, err)),
      );
      ctx.promptWrites.set(sessionId, written);
      void written.finally(() => {
        if (ctx.promptWrites.get(sessionId) === written) ctx.promptWrites.delete(sessionId);
      });
      track(written);
      return;
    }
    track(dispatch(ctx, req).then(
      (result) => send(successResponse(req.id, result)),
      (err: unknown) => send(toErrorFrame(ctx, req.id, err)),
    ));
  };

  options.output.on('error', onOutputError);
  try {
    for await (const line of readLines(options.input, MAX_LINE_BYTES)) {
      if (outputBroken) break;
      if (line.kind === 'oversize') { track(send(errorResponse(null, INVALID_REQUEST))); continue; }
      if (line.kind === 'bad-utf8') { track(send(errorResponse(null, PARSE_ERROR))); continue; }
      const text = line.text.trim();
      if (!text) continue;
      const frame = classifyLine(text);
      switch (frame.kind) {
        case 'error': track(send(frame.response)); break;
        case 'response':
          if (!peer.handleResponse(frame.frame)) log(`[acp] ignored response for unknown id ${String(frame.frame.id)}`);
          break;
        case 'notification':
          if (frame.method === 'session/cancel') handleCancel(ctx, frame.params);
          else log(`[acp] ignored notification ${frame.method}`);
          break;
        case 'request': handleRequest(frame.frame); break;
      }
    }
  } catch (err) {
    if (!outputBroken) throw err;
  } finally {
    try { await shutdown(ctx, inflight, options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS); }
    finally { options.output.removeListener('error', onOutputError); }
  }
}

/**
 * EOF: reject pending peer requests, cancel turns, then release every session
 * concurrently (D17). Each phase is bounded; nothing here holds the loop open.
 */
async function shutdown(ctx: ServerContext, inflight: Set<Promise<void>>, deadlineMs: number): Promise<void> {
  ctx.peer.close('input closed');
  for (const live of ctx.sessions.values()) cancelTurn(live, ctx.log);
  if (await withDeadline(() => Promise.allSettled([...inflight]), deadlineMs) === 'timeout') {
    ctx.log(`[acp] in-flight replies still pending after ${deadlineMs}ms at shutdown`);
  }
  const closing = [...ctx.sessions.values()].map((live) => releaseSession(ctx, live));
  if (await withDeadline(() => Promise.allSettled(closing), deadlineMs) === 'timeout') {
    ctx.log(`[acp] session close still running after ${deadlineMs}ms at shutdown; exiting anyway`);
  }
}

/** D17: after the server resolves, flush stdout (bounded) and end the process with its exit code. */
export async function exitAfterServer(output: Writable, exit: (code: number) => void, flushMs = 1_000): Promise<void> {
  // The connection listener is gone now; flush callbacks can also report EPIPE.
  const onError = (): void => {};
  output.on('error', onError);
  try {
    await withDeadline(() => new Promise<void>((resolve) => {
      if (output.writableEnded || output.destroyed) { resolve(); return; }
      output.write('', () => resolve());
    }), flushMs);
  } finally { output.removeListener('error', onError); }
  exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
}
