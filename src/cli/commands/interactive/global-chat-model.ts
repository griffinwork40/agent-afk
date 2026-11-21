/**
 * Global chat view state and transitions. No terminal I/O, no timers.
 *
 * Contract: every message text and name is passed through `sanitizeChatText`
 * here, even though the client already sanitizes. This module is the last stop
 * before the terminal, so it does not trust any upstream layer.
 *
 * @module cli/commands/interactive/global-chat-model
 */

import { MAX_TEXT_CHARS, type Badge, type Msg, type RoomMode } from '../../../global-chat/protocol.js';
import type { ChatConnectionStatus, ChatIdentity, ChatWelcome } from '../../../global-chat/client-types.js';
import { sanitizeChatText } from '../../../global-chat/sanitize.js';
import { previousGraphemeIndex } from '../../display.js';
import { createHash } from 'node:crypto';

export const MAX_ENTRIES = 300;
/** Local input cap; the relay limit is enforced by the relay and shown as a counter. */
export const MAX_INPUT_CHARS = MAX_TEXT_CHARS;

export interface ChatMessageEntry {
  kind: 'msg';
  removed?: boolean;
  seq: number;
  n: number;
  id: string;
  pubkey: string;
  name: string;
  tag: string;
  text: string;
  ts: number;
  badge?: Badge;
}
export interface ChatSystemEntry { kind: 'system'; seq: number; level: 'info' | 'error'; text: string }
export type ChatEntry = ChatMessageEntry | ChatSystemEntry;
export interface MuteEntry { name: string; tag: string }
export type ChatMe = ChatIdentity & { badge?: Badge };

export interface ChatViewState {
  entries: ChatEntry[];
  nextSeq: number;
  nextN: number;
  /** Rendered lines scrolled up from the bottom; 0 means pinned to the newest. */
  scroll: number;
  /** While scrolled up, entries with seq above this are laid out below the view. */
  frozenSeq: number | null;
  unseen: boolean;
  input: string;
  sending: boolean;
  status: ChatConnectionStatus;
  online: number | null;
  mode: RoomMode;
  me: ChatMe | null;
  muted: Map<string, MuteEntry>;
  banner: string | null;
}

export function createChatState(me: ChatMe | null = null): ChatViewState {
  return {
    entries: [], nextSeq: 1, nextN: 1, scroll: 0, frozenSeq: null, unseen: false,
    input: '', sending: false, status: 'connecting', online: null, mode: 'open',
    me: me ? { ...me, name: sanitizeChatText(me.name) } : null, muted: new Map(), banner: null,
  };
}

/**
 * Synchronous twin of `deriveTag` in `src/global-chat/crypto.ts` (first 4 hex
 * of SHA-256 over the raw key bytes). Sync so message order never depends on
 * async hashing. Malformed keys get a placeholder instead of throwing.
 */
export function tagForPubkey(pubkey: string): string {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return '????';
  return createHash('sha256').update(Buffer.from(pubkey, 'hex')).digest('hex').slice(0, 4);
}

function push(state: ChatViewState, entry: ChatEntry): void {
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) state.entries.splice(0, state.entries.length - MAX_ENTRIES);
}

/** Returns false when the message id is already present (reconnect backlog). */
export function addMessage(state: ChatViewState, msg: Msg): boolean {
  if (state.entries.some((e) => e.kind === 'msg' && e.id === msg.id)) return false;
  const entry: ChatMessageEntry = {
    kind: 'msg', seq: state.nextSeq++, n: state.nextN++, id: msg.id, pubkey: msg.pubkey,
    name: sanitizeChatText(msg.name), tag: tagForPubkey(msg.pubkey), text: sanitizeChatText(msg.text), ts: msg.ts,
  };
  if (msg.badge === 'maintainer') entry.badge = 'maintainer';
  push(state, entry);
  if (state.frozenSeq !== null && !state.muted.has(msg.pubkey)) state.unseen = true;
  return true;
}

export function addSystem(state: ChatViewState, text: string, level: 'info' | 'error' = 'info'): void {
  push(state, { kind: 'system', seq: state.nextSeq++, level, text: sanitizeChatText(text) });
  if (state.frozenSeq !== null) state.unseen = true;
}

