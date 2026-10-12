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
