/**
 * Tests for the /keys slash command.
 *
 * Covers: (1) registration in the global registry, (2) handler returns
 * 'continue', (3) output contains expected group headings and binding rows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlashContext, SessionStats } from '../types.js';
import { keysCmd } from './keys.js';
import { registerAll } from '../index.js';
import { list } from '../registry.js';

function makeCtx(): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const ctx: SlashContext = {
    session: { current: {} } as unknown as SlashContext['session'],
    stats: {
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
    } satisfies SessionStats,
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t): void => { lines.push(t); },
      success: (t): void => { lines.push(`SUCCESS:${t}`); },
      info: (t): void => { lines.push(`INFO:${t}`); },
      warn: (t): void => { lines.push(`WARN:${t}`); },
      error: (t): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
  return { ctx, lines };
}

describe('/keys slash command', () => {
  it('handler returns continue', async () => {
    const { ctx } = makeCtx();
    const result = await keysCmd.handler(ctx, '');
    expect(result).toBe('continue');
  });

  it('output contains expected group headings', async () => {
    const { ctx, lines } = makeCtx();
    await keysCmd.handler(ctx, '');
    const body = lines.join('\n');
    expect(body).toContain('Navigation');
    expect(body).toContain('Editing');
    expect(body).toContain('History');
    expect(body).toContain('Multi-line');
    expect(body).toContain('Attach');
    expect(body).toContain('Misc');
  });

  it('output contains key binding rows for critical bindings', async () => {
    const { ctx, lines } = makeCtx();
    await keysCmd.handler(ctx, '');
    const body = lines.join('\n');
    expect(body).toContain('ctrl+a');
    expect(body).toContain('ctrl+e');
    expect(body).toContain('ctrl+p');
    expect(body).toContain('shift+enter');
    expect(body).toContain('ctrl+l');
    expect(body).toContain('alt+b');
    expect(body).toContain('alt+f');
  });

  it('documents @ file attachment, ctrl+v paste, and ctrl+x remove', async () => {
    const { ctx, lines } = makeCtx();
    await keysCmd.handler(ctx, '');
    const body = lines.join('\n');
    expect(body).toContain('@<path>');
    expect(body).toContain('ctrl+v');
    expect(body).toContain('ctrl+x');
  });

  it('is registered in the global slash registry', () => {
    registerAll();
    const registered = list();
    expect(registered.some((c) => c.name === '/keys')).toBe(true);
  });

  it('command name starts with / and summary is non-empty', () => {
    expect(keysCmd.name).toBe('/keys');
    expect(keysCmd.summary.length).toBeGreaterThan(0);
  });
});