export function applyWelcome(state: ChatViewState, welcome: ChatWelcome): void {
  state.online = welcome.online;
  state.mode = welcome.mode;
  state.me = { ...welcome.you, name: sanitizeChatText(welcome.you.name) };
  for (const msg of welcome.backlog) addMessage(state, msg);
  if (welcome.notice) addSystem(state, welcome.notice);
}

export function deleteMessage(state: ChatViewState, id: string): void {
  const entry = state.entries.find((e): e is ChatMessageEntry => e.kind === 'msg' && e.id === id);
  if (entry) { entry.text = '[removed]'; entry.removed = true; }
}

export function setStatus(state: ChatViewState, status: ChatConnectionStatus): void { state.status = status; }
export function setOnline(state: ChatViewState, online: number): void { state.online = online; }
export function setMode(state: ChatViewState, mode: RoomMode): void { state.mode = mode; }

/**
 * Flatten typed or pasted input to one safe line. The sentinels keep edge
 * spaces that `sanitizeChatText` would otherwise trim while the user types; a
 * non-ASCII sentinel cannot be swallowed as the final byte of a CSI sequence.
 */
const SENTINEL = '\u4e00';
export function cleanInputChunk(chunk: string): string {
  const out = sanitizeChatText(`${SENTINEL}${chunk.replace(/\x1b\[20[01]~/g, '')}${SENTINEL}`);
  return out.startsWith(SENTINEL) && out.endsWith(SENTINEL) ? out.slice(1, -1) : sanitizeChatText(chunk);
}

export function appendInput(state: ChatViewState, chunk: string): boolean {
  if (state.sending) return false;
  const clean = cleanInputChunk(chunk);
  if (!clean) return false;
  const room = MAX_INPUT_CHARS - state.input.length;
  if (room <= 0) return true;
  const next = clean.slice(0, room);
  state.input += next;
  return next.length < clean.length;
}

export function backspace(state: ChatViewState): void {
  if (state.sending || state.input.length === 0) return;
  state.input = state.input.slice(0, previousGraphemeIndex(state.input, state.input.length));
}

export function clearInput(state: ChatViewState): void { if (!state.sending) state.input = ''; }

/** Take the input for sending: returns the sanitized text and enters the sending state. */
export function beginSend(state: ChatViewState): string | null {
  if (state.sending) return null;
  const text = sanitizeChatText(state.input);
  if (!text) return null;
  state.sending = true;
  return text;
}

/** Success clears the box; failure restores the text so nothing typed is lost. */
export function finishSend(state: ChatViewState, ok: boolean, restore: string): void {
  state.sending = false;
  state.input = ok ? '' : restore;
}

export function scrollUp(state: ChatViewState, lines: number): void {
  if (state.frozenSeq === null) state.frozenSeq = state.nextSeq - 1;
  state.scroll += Math.max(0, lines);
}

export function scrollDown(state: ChatViewState, lines: number): void {
  state.scroll = Math.max(0, state.scroll - Math.max(0, lines));
  if (state.scroll === 0) { state.frozenSeq = null; state.unseen = false; }
}

/** Called by the view after render reports the real maximum. */
export function clampScroll(state: ChatViewState, maxScroll: number): void {
  if (state.scroll > maxScroll) state.scroll = Math.max(0, maxScroll);
  if (state.scroll === 0) { state.frozenSeq = null; state.unseen = false; }
}

export function mute(state: ChatViewState, pubkey: string, name: string, tag: string): void {
  state.muted.set(pubkey, { name: sanitizeChatText(name), tag: sanitizeChatText(tag) });
}
export function unmute(state: ChatViewState, pubkey: string): void { state.muted.delete(pubkey); }

export function findByN(state: ChatViewState, n: number): ChatMessageEntry | null {
  for (const e of state.entries) if (e.kind === 'msg' && e.n === n) return e;
  return null;
}

/** Newest message by that display name, so a renamed or reused name resolves to the latest author. */
export function findByDisplay(state: ChatViewState, name: string, tag: string): ChatMessageEntry | null {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i];
    if (e?.kind === 'msg' && e.name === name && e.tag === tag) return e;
  }
  return null;
}

export function findMutedByDisplay(state: ChatViewState, name: string, tag: string): string | null {
  for (const [pubkey, m] of state.muted) if (m.name === name && m.tag === tag) return pubkey;
  return null;
}
