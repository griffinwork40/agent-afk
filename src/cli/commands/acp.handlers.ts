/**
 * ACP v1 method handlers: initialize, session/new, session/prompt,
 * session/cancel, session/close, session/load, session/resume (profile §1-§9).
 * Handlers throw {@link AcpError}; the server maps it to a generic response.
 *
 * @module cli/commands/acp.handlers
 */

import { randomUUID } from 'node:crypto';
import type { AgentModelInput } from '../../agent/types.js';
import { MODEL_CONTEXT_LIMITS, contextLimitFor } from '../../agent/model-limits.js';
import { resolveModelInput } from '../../agent/session/model-slots.js';
import { getVersion } from '../version.js';
import { buildAcpSession, closeAcpSession, type AcpSessionOptions } from './acp.session.js';
import { loadAcpSession, replayHistory } from './acp.session-load.js';
import { createAcpPermissionGate } from './acp.permission.js';
import { createTranslatorState } from './acp.translate.js';
import { AcpInvalidParams, parseSessionSetup, type SessionSetup } from './acp.params.js';
import { cancelTurn, makeEmitToolCall, runPromptTurn, type LiveSession } from './acp.prompt-turn.js';
import {
  INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, RESOURCE_NOT_FOUND, normalizePrompt,
} from './acp.server.protocol.js';
import type { AcpRpcPeer, InitializeResponse, PromptResponse, StopReason } from './acp.wire.js';

export class AcpError extends Error {
  constructor(readonly code: number, readonly detail?: string) {
    super(detail ?? `ACP error ${code}`);
  }
}

export interface HandlerOptions {
  model: AgentModelInput;
  maxTurns: number;
  dangerouslySkipPermissions?: boolean;
  /** Turn-cancel drain window; tests shorten it. */
  cancelGraceMs?: number;
}

export interface ServerContext {
  opts: HandlerOptions;
  peer: AcpRpcPeer;
  serverCwd: string;
  initialized: boolean;
  sessions: Map<string, LiveSession>;
  /** Ids whose restore is in flight (duplicate restore is invalid request). */
  restoring: Set<string>;
  /** Per-session promise that settles once the active prompt's response is written. */
  promptWrites: Map<string, Promise<void>>;
  log(line: string): void;
}

export function requireInit(ctx: ServerContext): void {
  if (!ctx.initialized) throw new AcpError(INVALID_REQUEST, 'not initialized');
}

function sessionIdParam(params: unknown): string {
  const id = (params as Record<string, unknown> | null | undefined)?.['sessionId'];
  if (typeof id !== 'string' || id === '') throw new AcpError(INVALID_PARAMS, 'sessionId required');
  return id;
}

export function handleInitialize(ctx: ServerContext, params: unknown): InitializeResponse {
  if (ctx.initialized) throw new AcpError(INVALID_REQUEST, 'duplicate initialize');
  const v = (params as Record<string, unknown> | null | undefined)?.['protocolVersion'];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 65535) {
    throw new AcpError(INVALID_PARAMS, 'protocolVersion must be an integer 0..65535');
  }
  ctx.initialized = true;
  return {
    protocolVersion: 1,
    agentInfo: { name: 'afk', title: 'AFK', version: getVersion() },
    authMethods: [],
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: false, audio: false, embeddedContext: true },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: { resume: {}, close: {} },
    },
  };
}

