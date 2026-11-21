import { describe, it, expect } from 'vitest';
import { HELP_LINES, parseViewCommand } from './global-chat-commands.js';
import { createChatState, addMessage, mute, tagForPubkey, type ChatViewState } from './global-chat-model.js';

const ME = 'c'.repeat(64);
const BOB = 'b'.repeat(64);
function state(maint = false): ChatViewState {
  const s = createChatState({ pubkey: ME, tag: tagForPubkey(ME), name: 'me', ...(maint ? { badge: 'maintainer' as const } : {}) });
  addMessage(s, { id: '1'.repeat(32), ts: 1, pubkey: BOB, name: 'bob', text: 'yo', sig: 'f'.repeat(128) });
  addMessage(s, { id: '2'.repeat(32), ts: 1, pubkey: ME, name: 'me', text: 'mine', sig: 'f'.repeat(128) });
  return s;
}
const bobTag = tagForPubkey(BOB);

describe('parseViewCommand', () => {
  it('help, rules, mutes', () => {
    expect(parseViewCommand('/help', state()).kind).toBe('help');
    expect(parseViewCommand('/RULES', state()).kind).toBe('rules');
    expect(parseViewCommand('/mutes', state()).kind).toBe('mutes');
  });
  it('mute by number and by name#tag; rejects self and unknown', () => {
    expect(parseViewCommand('/mute 1', state())).toEqual({ kind: 'mute', author: { pubkey: BOB, name: 'bob', tag: bobTag } });
    expect(parseViewCommand(`/mute bob#${bobTag}`, state())).toMatchObject({ kind: 'mute' });
    expect(parseViewCommand('/mute 2', state())).toMatchObject({ kind: 'error', message: expect.stringContaining('yourself') });
    expect(parseViewCommand('/mute 9', state())).toMatchObject({ kind: 'error' });
    expect(parseViewCommand('/mute', state())).toMatchObject({ kind: 'error', message: expect.stringContaining('Usage') });
    expect(parseViewCommand('/mute bob', state())).toMatchObject({ kind: 'error' });
  });
  it('unmute resolves against the mute set', () => {
    const s = state();
    expect(parseViewCommand(`/unmute bob#${bobTag}`, s)).toMatchObject({ kind: 'error' });
    mute(s, BOB, 'bob', bobTag);
    expect(parseViewCommand(`/unmute bob#${bobTag}`, s)).toEqual({ kind: 'unmute', pubkey: BOB, display: `bob#${bobTag}` });
    expect(parseViewCommand('/unmute 1', s)).toMatchObject({ kind: 'error' });
  });
  it('report needs another user message number', () => {
    expect(parseViewCommand('/report 1', state())).toEqual({ kind: 'report', id: '1'.repeat(32), n: 1 });
    expect(parseViewCommand('/report 2', state())).toMatchObject({ kind: 'error', message: expect.stringContaining('own message') });
    expect(parseViewCommand('/report x', state())).toMatchObject({ kind: 'error' });
  });
  it('maintainer commands are refused for others', () => {
    for (const c of ['/ban 1', '/unban ' + BOB, '/delete 1', '/mode readonly']) {
      expect(parseViewCommand(c, state())).toMatchObject({ kind: 'error', message: expect.stringContaining('maintainers') });
    }
  });
  it('maintainer commands parse for maintainers', () => {
    const s = state(true);
    expect(parseViewCommand('/ban 1', s)).toEqual({ kind: 'ban', pubkey: BOB, display: `bob#${bobTag}` });
    expect(parseViewCommand(`/ban bob#${bobTag}`, s)).toMatchObject({ kind: 'ban' });
    expect(parseViewCommand('/ban', s)).toMatchObject({ kind: 'error' });
    expect(parseViewCommand('/unban ' + BOB, s)).toEqual({ kind: 'unban', pubkey: BOB });
    expect(parseViewCommand('/unban xyz', s)).toMatchObject({ kind: 'error' });
    expect(parseViewCommand('/delete 2', s)).toEqual({ kind: 'delete', id: '2'.repeat(32), n: 2 });
    expect(parseViewCommand('/delete', s)).toMatchObject({ kind: 'error' });
    expect(parseViewCommand('/mode closed', s)).toEqual({ kind: 'mode', mode: 'closed' });
    expect(parseViewCommand('/mode loud', s)).toMatchObject({ kind: 'error' });
  });
  it('documents every accepted command in help', () => {
    const help = HELP_LINES.join('\n');
    for (const command of ['/help', '/rules', '/mutes', '/mute', '/unmute', '/report', '/ban', '/unban', '/delete', '/mode']) {
      expect(help).toContain(command);
    }
  });

  it('unknown commands get a hint', () => {
    expect(parseViewCommand('/frobnicate now', state())).toMatchObject({ kind: 'error', message: expect.stringContaining('/help') });
  });
});
