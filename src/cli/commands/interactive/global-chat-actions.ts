/**
 * Actions the global chat view performs on Enter: sending a chat line and
 * running in-view commands. Results become local system lines; nothing here
 * writes to the terminal or any REPL output path.
 *
 * @module cli/commands/interactive/global-chat-actions
 */

import type { ChatActionResult, ChatClient, ChatRelayError, MuteStore } from '../../../global-chat/client-types.js';
import {
  addSystem, beginSend, clearInput, finishSend, mute, unmute, type ChatViewState,
} from './global-chat-model.js';
import { HELP_LINES, RULES_LINES, parseViewCommand, type ViewCommand } from './global-chat-commands.js';
import { explainFailure } from './global-chat-messages.js';

export interface ActionContext {
  state: ChatViewState;
  client: ChatClient;
  mutes: MuteStore;
  /** Request a coalesced repaint. */
  paint: () => void;
  /** False once the view has closed; late results are dropped. */
  isOpen: () => boolean;
}

/**
 * Contract: never optimistic. The text stays in the box (in a sending state)
 * until the relay answers; the message itself appears only when the relay
 * broadcasts it back. On failure the original text is restored.
 */
export async function sendChatLine(ctx: ActionContext): Promise<void> {
  const { state } = ctx;
  const original = state.input;
  const text = beginSend(state);
  if (text === null) return;
  ctx.paint();
  let result;
  try {
    result = await ctx.client.post(text);
  } catch {
    result = { ok: false as const, code: 'not_connected' as const, message: 'post failed' };
  }
  if (!ctx.isOpen()) return;
  finishSend(state, result.ok, original);
  if (!result.ok) addSystem(state, explainFailure(result), 'error');
  ctx.paint();
}

async function runAction(ctx: ActionContext, action: () => Promise<ChatActionResult>, done: string): Promise<void> {
  let result: ChatActionResult;
  try { result = await action(); } catch {
    result = { ok: false, code: 'not_connected', message: 'action failed' };
  }
  if (!ctx.isOpen()) return;
  if (result.ok) addSystem(ctx.state, done);
  else addSystem(ctx.state, explainFailure(result, 'Command'), 'error');
  ctx.paint();
}

async function execute(ctx: ActionContext, cmd: ViewCommand): Promise<void> {
  const { state, client } = ctx;
  switch (cmd.kind) {
    case 'help': for (const l of HELP_LINES) addSystem(state, l); return;
    case 'rules': for (const l of RULES_LINES) addSystem(state, l); return;
    case 'mutes': {
      const list = [...state.muted.values()].map((m) => `${m.name}#${m.tag}`);
      addSystem(state, list.length > 0 ? `Muted: ${list.join(', ')}` : 'You have not muted anyone.');
      return;
    }
    case 'mute':
      await ctx.mutes.add(cmd.author.pubkey, cmd.author.name);
      mute(state, cmd.author.pubkey, cmd.author.name, cmd.author.tag);
      addSystem(state, `Muted ${cmd.author.name}#${cmd.author.tag}. Their messages are hidden. /unmute to undo.`);
      return;
    case 'unmute':
      await ctx.mutes.remove(cmd.pubkey);
      unmute(state, cmd.pubkey);
      addSystem(state, `Unmuted ${cmd.display}.`);
      return;
    case 'report': return runAction(ctx, () => client.report(cmd.id), `Reported message ${cmd.n}. Thanks.`);
    case 'ban': return runAction(ctx, () => client.admin('ban', cmd.pubkey), `Banned ${cmd.display}.`);
    case 'unban': return runAction(ctx, () => client.admin('unban', cmd.pubkey), 'Unbanned that key.');
    case 'delete': return runAction(ctx, () => client.admin('delete', cmd.id), `Deleted message ${cmd.n}.`);
    case 'mode': return runAction(ctx, () => client.admin('mode', cmd.mode), `Room mode set to ${cmd.mode}.`);
    case 'error': addSystem(state, cmd.message, 'error'); return;
  }
}

/** Lines starting with `/` are view commands and are never posted. */
export async function submitLine(ctx: ActionContext): Promise<void> {
  const { state } = ctx;
  if (state.sending) return;
  const line = state.input.trim();
  if (!line) return;
  if (!line.startsWith('/')) return sendChatLine(ctx);
  clearInput(state);
  ctx.paint();
  try {
    await execute(ctx, parseViewCommand(line, state));
  } catch {
    if (ctx.isOpen()) addSystem(state, 'That command failed. Nothing was changed.', 'error');
  }
  if (ctx.isOpen()) ctx.paint();
}

/**
 * Relay errors tied to an action id are explained by that action's own result,
 * so only unsolicited errors (for example a ban or a refused hello) are shown.
 */
export function relayErrorLine(error: ChatRelayError): string | null {
  if (error.id !== undefined) return null;
  if (error.code === 'secret_detected') {
    return explainFailure({ ok: false, code: 'secret_detected', message: error.message, spans: [] });
  }
  const failure: ChatActionResult = { ok: false, code: error.code, message: error.message };
  if (error.retryAfterMs !== undefined) failure.retryAfterMs = error.retryAfterMs;
  return explainFailure(failure, 'Relay request');
}
