import { describe, it, expect } from 'vitest';
import { renderChat, mentionCells, inputLine, COUNTER_FROM } from './global-chat-render.js';
import { createChatState, addMessage, addSystem, appendInput, scrollUp, mute, unmute, tagForPubkey, type ChatViewState } from './global-chat-model.js';
import { displayWidth, stripAnsi } from '../../display.js';
import type { Msg } from '../../../global-chat/protocol.js';

const ME = 'c'.repeat(64);
let idc = 0;
function msg(over: Partial<Msg> = {}): Msg {
  idc++;
  return { id: idc.toString(16).padStart(32, '0'), ts: 1, pubkey: 'a'.repeat(64), name: 'alice', text: 'hi', sig: 'f'.repeat(128), ...over };
}
function state(): ChatViewState {
  const s = createChatState({ pubkey: ME, tag: tagForPubkey(ME), name: 'me' });
  s.status = 'open';
  s.online = 3;
  return s;
}
const plain = (lines: string[]): string[] => lines.map(stripAnsi);
const SIZES: Array<[number, number]> = [[80, 24], [40, 10], [20, 6], [19, 24], [80, 5], [10, 3], [1, 1], [0, 0], [3, 8], [200, 50]];

const HOSTILE = [
  'osc52 \x1b]52;c;ZXZpbA==\x07 tail', 'csi \x1b[2J\x1b[H clear', 'bidi \u202eevil\u202c', 'zw a\u200bb\u200dc\ufeff',
  'nl one\ntwo\r\nthree', 'c1 \x9b31m', 'bel \x07', 'dcs \x1bP1;2|x\x1b\\',
];

describe('renderChat', () => {
  it('returns exactly rows lines, none wider than columns, at many sizes', () => {
    const s = state();
    addMessage(s, msg({ text: '你好世界 '.repeat(30) + '👨‍👩‍👧‍👦 🎉 emoji ' }));
    addMessage(s, msg({ pubkey: ME, name: 'me', text: 'own message '.repeat(10) }));
    addSystem(s, 'a system line that is fairly long and should wrap nicely in narrow terminals', 'error');
    appendInput(s, '漢字'.repeat(60));
    for (const [c, r] of SIZES) {
      const { lines } = renderChat(s, c, r);
      expect(lines).toHaveLength(Math.max(0, r));
      for (const l of lines) expect(displayWidth(l)).toBeLessThanOrEqual(Math.max(0, c));
    }
  });

  it('header shows room, online, status and non-open mode', () => {
    const s = state();
    s.mode = 'readonly';
    const head = stripAnsi(renderChat(s, 80, 24).lines[0]!);
    expect(head).toContain('#global');
    expect(head).toContain('3 online');
    expect(head).toContain('connected');
    expect(head).toContain('read-only');
  });

  it('shows number, name#tag, badge and text, and wraps wide characters', () => {
    const s = state();
    addMessage(s, msg({ text: '漢'.repeat(40), badge: 'maintainer' }));
    const lines = plain(renderChat(s, 40, 12).lines);
    const tag = tagForPubkey('a'.repeat(64));
    const first = lines.findIndex((l) => l.includes(`alice#${tag}`));
    expect(lines[first]).toMatch(/^1 alice#\w{4} \[maint\] 漢/);
    expect(lines[first + 1]!.trim()).toMatch(/^漢+$/);
  });

  it('hostile input never reaches a rendered line', () => {
    const s = state();
    for (const t of HOSTILE) addMessage(s, msg({ text: t, name: `x${t}`.slice(0, 10) }));
    for (const [c, r] of [[80, 40], [25, 40]] as const) {
      for (const l of renderChat(s, c, r).lines) {
        const raw = stripAnsi(l);
        expect(raw).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/);
      }
    }
  });

  it('highlights @mentions of the user only as whole names', () => {
    const cells = mentionCells('hey @me and @meow', 'me');
    const hi = cells.filter((c) => c.hi).map((c) => c.g).join('');
    expect(hi).toBe('@me');
    expect(mentionCells('x', null).every((c) => !c.hi)).toBe(true);
    const s = state();
    addMessage(s, msg({ text: 'ping @me' }));
    expect(renderChat(s, 80, 10).lines.join('\n')).toContain('@me');
  });

  it('mute hides existing messages and unmute restores them', () => {
    const s = state();
    addMessage(s, msg({ pubkey: 'b'.repeat(64), name: 'bob', text: 'bob says' }));
    const has = (): boolean => plain(renderChat(s, 80, 10).lines).some((l) => l.includes('bob says'));
    expect(has()).toBe(true);
    mute(s, 'b'.repeat(64), 'bob', 'xxxx');
    expect(has()).toBe(false);
    addMessage(s, msg({ pubkey: 'b'.repeat(64), name: 'bob', text: 'bob says again' }));
    expect(has()).toBe(false);
    unmute(s, 'b'.repeat(64));
    expect(has()).toBe(true);
  });

  it('scrollback keeps the view still and shows the new-messages marker', () => {
    const s = state();
    for (let i = 0; i < 30; i++) addMessage(s, msg({ text: `m${i}` }));
    const bottom = plain(renderChat(s, 80, 10).lines);
    expect(bottom.some((l) => l.endsWith('m29'))).toBe(true);
    scrollUp(s, 5);
    const up = renderChat(s, 80, 10);
    expect(up.maxScroll).toBe(30 - 7); // 10 rows minus header, hint, input
    const before = plain(up.lines);
    addMessage(s, msg({ text: 'fresh' }));
    const after = plain(renderChat(s, 80, 10).lines);
    expect(after.some((l) => l.includes('new messages below'))).toBe(true);
    expect(after.some((l) => l.includes('fresh'))).toBe(false);
    expect(after.slice(1, 6)).toEqual(before.slice(1, 6));
  });

  it('input shows its tail, the sending state, and a counter near the limit', () => {
    const s = state();
    appendInput(s, 'abcdefghij'.repeat(10) + 'END');
    expect(stripAnsi(inputLine(s, 30))).toMatch(/END$/);
    s.sending = true;
    expect(stripAnsi(inputLine(s, 30))).toContain('sending');
    s.sending = false;
    s.input = 'x'.repeat(COUNTER_FROM);
    expect(stripAnsi(inputLine(s, 80))).toContain(`${COUNTER_FROM}/500`);
  });

  it('shows the banner when set', () => {
    const s = state();
    s.banner = 'Your agent has results waiting. Esc to return.';
    expect(stripAnsi(renderChat(s, 80, 10).lines[1]!)).toContain('results waiting');
  });
});
