/**
 * Tests for the /font-size slash command.
 *
 * The command is a thin args-parsing wrapper around the terminal_font_size
 * tool handler. Tests inject a spy handler via the factory seam and assert:
 *   1. arg parsing → correct input passed through
 *   2. non-numeric size → error surfaced, handler NOT called
 *   3. handler errors → ctx.out.error
 *   4. handler successes → ctx.out.success (for set) / ctx.out.line (for get)
 *
 * The handler itself is exhaustively tested in
 * `src/agent/tools/handlers/terminal-font-size.test.ts` — this file does
 * not re-verify discovery, JSONC safety, or file I/O.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ToolHandler, ToolResult } from '../../../agent/tools/types.js';
import type { SlashContext, SessionStats } from '../types.js';
import { createFontSizeCmd } from './font-size.ts';

function makeStats(): SessionStats {
  return {
    totalTurns: 0,
    totalCostUsd: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    sessionStartTime: Date.now(),
    turnCosts: [],
    turnTokens: [],
    turns: [],
    model: 'sonnet',
    permissionMode: 'default',
  };
}

function makeCtx(): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = ''): void => { lines.push(`LINE:${t}`); },
      raw: (t): void => { lines.push(`RAW:${t}`); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

/** Spy handler factory — returns a vi-mocked ToolHandler with configurable result. */
function makeHandler(result: ToolResult): { handler: ToolHandler; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => result);
  return { handler: spy as unknown as ToolHandler, spy };
}

describe('/font-size slash command', () => {
  it('no args → calls handler with action: get and emits result via out.line', async () => {
    const { handler, spy } = makeHandler({ content: 'Cursor: terminal.integrated.fontSize = 14' });
    const cmd = createFontSizeCmd(handler);
    const { ctx, lines } = makeCtx();

    const result = await cmd.handler(ctx, '');

    expect(result).toBe('continue');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual({ action: 'get' });
    expect(lines).toContain('LINE:Cursor: terminal.integrated.fontSize = 14');
  });

  it('numeric size → calls handler with action: set and that size, emits via out.success', async () => {
    const { handler, spy } = makeHandler({ content: 'Updated Cursor to 18' });
    const cmd = createFontSizeCmd(handler);
    const { ctx, lines } = makeCtx();

    const result = await cmd.handler(ctx, '18');

    expect(result).toBe('continue');
    expect(spy.mock.calls[0]![0]).toEqual({ action: 'set', size: 18 });
    expect(lines).toContain('SUCCESS:Updated Cursor to 18');
  });

  it('size + editor → passes editor through to handler', async () => {
    const { handler, spy } = makeHandler({ content: 'Updated VS Code to 14' });
    const cmd = createFontSizeCmd(handler);
    const { ctx } = makeCtx();

    await cmd.handler(ctx, '14 vscode');

    expect(spy.mock.calls[0]![0]).toEqual({ action: 'set', size: 14, editor: 'vscode' });
  });

  it('non-numeric size → emits error and does NOT call handler', async () => {
    const { handler, spy } = makeHandler({ content: 'should not be called' });
    const cmd = createFontSizeCmd(handler);
    const { ctx, lines } = makeCtx();

    const result = await cmd.handler(ctx, 'foo');

    expect(result).toBe('continue');
    expect(spy).not.toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith('ERROR:') && l.includes('Invalid size'))).toBe(true);
  });

  it('handler returns isError → surfaces via out.error', async () => {
    const { handler } = makeHandler({ content: 'Cannot safely update: settings.json has comments', isError: true });
    const cmd = createFontSizeCmd(handler);
    const { ctx, lines } = makeCtx();

    await cmd.handler(ctx, '16');

    expect(lines.some((l) => l.startsWith('ERROR:') && l.includes('Cannot safely update'))).toBe(true);
  });

  it('get with handler error → surfaces via out.error (not out.line)', async () => {
    const { handler } = makeHandler({ content: 'No supported editors found', isError: true });
    const cmd = createFontSizeCmd(handler);
    const { ctx, lines } = makeCtx();

    await cmd.handler(ctx, '');

    expect(lines.some((l) => l.startsWith('ERROR:'))).toBe(true);
    expect(lines.some((l) => l.startsWith('LINE:'))).toBe(false);
  });

  it('command metadata is correct', () => {
    const cmd = createFontSizeCmd();
    expect(cmd.name).toBe('/font-size');
    expect(cmd.summary).toMatch(/terminal font size/i);
    expect(cmd.usage).toBe('/font-size [size] [editor]');
    expect(cmd.hint).toBeDefined();
  });

  it('extra whitespace in args is tolerated', async () => {
    const { handler, spy } = makeHandler({ content: 'ok' });
    const cmd = createFontSizeCmd(handler);
    const { ctx } = makeCtx();

    await cmd.handler(ctx, '   16    cursor   ');

    expect(spy.mock.calls[0]![0]).toEqual({ action: 'set', size: 16, editor: 'cursor' });
  });
});