/** Context window only from verified model info; never a fallback guess (D2). */
export function knownContextWindow(model: AgentModelInput): number | undefined {
  const key = String(model).trim().toLowerCase();
  const id = resolveModelInput(String(model)) ?? key;
  if (MODEL_CONTEXT_LIMITS[key] === undefined && MODEL_CONTEXT_LIMITS[id] === undefined
    && MODEL_CONTEXT_LIMITS[id.toLowerCase()] === undefined) return undefined;
  const n = contextLimitFor(model);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function parseSetup(params: unknown, ctx: ServerContext, mode: 'new' | 'load' | 'resume'): SessionSetup {
  try {
    return parseSessionSetup(params, ctx.serverCwd, mode);
  } catch (err) {
    if (err instanceof AcpInvalidParams) throw new AcpError(INVALID_PARAMS, err.detail);
    throw err;
  }
}

/** Create the live record, its translator and (unless skipped) its gate. */
function prepareLive(ctx: ServerContext, id: string, setup: SessionSetup): { live: LiveSession; options: AcpSessionOptions } {
  const translator = createTranslatorState();
  const window = knownContextWindow(ctx.opts.model);
  if (window !== undefined) translator.contextWindowSize = window;
  const live: LiveSession = { id, cwd: setup.cwd, translator, closing: false };
  if (!ctx.opts.dangerouslySkipPermissions) {
    live.gate = createAcpPermissionGate(ctx.peer, id, {
      skip: false,
      emitToolCall: makeEmitToolCall(live, ctx.peer),
      onCancelled: () => cancelTurn(live, ctx.log),
    });
  }
  // The first start of a call that will not ask is in_progress, not pending (profile §5).
  const gate = live.gate;
  translator.requiresConsent = gate
    ? (name, input) => gate.wouldAsk?.(name, input) ?? true
    : () => false;
  const options: AcpSessionOptions = {
    model: ctx.opts.model,
    maxTurns: ctx.opts.maxTurns,
    dangerouslySkipPermissions: ctx.opts.dangerouslySkipPermissions,
    cwd: setup.cwd,
    sessionId: id,
    mcpServers: setup.mcpServers,
    ...(live.gate ? { canUseTool: live.gate.canUseTool } : {}),
  };
  return { live, options };
}

function internal(ctx: ServerContext, what: string, err: unknown): AcpError {
  ctx.log(`[acp] ${what}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  return new AcpError(INTERNAL_ERROR, what);
}

export async function handleSessionNew(ctx: ServerContext, params: unknown): Promise<{ sessionId: string }> {
  requireInit(ctx);
  const setup = parseSetup(params, ctx, 'new');
  const sessionId = randomUUID();
  const { live, options } = prepareLive(ctx, sessionId, setup);
  try {
    live.handle = await buildAcpSession(options);
  } catch (err) {
    throw internal(ctx, 'session construction failed', err);
  }
  ctx.sessions.set(sessionId, live);
  return { sessionId };
}

/** Restore a mapped session; load additionally replays display history. */
export async function handleRestore(
  ctx: ServerContext, params: unknown, mode: 'load' | 'resume',
): Promise<Record<string, never>> {
  requireInit(ctx);
  const setup = parseSetup(params, ctx, mode);
  const id = setup.sessionId ?? '';
  if (ctx.sessions.has(id) || ctx.restoring.has(id)) throw new AcpError(INVALID_REQUEST, 'session already active');
  ctx.restoring.add(id);
  try {
    const { live, options } = prepareLive(ctx, id, setup);
    // Prior cumulative cost is not recoverable through the load seam.
    live.translator.costIncomplete = true;
    try {
      live.handle = await loadAcpSession({ sessionId: id, cwd: setup.cwd, mcpServers: setup.wireMcp }, options);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === RESOURCE_NOT_FOUND) {
        throw new AcpError(RESOURCE_NOT_FOUND, 'unknown session');
      }
      throw internal(ctx, `session ${mode} failed`, err);
    }
    if (mode === 'load') {
      try {
        await replayHistory(id, ctx.peer, setup.cwd);
      } catch (err) {
        await closeAcpSession(live.handle).catch(() => undefined);
        throw internal(ctx, 'replay failed', err);
      }
    }
    ctx.sessions.set(id, live);
    return {};
  } finally {
    ctx.restoring.delete(id);
  }
}

/** Remove and release a session, discarding its gate and grants. */
export async function releaseSession(ctx: ServerContext, live: LiveSession): Promise<void> {
  if (ctx.sessions.get(live.id) === live) ctx.sessions.delete(live.id);
  live.gate = undefined;
  const handle = live.handle;
  live.handle = undefined;
  if (handle) await closeAcpSession(handle).catch((err: unknown) => ctx.log(`[acp] close failed: ${String(err)}`));
}

/**
 * Validate synchronously and start the turn; the returned promise resolves to
 * the prompt result. Synchronous validation makes the duplicate-active check
 * race-free with respect to the next inbound line.
 */
export function startPrompt(ctx: ServerContext, params: unknown): Promise<PromptResponse> {
  requireInit(ctx);
  const sessionId = sessionIdParam(params);
  const text = normalizePrompt((params as Record<string, unknown>)['prompt']);
  if (text === null) throw new AcpError(INVALID_PARAMS, 'invalid prompt content');
  const live = ctx.sessions.get(sessionId);
  if (!live || live.closing) throw new AcpError(RESOURCE_NOT_FOUND, 'unknown session');
  if (live.active) throw new AcpError(INVALID_REQUEST, 'prompt already active');
  const turn = runPromptTurn(live, text, {
    peer: ctx.peer, log: ctx.log,
    ...(ctx.opts.cancelGraceMs !== undefined ? { cancelGraceMs: ctx.opts.cancelGraceMs } : {}),
  });
  return turn.then(
    (stopReason: StopReason) => ({ stopReason }),
    async (err: unknown) => {
      // The handle may be dead after a provider error: drop it so it is not reused.
      const failure = internal(ctx, 'prompt failed', err);
      await releaseSession(ctx, live);
      throw failure;
    },
  );
}

/** `session/cancel` notification: no response, malformed input is only logged. */
export function handleCancel(ctx: ServerContext, params: unknown): void {
  const id = (params as Record<string, unknown> | null | undefined)?.['sessionId'];
  if (typeof id !== 'string') {
    ctx.log('[acp] malformed session/cancel notification ignored');
    return;
  }
  const live = ctx.sessions.get(id);
  if (live) cancelTurn(live, ctx.log);
}

export async function handleClose(ctx: ServerContext, params: unknown): Promise<Record<string, never>> {
  requireInit(ctx);
  const live = ctx.sessions.get(sessionIdParam(params));
  if (!live || live.closing) return {};
  live.closing = true;
  const turn = live.active;
  cancelTurn(live, ctx.log);
  if (turn) await turn.done;
  // Contract: the cancelled prompt's response precedes the close reply (§7).
  await ctx.promptWrites.get(live.id);
  await releaseSession(ctx, live);
  return {};
}
