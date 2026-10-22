/**
 * POST /api/sessions/:id/commands — execute a native slash command on a
 * web-owned session and return the buffered output as JSON.
 *
 * Ordering (Amendment A2, revised):
 *   1. Validate session id
 *   2. Require owned
 *   3. Require turn-accounting present (501 if absent — no isBusy/reserveTurn)
 *   4. Parse body
 *   5. isBusy → 409  (no await between this check and reserveTurn)
 *   6. ensureSlashRegistry (idempotent memo — safe before reservation)
 *   7. waitForSessionReady — readiness is checked BEFORE reserveTurn so a
 *      2 s poll does not hold a reservation open against an unready session
 *   8. reserveTurn (synchronous, immediately after readiness confirmed)
 *   9. try { parse + gate + ctx + handler } finally { releaseTurn }
 */

import type { ServerResponse } from 'node:http';
import { sendJson, requireValidSessionId } from './routes.js';
import type { RouteContext } from './routes.js';
import type { AgentSession } from '../agent/session/agent-session.js';
import type { SlashResult } from '../cli/slash/types.js';
import type { CommandControl } from './shared/command-wire.js';
import { ensureSlashRegistry } from './slash-registry.js';
import { parse, lookup, suggest } from '../cli/slash/registry.js';
import { isGated, gateReason } from './command-gate.js';
import { BufferingWriter } from './writer.buffer.js';
import { getStats, buildSessionRef, buildOptionalSessionRef } from './session-owner.slash.js';
import { createWebSlashContext } from './slash-context.web.js';

/**
 * Poll owner.getSession up to 2s (40 × 50ms) before giving up.
 * The poll exists because a session may be created and stored in the owner
 * a few milliseconds after the route receives the request (creation is async).
 * Tests that want immediate failure should mock getSession to return undefined
 * and use vi.useFakeTimers, or rely on the 503 path directly.
 */
async function waitForSessionReady(
  ctx: RouteContext,
  id: string,
): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (ctx.getSession?.(id) !== undefined) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Normalise any SlashResult variant into the wire CommandControl shape. */
export function normalizeSlashResult(result: SlashResult): CommandControl {
  if (result === 'continue') return { kind: 'continue' };
  if (result === 'exit') return { kind: 'exit' };
  if (result === 'forward') return { kind: 'forward' };
  if (typeof result === 'object' && result !== null) {
    // 'rerun' is the discriminant for { rerun: string } — no cast needed after narrowing.
    if ('rerun' in result) return { kind: 'rerun', input: result.rerun };
    // 'kind' discriminates { kind: 'submit' | 'prefill'; message: string }.
    if ('kind' in result && result.kind === 'submit') return { kind: 'submit', message: result.message };
    if ('kind' in result && result.kind === 'prefill') return { kind: 'prefill', message: result.message };
  }
  return { kind: 'continue' };
}

