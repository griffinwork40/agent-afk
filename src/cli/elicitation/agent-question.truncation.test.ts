/**
 * Regression tests: agent `ask_question` text must never be cut off.
 *
 * Covers the three failure modes fixed together:
 *   1. the 512-char clamp on message/context (sanitizeSchemaString) — removed
 *      for agent-origin text;
 *   2. overlay headers counted as logical lines while the renderer wraps at
 *      the terminal width — headers are now pre-wrapped to physical rows, and
 *      a question too tall for the overlay spills to scrollback first;
 *   3. the picker returned the truncated display label as the answer value —
 *      selections now map back to the agent's original choice string.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ElicitationRequest } from '../../agent/types/sdk-types.js';
import { stripEscapeSequences } from '../../utils/terminal-sanitize.js';
import { makeReplElicitationHandler } from '../elicitation-repl.js';
import { displayWidth } from '../display.js';
import { layoutAgentQuestion, MIN_OPTION_ROWS } from './agent-question.layout.js';

const NO_SIGNAL = new AbortController().signal;
const plain = (s: string): string => stripEscapeSequences(s);

function agentRequest(overrides: Partial<ElicitationRequest> = {}): ElicitationRequest {
  return { serverName: 'agent', message: 'Q?', origin: 'agent', type: 'text', ...overrides };
}

/** A long question of distinct words so wrapping and joins are checkable. */
function longText(words: number, tag = 'w'): string {
  return Array.from({ length: words }, (_, i) => `${tag}${i}`).join(' ');
}

/** Rejoin wrapped rows into the original whitespace-normalised text. */
function rejoin(rows: readonly string[]): string {
  return rows.map((r) => plain(r).trim().replace(/^\?\s*/, '')).join(' ').replace(/\s+/g, ' ').trim();
}

describe('layoutAgentQuestion', () => {
  it('keeps a >512-char question whole, wrapped so every header row fits the terminal', () => {
    const message = longText(200); // ~1,000 chars
    const layout = layoutAgentQuestion(agentRequest({ message }), { columns: 80, rows: 200 });
    expect(layout.scrollback).toEqual([]);
    for (const row of layout.header) expect(displayWidth(plain(row))).toBeLessThanOrEqual(80);
    expect(rejoin(layout.header.slice(1, -1))).toBe(message);
    expect(layout.header.join('')).not.toContain('…');
  });

  it('spills to scrollback and shows a compact header when the question would crowd out options', () => {
    const message = longText(400);
    const layout = layoutAgentQuestion(
      agentRequest({ type: 'choice', message, choices: ['a', 'b', 'c', 'd'] }),
      { columns: 80, rows: 24 },
    );
    expect(layout.scrollback.length).toBeGreaterThan(0);
    expect(layout.header.length + 3 + MIN_OPTION_ROWS).toBeLessThanOrEqual(24);
    expect(plain(layout.header.join('\n'))).toContain('full question above');
    const sb = plain(layout.scrollback.join('\n'));
    expect(sb).toContain('w0 ');
    expect(sb).toContain('w399');
    expect(sb).toMatch(/1\. a/);
  });

  it('numbers and shortens long choices to one row, maps labels back to the originals', () => {
    const long = `Option ${'x'.repeat(300)} end`;
    const choices = [long, `${long} B`, 'short'];
    const layout = layoutAgentQuestion(agentRequest({ type: 'choice', choices }), { columns: 80, rows: 40 });
    expect(new Set(layout.options).size).toBe(3);
    layout.options.forEach((label, i) => {
      expect(displayWidth(label)).toBeLessThanOrEqual(70);
      expect(label.startsWith(`${i + 1}. `)).toBe(true);
      expect(layout.choiceFor(label)).toBe(choices[i]);
    });
    // Full choices are recorded in scrollback; question stays in the overlay.
    expect(plain(layout.scrollback.join(''))).toContain(' end B');
    expect(plain(layout.header.join('\n'))).toContain('full choices above');
  });

  it('collision-only: identical choices trigger numbered labels AND spill to scrollback', () => {
    // No choice is wide; they collide only. Before the fix, shortened stayed
    // false so spill was false and scrollback was empty — operator had no way
    // to read the originals.
    const choices = ['Apple', 'Apple', 'Banana'];
    const layout = layoutAgentQuestion(
      agentRequest({ type: 'choice', choices }),
      { columns: 80, rows: 40 },
    );
    // All labels must be numbered to be unique.
    expect(layout.options[0]).toMatch(/^1\. /);
    expect(layout.options[1]).toMatch(/^2\. /);
    expect(layout.options[2]).toMatch(/^3\. /);
    // Scrollback must carry the full original choices.
    expect(layout.scrollback.length).toBeGreaterThan(0);
    const sb = plain(layout.scrollback.join('\n'));
    expect(sb).toContain('Apple');
    expect(sb).toContain('Banana');
    // choiceFor maps numbered labels back to the originals.
    expect(layout.choiceFor(layout.options[0]!)).toBe('Apple');
    expect(layout.choiceFor(layout.options[2]!)).toBe('Banana');
  });

  it('flattens newlines in choice labels so each option is one row', () => {
    const layout = layoutAgentQuestion(
      agentRequest({ type: 'choice', choices: ['line one\nline two'] }),
      { columns: 80, rows: 40 },
    );
    expect(layout.options[0]).toBe('line one line two');
  });

  it('still strips escape sequences from agent text', () => {
    const layout = layoutAgentQuestion(
      agentRequest({ message: 'safe \x1b[2Jcleared \x1b]8;;http://evil\x07link' }),
      { columns: 80, rows: 40 },
    );
    const joined = layout.header.join('\n');
    expect(joined).not.toContain('\x1b[2J');
    expect(joined).not.toContain('evil');
  });
});

