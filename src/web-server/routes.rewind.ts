/**
 * POST /api/sessions/:id/rewind — retry or edit-and-resend.
 *
 * Two modes:
 *   { mode: 'retry' }             — rewind to just before the last user turn
 *                                   and resubmit it verbatim.
 *   { mode: 'edit', text: string } — rewind to just before turn N and submit
 *                                   the provided text. If turnIndex is omitted,
 *                                   the last user turn is targeted (same as retry
 *                                   but with new text).
 *
 * Both modes are refused while a turn is running (409 session_busy).
 *
 * Contract: this handler does NOT interact with the `/rewind` slash-command
 * chooser UI. It drives the same underlying machinery (executeSessionControl
 * dispatches into WebSessionControl.executeRewind which calls the provider's
 * rewindConversation and rebuilds the ledger projection), but chooses the
 * target turn programmatically so the browser needs no interactive picker.
 *
 * Invariant: retry and edit are CONVERSATION-ONLY rewinds of the newest
 * prompt. The /rewind handler (core.rewind.ts) is invoked with the forced
 * `conversation` mode argument so it never shows the mode picker and never
 * previews or restores files; the only `choose` it then issues is the target
 * picker, answered with '0' (newest-first list → most recent prompt).
 *
 * Invariant: we look up the /rewind SlashCommand by name from the core
 * commands registry at call time. If it is absent (renamed, gated) we 501.
 * The lookup is cheap — the list is small and always in memory.
 */

import type { ServerResponse } from 'node:http';
import { coreCommands } from '../cli/slash/commands/core.js';
import type { RouteContext } from './routes.js';
import { sendJson, requireValidSessionId } from './routes.js';
import { createWebSlashContext } from './slash-context.web.js';
import { BufferingWriter } from './writer.buffer.js';
import { getStats } from './session-owner.slash.js';
import { stripVTControlCharacters } from 'node:util';
import { errorMessage } from '../utils/errors.js';
import { isPreamble, extractUserContent } from '../agent/session/preamble-strip.js';

function requireOwned(ctx: RouteContext, res: ServerResponse, id: string): boolean {
  if (ctx.owned.has(id)) return true;
  sendJson(res, 409, {
    error: 'session_not_owned',
    message: `session ${id} is not owned by this process and cannot be rewound here`,
  });
  return false;
}

/**
 * Handle POST /api/sessions/:id/rewind.
 *
 * Body: { mode: 'retry', text?: string } | { mode: 'edit', text: string }
 */
export async function handleRewind(
  ctx: RouteContext,
  res: ServerResponse,
  sessionId: string,
  body: unknown,
): Promise<void> {
  if (!requireValidSessionId(res, sessionId)) return;
  if (!requireOwned(ctx, res, sessionId)) return;

  if (ctx.isBusy(sessionId)) {
    sendJson(res, 409, {
      error: 'session_busy',
      message: 'Cannot rewind while a turn is in flight. Stop the turn first.',
    });
    return;
  }

  // Reserve the turn slot immediately so concurrent requests cannot slip
  // through the TOCTOU gap between isBusy returning false and the slot being
  // claimed. All remaining validation and execution run inside the try block.
  ctx.reserveTurn?.(sessionId);
  try {
    if (!ctx.executeSessionControl || !ctx.getSession) {
      sendJson(res, 501, {
        error: 'rewind_not_supported',
        message: 'rewind requires a full session owner (not attach-only mode)',
      });
      return;
    }

    const record = body as Record<string, unknown> | null | undefined;
    const mode = typeof record?.['mode'] === 'string' ? record['mode'] : undefined;
    if (mode !== 'retry' && mode !== 'edit') {
      sendJson(res, 400, {
        error: 'bad_request',
        message: 'body must be { mode: "retry" } or { mode: "edit", text: string }',
      });
      return;
    }
    // Edit requires text. Retry MAY carry the prompt as the browser displays it
    // (the ledger's recorded `input`, i.e. what the user typed); the provider's
    // reloaded history can lead with drained framework context that the strip
    // heuristic does not always recognise, e.g. a bare `[placeholder-prevent] …`.
    const bodyText = typeof record?.['text'] === 'string' ? record['text'].trim() : '';
    const editText = mode === 'edit' ? bodyText : undefined;
    if (mode === 'edit' && !editText) {
      sendJson(res, 400, {
        error: 'bad_request',
        message: 'edit mode requires a non-empty text field',
      });
      return;
    }

    const rewindCmd = coreCommands.find((c) => c.name === '/rewind');
    if (!rewindCmd) {
      sendJson(res, 501, { error: 'rewind_not_supported', message: '/rewind command not found' });
      return;
    }

    const session = ctx.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session_not_found', message: `no live session ${sessionId}` });
      return;
    }

    const stats = getStats(sessionId);
    if (!stats) {
      sendJson(res, 404, { error: 'session_not_found', message: `no stats for ${sessionId}` });
      return;
    }

    const writer = new BufferingWriter();
    // Invariant: choose '0' always selects the most-recent user turn (newest-first list).
    const ctx2 = createWebSlashContext({ current: session }, stats, writer, stats.cwd ?? process.cwd());
    ctx2.choose = async () => '0';
    const writerText = () => stripVTControlCharacters(writer.getChunks().join('')).trim();

    const result = await ctx.executeSessionControl(sessionId, rewindCmd, ctx2, 'conversation');

    // Only a successful conversation rewind returns a prefill result; every
    // refusal path ('not-supported', 'turn-in-flight', nothing to rewind)
    // returns 'continue'. Never submit after a refused rewind: an edit would
    // APPEND instead of replacing, and a retry would duplicate the turn.
    const reloaded = result.result && typeof result.result === 'object' && 'kind' in result.result && result.result.kind === 'prefill'
      ? String((result.result as { message: string }).message)
      : undefined;
    if (reloaded === undefined) {
      sendJson(res, 409, { error: 'rewind_failed', message: writerText() || 'Nothing to rewind.' });
      return;
    }

    // The provider history holds the text as sent, which can lead with
    // framework preamble ([placeholder-prevent], bridge context); resend only
    // what the user typed, as the transcript projection displays it.
    const original = isPreamble(reloaded) ? (extractUserContent(reloaded) ?? reloaded) : reloaded;
    const textToSend = mode === 'retry' ? (bodyText || original.trim()) : editText!;
    if (!textToSend) {
      sendJson(res, 409, { error: 'rewind_failed', message: 'Rewound, but the original prompt text could not be recovered.' });
      return;
    }

    // Submit the prompt (enqueueTurn increments pending itself).
    ctx.submitPrompt(sessionId, textToSend);
    sendJson(res, 200, { ok: true, rewound: true, sent: textToSend });
  } catch (err) {
    sendJson(res, 500, { error: 'rewind_failed', message: errorMessage(err) });
  } finally {
    ctx.releaseTurn?.(sessionId);
  }
}
