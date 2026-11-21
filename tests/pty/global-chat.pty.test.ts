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
      // Raw mode is on when the view starts reading (suspendInput turned it off).
      expect((await s.waitForEvent('connect'))['isRaw']).toBe(true);
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

const row = (s: ChatSession, i: number): string => (s.screen()[i] ?? '').trimEnd();
const inputRow = (s: ChatSession): string => row(s, s.screen().length - 1);
const displayCols = (l: string): number => Array.from(l).reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1), 0);

describe.skipIf(!avail.ok)('global chat view in a real pty: behaviours', () => {
  it('lays out within a narrow 40x12 terminal', async () => {
    const s = await openChat(40, 12);
    try {
      const scr = s.screen();
      expect(scr).toHaveLength(12);
      expect(scr[0]).toMatch(/global/i);
      expect(inputRow(s)).toBe('>');
      for (const l of scr) expect(displayCols(l.trimEnd())).toBeLessThanOrEqual(40);
      expect(scr.join('\n')).toContain('BACKLOG_29');
      expect(scr.join('\n')).not.toContain('FOOTERMODEL');
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });

  it('keeps a removed message as a placeholder in the real terminal', async () => {
    const s = await openChat();
    try {
      s.signal('SIGUSR1');
      await s.waitForText('[removed]');
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });

  it('a refused post restores the text and shows the reason', async () => {
    const s = await openChat();
    try {
      s.type('please refuseme');
      await s.waitFor(() => inputRow(s) === '> please refuseme', 'typed');
      s.type('\r');
      await s.waitFor(() => /slow|rate|wait/i.test(s.screen().join('\n')), 'refusal reason');
      await s.waitFor(() => inputRow(s) === '> please refuseme', 'text restored');
      expect(s.events().filter((e) => e['ev'] === 'post')).toHaveLength(1);
      expect(s.screen().slice(0, -1).join('\n')).not.toMatch(/me#\w+.*please refuseme/);
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });

  it('backspace removes one emoji or one wide CJK character and redraws the box', async () => {
    const s = await openChat();
    try {
      s.type('ab😀');
      await s.waitFor(() => inputRow(s) === '> ab😀', 'emoji typed');
      s.type('\x7f');
      await s.waitFor(() => inputRow(s) === '> ab', 'emoji removed');
      s.type('漢字');
      await s.waitFor(() => inputRow(s) === '> ab漢字', 'cjk typed');
      s.type('\x7f');
      await s.waitFor(() => inputRow(s) === '> ab漢', 'one cjk removed');
      s.type('c');
      await s.waitFor(() => inputRow(s) === '> ab漢c', 'box intact after wide delete');
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });

  it('a bracketed paste with a newline and an escape sequence becomes one clean line, not a send', async () => {
    const s = await openChat();
    try {
      s.type('\x1b[200~first\nsecond\x1b[31mRED\x1b[0m\x1b]0;T\x07\x1b[201~');
      await s.waitFor(() => inputRow(s).startsWith('> first'), 'paste in box');
      await s.sleep(150);
      expect(inputRow(s)).toBe('> first secondRED');
      expect(s.events().filter((e) => e['ev'] === 'post')).toHaveLength(0);
      expect(s.titles).toEqual([]);
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });

  it('PgUp scrolls, an arrival while scrolled up shows the marker without moving the view, PgDn returns', async () => {
    const s = await openChat();
    try {
      s.type('\x1b[5~');
      await s.waitFor(() => !s.screen().join('\n').includes('BACKLOG_29'), 'scrolled up');
      const before = s.screen().slice(0, 18).join('\n');
      s.signal('SIGUSR2');
      await s.waitForText('new messages below');
      expect(s.screen().slice(0, 18).join('\n')).toBe(before);
      s.type('\x1b[6~');
      await s.waitForText('LIVE_WHILE_SCROLLED');
      expect(s.screen().join('\n')).not.toContain('new messages below');
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });

  it('hostile incoming text is drawn inert (no clipboard, no title, no cursor move)', async () => {
    const s = await openChat();
    try {
      s.signal('SIGUSR2');
      await s.waitForText('LIVE_WHILE_SCROLLED');
      s.signal('SIGUSR2');
      await s.waitForText('HOSTILE_B');
      const scr = s.screen();
      const line = scr.find((l) => l.includes('HOSTILE_A')) ?? '';
      expect(line).toContain('HOSTILE_B');
      expect(line).not.toContain('\u202e');
      expect(s.clipboardWrites).toEqual([]);
      expect(s.titles).toEqual([]);
      expect(scr[0]).toMatch(/global/i);
      expect(row(s, 1)).not.toMatch(/^.HOSTILE/);
      expect(inputRow(s)).toBe('>');
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });

  it('Ctrl+C leaves and restores the REPL', async () => {
    const s = await openChat();
    try { await leaveAndCheckRepl(s, '\x03'); } finally { s.dispose(); }
  });

  it('an Esc split from the rest of a PgUp sequence is not read as leave', async () => {
    const s = await openChat();
    try {
      s.type('\x1b');
      await s.sleep(5);
      s.type('[5~');
      await s.waitFor(() => !s.screen().join('\n').includes('BACKLOG_29'), 'scrolled up, still open');
      expect(s.events().some((e) => e['ev'] === 'closed')).toBe(false);
      expect(s.term.buffer.active.type).toBe('alternate');
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });

  it('an Esc split from a bracketed paste is not read as leave', async () => {
    const s = await openChat();
    try {
      s.type('\x1b');
      await s.sleep(5);
      s.type('[200~pasted\x1b[201~');
      await s.waitFor(() => inputRow(s) === '> pasted', 'paste landed, still open');
      expect(s.events().some((e) => e['ev'] === 'closed')).toBe(false);
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });

  it('a resize while open repaints at the new size', async () => {
    const s = await openChat();
    try {
      s.type('resize me');
      await s.waitFor(() => inputRow(s) === '> resize me', 'typed');
      await s.resize(50, 16);
      await s.waitFor(() => s.screen().length === 16 && inputRow(s) === '> resize me' && /global/i.test(s.screen()[0] ?? ''), 'repainted at 50x16');
      // Outlast the 150ms ResizeBus debounce: REPL footer rows that repaint on
      // resize must not land on the alternate screen.
      await s.sleep(400);
      expect(s.screen().join('\n')).not.toContain('idle');
      expect(inputRow(s)).toBe('> resize me');
      for (const l of s.screen()) expect(displayCols(l.trimEnd())).toBeLessThanOrEqual(50);
      expect(s.screen().join('\n')).toContain('BACKLOG_29');
      expect(s.screen().join('\n')).not.toContain('FOOTERMODEL');
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });

  it('SIGTERM while open restores the terminal (main screen, cursor visible)', async () => {
    const s = await openChat();
    try {
      s.signal('SIGTERM');
      await s.waitForEvent('sigterm-cleaned');
      await s.waitFor(() => s.term.buffer.active.type === 'normal', 'normal buffer after SIGTERM');
      // The exit summary printed by the REPL's own signal path lands on the
      // main screen, not in the discarded alternate buffer.
      expect(s.normalLines().join('\n')).toContain('GOODBYE_SUMMARY');
      expect(s.events().find((e) => e['ev'] === 'sigterm-cleaned')?.['isRaw']).toBe(false);
      const raw = s.raw();
      expect(raw.lastIndexOf('\x1b[?25h')).toBeGreaterThan(raw.lastIndexOf('\x1b[?25l'));
    } finally { s.dispose(); }
  });
});

describe.skipIf(!avail.ok)('global chat first run in a real pty', () => {
  it('notice fits 80x24; n declines without creating an identity', async () => {
    const s = await openChat(80, 24, 'onboard');
    try {
      await s.waitForText('Join? Press y');
      for (const l of s.screen()) expect(displayCols(l.trimEnd())).toBeLessThanOrEqual(80);
      s.type('n');
      const closed = await s.waitForEvent('closed');
      expect(closed['createCalls']).toEqual([]);
      expect(s.events().some((e) => e['ev'] === 'create' || e['ev'] === 'connect')).toBe(false);
      await s.waitFor(() => s.term.buffer.active.type === 'normal', 'normal buffer');
      s.type('back\r');
      expect((await s.waitForEvent('done'))['submitted']).toBe('back');
    } finally { s.dispose(); }
  });

  it('does not ask for consent until the full notice fits', async () => {
    const s = await openChat(40, 12, 'smallnotice');
    try {
      await s.waitForText('Enlarge window to 80x');
      expect(s.screen().join('\n')).not.toContain('Join?');
      s.type('y');
      await s.sleep(100);
      expect(s.screen().join('\n')).toContain('Enlarge window');
      s.type(ESC);
      await s.waitForEvent('closed');
    } finally { s.dispose(); }
  });

  it('y then an invalid name gives feedback; a valid name proceeds into the room', async () => {
    const s = await openChat(80, 24, 'onboard');
    try {
      await s.waitForText('Join? Press y');
      s.type('y');
      await s.waitForText('Pick a display name');
      for (const l of s.screen()) expect(displayCols(l.trimEnd())).toBeLessThanOrEqual(80);
      s.type('admin');
      await s.waitForText('reserved');
      s.type('\r');
      await s.waitForText('That name is reserved');
      s.type('\x15griff');
      await s.waitForText('Looks good');
      s.type('\r');
      await s.waitForEvent('connect');
      await s.waitForText('BACKLOG_01');
      expect(s.events().filter((e) => e['ev'] === 'create').map((e) => e['name'])).toEqual(['admin', 'griff']);
      await leaveAndCheckRepl(s, ESC);
    } finally { s.dispose(); }
  });
});