describe('renderAgentQuestion — no truncation end-to-end', () => {
  const size = { columns: 80, rows: 24 };

  it('choice: a >128-char choice returns the exact original string', async () => {
    const long = `Use the ${'very '.repeat(40)}long approach`;
    const pickFromList = vi.fn(async (o: { options: readonly string[] }) => [o.options[0]!]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(), writer: { line: () => {} }, pendingCount: () => 0, pickFromList, terminalSize: () => size,
    });
    const result = await handler(agentRequest({ type: 'choice', choices: [long, 'other'] }), { signal: NO_SIGNAL });
    expect(result).toEqual({ action: 'accept', content: { value: long } });
  });

  it('multi_choice: values map back to original strings', async () => {
    const a = `A ${'a'.repeat(200)}`;
    const b = `B ${'b'.repeat(200)}`;
    const pickFromList = vi.fn(async (o: { options: readonly string[] }) => [o.options[0]!, o.options[1]!]);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(), writer: { line: () => {} }, pendingCount: () => 0, pickFromList, terminalSize: () => size,
    });
    const result = await handler(agentRequest({ type: 'multi_choice', choices: [a, b] }), { signal: NO_SIGNAL });
    expect(result).toEqual({ action: 'accept', content: { value: [a, b] } });
  });

  it('a 2,000-char question is written in full to scrollback BEFORE the overlay opens', async () => {
    const message = longText(400);
    const events: string[] = [];
    const lines: string[] = [];
    const readTextOverlay = vi.fn(async (o: { header: readonly string[] }) => {
      events.push('overlay');
      expect(o.header.length + 3 + MIN_OPTION_ROWS).toBeLessThanOrEqual(size.rows);
      return 'answer';
    });
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: (t = '') => { events.push('line'); lines.push(t); } },
      pendingCount: () => 0,
      readTextOverlay,
      terminalSize: () => size,
    });
    const result = await handler(agentRequest({ type: 'text', message }), { signal: NO_SIGNAL });
    expect(result).toEqual({ action: 'accept', content: { value: 'answer' } });
    expect(events.indexOf('line')).toBeLessThan(events.indexOf('overlay'));
    const sb = rejoin(lines.filter((l) => !plain(l).includes('Agent question') && !plain(l).includes('✓')));
    expect(sb).toBe(message);
  });

  it('duplicate choices produce distinct numbered labels that map back to the right value', async () => {
    const layout = layoutAgentQuestion(
      agentRequest({ type: 'choice', choices: ['a', 'a'] }),
      { columns: 80, rows: 40 },
    );
    // Both labels must be distinct (numbered) so the picker can tell them apart.
    expect(layout.options[0]).toBe('1. a');
    expect(layout.options[1]).toBe('2. a');
    expect(new Set(layout.options).size).toBe(2);
    // Each label maps back to the correct original value.
    expect(layout.choiceFor('1. a')).toBe('a');
    expect(layout.choiceFor('2. a')).toBe('a');
  });

  it('wide characters (CJK/emoji) are counted by display width, not code-unit length', () => {
    // Each CJK character is 2 display columns wide; 40 chars = 80 cols → fits
    // exactly in one row at columns=80.  One extra character forces wrapping.
    const cjk40 = '你'.repeat(40);
    const layout40 = layoutAgentQuestion(
      agentRequest({ message: cjk40 }),
      { columns: 80, rows: 40 },
    );
    // 80-col message should fit in one question row (plus prefix) without spill.
    expect(layout40.scrollback).toEqual([]);
    for (const row of layout40.header) {
      expect(displayWidth(plain(row))).toBeLessThanOrEqual(80);
    }

    // An emoji choice wider than the available option columns triggers numbering.
    const emoji = '🎉'.repeat(50); // 100 display cols > 80 - OPTION_PREFIX_COLS
    const layoutEmoji = layoutAgentQuestion(
      agentRequest({ type: 'choice', choices: [emoji, 'plain'] }),
      { columns: 80, rows: 40 },
    );
    // Shortened → numbered labels.
    expect(layoutEmoji.options[0]!.startsWith('1. ')).toBe(true);
    // Each option label must fit within the terminal width.
    for (const label of layoutEmoji.options) {
      expect(displayWidth(plain(label))).toBeLessThanOrEqual(80);
    }
    // Original value still recoverable.
    expect(layoutEmoji.choiceFor(layoutEmoji.options[0]!)).toBe(emoji);
  });

  it('below-20-column terminals always spill to scrollback', () => {
    const layout = layoutAgentQuestion(
      agentRequest({ message: 'Hi', type: 'choice', choices: ['yes', 'no'] }),
      { columns: 15, rows: 40 },
    );
    expect(layout.scrollback.length).toBeGreaterThan(0);
  });

  it('every pre-echo scrollback line event precedes the overlay open event', async () => {
    const message = longText(400);
    const events: Array<'line' | 'overlay'> = [];
    const readTextOverlay = vi.fn(async (o: { header: readonly string[] }) => {
      events.push('overlay');
      expect(o.header.length + 3 + MIN_OPTION_ROWS).toBeLessThanOrEqual(size.rows);
      return 'answer';
    });
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: () => { events.push('line'); } },
      pendingCount: () => 0,
      readTextOverlay,
      terminalSize: () => size,
    });
    await handler(agentRequest({ type: 'text', message }), { signal: NO_SIGNAL });
    const overlayIdx = events.indexOf('overlay');
    expect(overlayIdx).toBeGreaterThan(0);
    // Every 'line' event (there may be several scrollback rows) must come before the overlay.
    for (let i = 0; i < overlayIdx; i++) {
      expect(events[i]).toBe('line');
    }
    // The post-confirm echo line is written after the overlay — exclude it by
    // checking only the pre-overlay segment above; just assert overlay fired once.
    expect(events.filter((e) => e === 'overlay')).toHaveLength(1);
  });

  it('choice: scrollback is written BEFORE the picker overlay opens', async () => {
    // Long choices collide so they spill; writer.line must fire before pickFromList.
    const long = `Option ${'x'.repeat(200)}`;
    const events: string[] = [];
    const pickFromList = vi.fn(async (o: { options: readonly string[] }) => {
      events.push('overlay');
      return [o.options[0]!];
    });
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: (t = '') => { events.push('line'); void t; } },
      pendingCount: () => 0,
      pickFromList,
      terminalSize: () => size,
    });
    await handler(agentRequest({ type: 'choice', choices: [long, `${long} B`] }), { signal: NO_SIGNAL });
    expect(events.indexOf('line')).toBeLessThan(events.indexOf('overlay'));
  });

  it('confirm: scrollback written BEFORE picker when question overflows', async () => {
    const message = longText(400); // tall enough to trigger overflow
    const events: string[] = [];
    const pickFromList = vi.fn(async () => {
      events.push('overlay');
      return ['Yes'];
    });
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(),
      writer: { line: (t = '') => { events.push('line'); void t; } },
      pendingCount: () => 0,
      pickFromList,
      terminalSize: () => size,
    });
    await handler(agentRequest({ type: 'confirm', message }), { signal: NO_SIGNAL });
    expect(events.indexOf('line')).toBeLessThan(events.indexOf('overlay'));
  });

  it('short questions do not write anything to scrollback before the overlay', async () => {
    const lines: string[] = [];
    const pickFromList = vi.fn(async () => ['red']);
    const handler = makeReplElicitationHandler({
      readLine: vi.fn(), writer: { line: (t = '') => lines.push(t) }, pendingCount: () => 0,
      pickFromList, terminalSize: () => size,
    });
    await handler(agentRequest({ type: 'choice', message: 'Pick', choices: ['red', 'blue'] }), { signal: NO_SIGNAL });
    expect(lines.map(plain)).toEqual(['  ✓ red']);
  });

  it('non-TTY fallback prints the full question and full numbered choices', async () => {
    const message = longText(150);
    const choice = `C ${'c'.repeat(300)}`;
    const lines: string[] = [];
    const handler = makeReplElicitationHandler({
      readLine: vi.fn().mockResolvedValueOnce('1'),
      writer: { line: (t = '') => lines.push(t) },
      pendingCount: () => 0,
    });
    const result = await handler(agentRequest({ type: 'choice', message, choices: [choice] }), { signal: NO_SIGNAL });
    const out = plain(lines.join('\n'));
    expect(out).toContain(message);
    expect(out).toContain(choice);
    expect(result).toEqual({ action: 'accept', content: { value: choice } });
  });
});
