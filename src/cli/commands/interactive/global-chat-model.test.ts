import { describe, it, expect } from 'vitest';
import {
  createChatState, addMessage, addSystem, applyWelcome, deleteMessage, appendInput, backspace, clearInput,
  beginSend, finishSend, scrollUp, scrollDown, clampScroll, mute, unmute, findByN, findByDisplay,
  tagForPubkey, cleanInputChunk, MAX_ENTRIES, MAX_INPUT_CHARS,
} from './global-chat-model.js';
import { deriveTag } from '../../../global-chat/crypto.js';
import type { Msg } from '../../../global-chat/protocol.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
let idc = 0;
function msg(over: Partial<Msg> = {}): Msg {
  idc++;
  return { id: idc.toString(16).padStart(32, '0'), ts: 1, pubkey: KEY_A, name: 'alice', text: 'hi', sig: 'f'.repeat(128), ...over };
}

describe('global chat model', () => {
  it('numbers messages and dedupes by id', () => {
    const s = createChatState();
    const m = msg();
    expect(addMessage(s, m)).toBe(true);
    expect(addMessage(s, m)).toBe(false);
    addMessage(s, msg());
    expect(s.entries.map((e) => (e.kind === 'msg' ? e.n : 0))).toEqual([1, 2]);
  });

  it('caps the list at MAX_ENTRIES and keeps numbers stable', () => {
    const s = createChatState();
    for (let i = 0; i < MAX_ENTRIES + 20; i++) addMessage(s, msg());
    expect(s.entries).toHaveLength(MAX_ENTRIES);
    expect(findByN(s, 1)).toBeNull();
    expect(findByN(s, MAX_ENTRIES + 20)?.n).toBe(MAX_ENTRIES + 20);
  });

  it('derives the same tag as the shared crypto helper', async () => {
    expect(tagForPubkey(KEY_A)).toBe(await deriveTag(KEY_A));
    expect(tagForPubkey('nothex')).toBe('????');
  });

  it('sanitizes incoming text and name again', () => {
    const s = createChatState();
    addMessage(s, msg({ name: 'ev\x1b[31mil', text: 'a\x1b]52;c;ZGF0YQ==\x07b\u202ec\u200bd\ne' }));
    const e = s.entries[0]!;
    expect(e.kind).toBe('msg');
    if (e.kind !== 'msg') return;
    expect(e.name).not.toContain('\x1b');
    expect(e.text).toBe('abcd e');
  });

  it('applies welcome backlog, presence, mode and notice', () => {
    const s = createChatState();
    applyWelcome(s, { online: 4, mode: 'readonly', backlog: [msg(), msg()], you: { pubkey: KEY_B, tag: 'bbbb', name: 'me', badge: 'maintainer' }, notice: 'hello' });
    expect(s.online).toBe(4);
    expect(s.mode).toBe('readonly');
    expect(s.me?.badge).toBe('maintainer');
    expect(s.entries).toHaveLength(3);
  });

  it('input editing: append, grapheme backspace, clear, paste flattening, cap', () => {
    const s = createChatState();
    appendInput(s, 'hi ');
    appendInput(s, '👍🏽');
    backspace(s);
    expect(s.input).toBe('hi ');
    appendInput(s, '\x1b[200~line1\nline2\x1b[201~');
    expect(s.input).toBe('hi line1 line2');
    clearInput(s);
    expect(s.input).toBe('');
    appendInput(s, 'x'.repeat(MAX_INPUT_CHARS + 50));
    expect(s.input).toHaveLength(MAX_INPUT_CHARS);
    expect(cleanInputChunk(' ')).toBe(' ');
    expect(cleanInputChunk('\x1b[A')).toBe('');
  });

  it('send lifecycle never loses text', () => {
    const s = createChatState();
    appendInput(s, '  hello  ');
    expect(beginSend(s)).toBe('hello');
    expect(beginSend(s)).toBeNull();
    appendInput(s, 'ignored while sending');
    finishSend(s, false, '  hello  ');
    expect(s.input).toBe('  hello  ');
    expect(s.sending).toBe(false);
    beginSend(s);
    finishSend(s, true, 'x');
    expect(s.input).toBe('');
    expect(beginSend(s)).toBeNull();
  });

  it('scrolling freezes the view and marks unseen arrivals', () => {
    const s = createChatState();
    addMessage(s, msg());
    scrollUp(s, 3);
    expect(s.frozenSeq).toBe(1);
    addMessage(s, msg());
    expect(s.unseen).toBe(true);
    scrollDown(s, 10);
    expect(s.frozenSeq).toBeNull();
    expect(s.unseen).toBe(false);
    scrollUp(s, 5);
    clampScroll(s, 0);
    expect(s.frozenSeq).toBeNull();
    addSystem(s, 'note');
    expect(s.entries.at(-1)?.kind).toBe('system');
  });

  it('mute, unmute, delete, find by display', () => {
    const s = createChatState();
    const m = msg({ pubkey: KEY_B, name: 'bob' });
    addMessage(s, m);
    const tag = tagForPubkey(KEY_B);
    expect(findByDisplay(s, 'bob', tag)?.pubkey).toBe(KEY_B);
    mute(s, KEY_B, 'bob', tag);
    expect(s.muted.has(KEY_B)).toBe(true);
    unmute(s, KEY_B);
    expect(s.muted.size).toBe(0);
    deleteMessage(s, m.id);
    expect(s.entries).toHaveLength(0);
  });
});
