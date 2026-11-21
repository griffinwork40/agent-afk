/**
 * Real-PTY acceptance for the /global chat view: the REAL slash handler and
 * view run against a REAL armed TerminalCompositor + ticking StatusLine inside
 * a node-pty, with a scripted in-memory ChatClient (tests/pty/global-chat-driver.ts).
 */
import { describe, it, expect } from 'vitest';
import { nodePtyAvailable } from './harness.js';
import { startChatSession, type ChatSession } from './global-chat-session.js';

const avail = nodePtyAvailable();
const ESC = '\x1b';

async function openChat(cols = 80, rows = 24, scenario = 'chat'): Promise<ChatSession> {
  const s = await startChatSession(scenario, cols, rows);
  await s.waitForEvent('open', 15_000);
  if (scenario === 'chat') await s.waitForText('BACKLOG_29');
  return s;
}
async function leaveAndCheckRepl(s: ChatSession, exitBytes: string): Promise<void> {
  s.type(exitBytes);
  await s.waitForEvent('closed');
  await s.waitFor(() => s.term.buffer.active.type === 'normal', 'normal buffer');
  await s.waitForText('AFTER_VIEW_MARKER');
  s.type('hi repl\r');
  const done = await s.waitForEvent('done');
  expect(done['submitted']).toBe('hi repl');
  const all = s.normalLines().join('\n');
  for (const l of ['MAINSCREEN_LINE_0', 'MAINSCREEN_LINE_2']) expect(all).toContain(l);
  // Nothing the view drew reached the main screen or its scrollback.
  for (const l of ['BACKLOG_', 'Global chat', 'Esc leave']) expect(all).not.toContain(l);
  expect(s.term.buffer.active.type).toBe('normal');
}

describe.skipIf(!avail.ok)('global chat view in a real pty', () => {
  it('opens, types, sends once, shows only the delivered echo, and Esc restores the REPL', async () => {
    const s = await openChat();
    try {
      expect(s.term.buffer.active.type).toBe('alternate');
      const scr = s.screen();
      expect(scr).toHaveLength(24);
      expect(scr[0]).toMatch(/global/i);
      expect(scr[23]).toMatch(/^> /);
      s.type('hello world');
      await s.waitFor(() => s.screen()[23]?.trimEnd() === '> hello world', 'typed text in box');
      s.type('\r');
      await s.waitFor(() => s.screen().some((l) => l.includes('hello world') && !l.startsWith('>')), 'echo delivered');
      expect(s.events().filter((e) => e['ev'] === 'post').map((e) => e['text'])).toEqual(['hello world']);
      expect(s.screen()[23]?.trimEnd()).toBe('>');
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });
});
