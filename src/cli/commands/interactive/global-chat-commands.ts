/**
 * Pure parser for lines typed inside the global chat view that start with `/`.
 * These are view commands and are never sent as chat.
 *
 * @module cli/commands/interactive/global-chat-commands
 */

import type { RoomMode } from '../../../global-chat/protocol.js';
import { parseDisplayName } from '../../../global-chat/names.js';
import { findByDisplay, findByN, findMutedByDisplay, type ChatViewState } from './global-chat-model.js';

export interface ResolvedAuthor { pubkey: string; name: string; tag: string }
export type ViewCommand =
  | { kind: 'help' }
  | { kind: 'rules' }
  | { kind: 'mutes' }
  | { kind: 'mute'; author: ResolvedAuthor }
  | { kind: 'unmute'; pubkey: string; display: string }
  | { kind: 'report'; id: string; n: number }
  | { kind: 'ban'; pubkey: string; display: string }
  | { kind: 'unban'; pubkey: string }
  | { kind: 'delete'; id: string; n: number }
  | { kind: 'mode'; mode: RoomMode }
  | { kind: 'error'; message: string };

export const HELP_LINES: readonly string[] = [
  'Commands: /help  /rules  /mute <n or name#tag>  /unmute <name#tag>  /mutes  /report <n>',
  'Maintainers: /ban <n or name#tag>  /unban <public key>  /delete <n>  /mode <open|readonly|closed>',
  '<n> is the small number shown beside a message. Esc or Ctrl+C leaves.',
];
export const RULES_LINES: readonly string[] = [
  'Rules: be decent, no spam, no secrets. Messages are public and kept by the relay for 7 days.',
  'This room is for people, not agents. Use /mute to hide someone and /report to flag a message.',
];

function err(message: string): ViewCommand { return { kind: 'error', message }; }

function resolveAuthor(state: ChatViewState, arg: string): ResolvedAuthor | string {
  if (/^\d+$/.test(arg)) {
    const e = findByN(state, Number(arg));
    return e ? { pubkey: e.pubkey, name: e.name, tag: e.tag } : `No message numbered ${arg} is on screen.`;
  }
  const d = parseDisplayName(arg);
  if (!d) return `Expected a message number or name#tag, got "${arg}".`;
  const e = findByDisplay(state, d.name, d.tag);
  return e ? { pubkey: e.pubkey, name: e.name, tag: e.tag } : `No recent message from ${arg}.`;
}

function resolveMessage(state: ChatViewState, arg: string, verb: string): { id: string; n: number } | string {
  if (!/^\d+$/.test(arg)) return `Usage: /${verb} <n>, where n is the number beside a message.`;
  const e = findByN(state, Number(arg));
  return e ? { id: e.id, n: e.n } : `No message numbered ${arg} is on screen.`;
}

function isMaintainer(state: ChatViewState): boolean { return state.me?.badge === 'maintainer'; }

function parseAdmin(state: ChatViewState, cmd: string, arg: string): ViewCommand {
  if (!isMaintainer(state)) return err(`/${cmd} is for maintainers only.`);
  if (cmd === 'ban') {
    if (!arg) return err('Usage: /ban <n or name#tag>');
    const a = resolveAuthor(state, arg);
    return typeof a === 'string' ? err(a) : { kind: 'ban', pubkey: a.pubkey, display: `${a.name}#${a.tag}` };
  }
  if (cmd === 'unban') {
    return /^[0-9a-f]{64}$/.test(arg) ? { kind: 'unban', pubkey: arg } : err('Usage: /unban <64-character hex public key>');
  }
  if (cmd === 'delete') {
    const m = resolveMessage(state, arg, 'delete');
    return typeof m === 'string' ? err(m) : { kind: 'delete', ...m };
  }
  if (arg === 'open' || arg === 'readonly' || arg === 'closed') return { kind: 'mode', mode: arg };
  return err('Usage: /mode <open|readonly|closed>');
}

/** `line` must start with `/`. */
export function parseViewCommand(line: string, state: ChatViewState): ViewCommand {
  const trimmed = line.trim();
  const space = trimmed.indexOf(' ');
  const cmd = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const arg = space === -1 ? '' : trimmed.slice(space + 1).trim();
  switch (cmd) {
    case 'help': return { kind: 'help' };
    case 'rules': return { kind: 'rules' };
    case 'mutes': return { kind: 'mutes' };
    case 'mute': {
      if (!arg) return err('Usage: /mute <n or name#tag>');
      const a = resolveAuthor(state, arg);
      if (typeof a === 'string') return err(a);
      if (a.pubkey === state.me?.pubkey) return err('You cannot mute yourself.');
      return { kind: 'mute', author: a };
    }
    case 'unmute': {
      const d = parseDisplayName(arg);
      if (!d) return err('Usage: /unmute <name#tag>');
      const pubkey = findMutedByDisplay(state, d.name, d.tag);
      return pubkey ? { kind: 'unmute', pubkey, display: arg } : err(`${arg} is not muted.`);
    }
    case 'report': {
      const m = resolveMessage(state, arg, 'report');
      if (typeof m === 'string') return err(m);
      if (findByN(state, m.n)?.pubkey === state.me?.pubkey) return err('You cannot report your own message.');
      return { kind: 'report', ...m };
    }
    case 'ban': case 'unban': case 'delete': case 'mode':
      return parseAdmin(state, cmd, arg);
    default:
      return err(`Unknown command /${cmd.slice(0, 20)}. Type /help for the list. Messages starting with / are never sent.`);
  }
}