export async function handleCommand(
  ctx: RouteContext,
  res: ServerResponse,
  sessionId: string,
  body: unknown,
): Promise<void> {
  // 1. Validate id
  if (!requireValidSessionId(res, sessionId)) return;

  // 2. Require owned
  if (!ctx.owned.has(sessionId)) {
    sendJson(res, 409, {
      error: 'session_not_owned',
      message: `session ${sessionId} is not owned by this process`,
    });
    return;
  }

  // 3. Require turn-accounting — without it we cannot guarantee serialization.
  // Contract: isBusy/reserveTurn/releaseTurn must all be present. An owner
  // that omits any of them is misconfigured; 501 surfaces this clearly.
  if (!ctx.isBusy || !ctx.reserveTurn || !ctx.releaseTurn) {
    sendJson(res, 501, {
      error: 'commands_not_supported',
      message: 'turn accounting (isBusy/reserveTurn/releaseTurn) is not configured on this server',
    });
    return;
  }

  // 4. Parse body
  if (
    typeof body !== 'object' ||
    body === null ||
    !('input' in body) ||
    typeof (body as Record<string, unknown>)['input'] !== 'string'
  ) {
    sendJson(res, 400, { error: 'bad_request', message: 'body must be { input: string }' });
    return;
  }
  const input = (body as Record<string, unknown>)['input'] as string;
  const cwd = ctx.getSessionCwd?.(sessionId) ?? process.cwd();

  // 5. isBusy check — no await between here and reserveTurn (step 6).
  if (ctx.isBusy(sessionId)) {
    sendJson(res, 409, {
      error: 'session_busy',
      message: `session ${sessionId} already has a turn in flight`,
    });
    return;
  }

  // 6. Ensure registry is initialized (idempotent memo — safe before reservation).
  await ensureSlashRegistry();

  // 7. Wait for session to be ready BEFORE reserving the turn so the 2 s poll
  //    does not hold a reservation open against an unready session.
  if (ctx.getSession && !(await waitForSessionReady(ctx, sessionId))) {
    sendJson(res, 503, {
      error: 'session_not_ready',
      message: 'session is not yet ready — retry in a moment',
    });
    return;
  }

  // 8. Reserve turn synchronously (no await between readiness check and this call).
  ctx.reserveTurn(sessionId);

  try {
    // Look up command in registry.
    const parsed = parse(input);
    if (!parsed) {
      sendJson(res, 400, { error: 'bad_request', message: 'input must be a slash command (starts with /)' });
      return;
    }

    const cmd = lookup(parsed.name);
    if (!cmd) {
      const safeName = parsed.name.slice(0, 64);
      const rawSuggestion = suggest(parsed.name) ?? undefined;
      const safeSuggestion = rawSuggestion?.slice(0, 64);
      sendJson(res, 404, {
        error: 'unknown_command',
        message: `unknown command: ${safeName}`,
        ...(safeSuggestion ? { suggestion: safeSuggestion } : {}),
      });
      return;
    }

    // Check gate list — returns 409 with human-readable reason.
    if (isGated(cmd.name)) {
      sendJson(res, 409, {
        error: 'command_gated',
        message: `command ${cmd.name} is not available on the web surface`,
        reason: gateReason(cmd.name),
      });
      return;
    }

    // Build SlashContext — session must be available if getSession is wired.
    const stats = getStats(sessionId);
    if (!stats) {
      sendJson(res, 503, { error: 'session_not_ready', message: 'session stats not initialized' });
      return;
    }

    // Invariant: session is looked up via the typed RouteContext.getSession —
    // no cast to a wider intersection type. When getSession is wired, we require
    // a defined session before building SlashContext (503 otherwise). When it is
    // absent (attach-only / tests without a wired owner), we accept undefined via
    // buildOptionalSessionRef — callers must not use ctx.session.current there.
    const session: AgentSession | undefined = ctx.getSession?.(sessionId);
    if (ctx.getSession && session === undefined) {
      sendJson(res, 503, {
        error: 'session_not_ready',
        message: 'session object is not available — retry in a moment',
      });
      return;
    }

    const sessionRef = session !== undefined
      ? buildSessionRef(session)
      : buildOptionalSessionRef(undefined);
    const writer = new BufferingWriter();
    const slashCtx = createWebSlashContext(sessionRef, stats, writer, cwd);

    // Execute handler — bounded to 15 s to prevent runaway commands from
    // holding the turn reservation open indefinitely.
    const HANDLER_TIMEOUT_MS = 15_000;
    const result = await Promise.race([
      cmd.handler(slashCtx, parsed.args ?? ''),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('command_timeout')), HANDLER_TIMEOUT_MS),
      ),
    ]);
    const block = writer.toOutputBlock();
    const control = normalizeSlashResult(result);

    sendJson(res, 200, { blocks: [block], control });
  } catch (err) {
    if (err instanceof Error && err.message === 'command_timeout') {
      console.error('[web] command handler timed out after 15000ms');
      sendJson(res, 504, { error: 'command_timeout', message: 'Command execution timed out.' });
    } else {
      console.error('[web] command handler failed:', err);
      sendJson(res, 500, { error: 'command_execution_failed', message: 'An internal error occurred while executing the command.' });
    }
  } finally {
    // Invariant: releaseTurn fires for ALL return paths inside the try block
    // (including gated 409, session_not_ready 503, and thrown exceptions).
    // The 501/400/409 pre-try early returns do not call reserveTurn, so they
    // must NOT call releaseTurn either — this finally only runs after step 6.
    ctx.releaseTurn(sessionId);
  }
}
