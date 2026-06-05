/**
 * Tests for src/cli/slash/registry.ts
 *
 * Verifies: registration, alias resolution, unknown-command did-you-mean
 * suggestions, and dispatch wiring.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  register,
  resetRegistry,
  list,
  lookup,
  suggest,
  parse,
  dispatch,
  aliasEntries,
} from './slash/registry.js';
import type { SlashCommand, SlashContext } from './slash/types.js';

function fakeCtx(): SlashContext {
  const lines: string[] = [];
  return {
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
      planMode: false,
    },
    out: {
      line: (t = '') => lines.push(t),
      raw: (t) => lines.push(t),
      success: (t) => lines.push(`success:${t}`),
      info: (t) => lines.push(`info:${t}`),
      warn: (t) => lines.push(`warn:${t}`),
      error: (t) => lines.push(`error:${t}`),
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  };
}

function makeCmd(name: string, handler = vi.fn().mockResolvedValue('continue'), aliases?: string[]): SlashCommand {
  return { name, aliases, summary: `test ${name}`, handler };
}

describe('slash/registry', () => {
  beforeEach(() => resetRegistry());

  describe('register + lookup + list', () => {
    it('registers a command and looks it up by name', () => {
      const cmd = makeCmd('/foo');
      register(cmd);
      expect(lookup('/foo')).toBe(cmd);
    });

    it('looks up by alias', () => {
      const cmd = makeCmd('/exit', undefined, ['/quit']);
      register(cmd);
      expect(lookup('/quit')).toBe(cmd);
    });

    it('list returns commands in sorted order', () => {
      register(makeCmd('/zebra'));
      register(makeCmd('/apple'));
      register(makeCmd('/mango'));
      expect(list().map((c) => c.name)).toEqual(['/apple', '/mango', '/zebra']);
    });

    it('throws on duplicate registration', () => {
      register(makeCmd('/foo'));
      expect(() => register(makeCmd('/foo'))).toThrow(/already registered/);
    });

    it('throws on alias collision', () => {
      register(makeCmd('/exit', undefined, ['/quit']));
      expect(() => register(makeCmd('/stop', undefined, ['/quit']))).toThrow(/collides/);
    });

    it('aliasEntries surfaces aliases with their canonical summary', () => {
      register(makeCmd('/exit', undefined, ['/quit']));
      const entries = aliasEntries();
      expect(entries).toEqual([
        { alias: '/quit', canonical: '/exit', summary: 'test /exit' },
      ]);
    });

    it('aliasEntries returns empty when no aliases registered', () => {
      register(makeCmd('/foo'));
      expect(aliasEntries()).toEqual([]);
    });
  });

  describe('parse', () => {
    it('returns null for non-slash input', () => {
      expect(parse('hello')).toBeNull();
      expect(parse('')).toBeNull();
    });

    it('splits command and args', () => {
      expect(parse('/model sonnet')).toEqual({ name: '/model', args: 'sonnet' });
      expect(parse('/help')).toEqual({ name: '/help', args: '' });
    });

    it('trims whitespace', () => {
      expect(parse('  /cost  ')).toEqual({ name: '/cost', args: '' });
    });
  });

  describe('suggest', () => {
    it('returns the closest command within edit distance', () => {
      register(makeCmd('/cost'));
      register(makeCmd('/tools'));
      expect(suggest('/cot')).toBe('/cost');
    });

    it('returns undefined when nothing is close enough', () => {
      register(makeCmd('/cost'));
      expect(suggest('/xyzabc', 2)).toBeUndefined();
    });
  });

  describe('dispatch', () => {
    it('returns handled: false for non-slash input', async () => {
      const ctx = fakeCtx();
      const out = await dispatch('hello', ctx);
      expect(out.handled).toBe(false);
    });

    it('invokes the handler and returns its SlashResult', async () => {
      const handler = vi.fn().mockResolvedValue('exit');
      register(makeCmd('/exit', handler));
      const ctx = fakeCtx();
      const out = await dispatch('/exit', ctx);
      expect(out.handled).toBe(true);
      expect(out.result).toBe('exit');
      // Third arg is undefined when no attachments provided (command does not acceptsAttachments).
      expect(handler).toHaveBeenCalledWith(ctx, '', undefined);
    });

    it('passes trimmed args to the handler', async () => {
      const handler = vi.fn().mockResolvedValue('continue');
      register(makeCmd('/model', handler));
      const ctx = fakeCtx();
      await dispatch('/model sonnet', ctx);
      // Third arg is undefined when no attachments provided.
      expect(handler).toHaveBeenCalledWith(ctx, 'sonnet', undefined);
    });

    it('emits named warning when attachments passed to a non-accepting command', async () => {
      const handler = vi.fn().mockResolvedValue('continue');
      // makeCmd produces a command without acceptsAttachments
      register(makeCmd('/clear', handler));
      const ctx = fakeCtx();
      const warnSpy = vi.spyOn(ctx.out, 'warn');
      const mockImg = {
        id: 'img-1',
        mediaType: 'image/png' as const,
        bytes: Buffer.from('fake'),
        sizeBytes: 4,
      };
      await dispatch('/clear', ctx, [mockImg]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ignored by /clear'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skill commands'));
    });

    it('forwards attachments to handler when acceptsAttachments: true', async () => {
      const handler = vi.fn().mockResolvedValue('continue');
      const cmd: SlashCommand = {
        name: '/forge',
        summary: 'forge skill',
        acceptsAttachments: true,
        handler,
      };
      register(cmd);
      const ctx = fakeCtx();
      const warnSpy = vi.spyOn(ctx.out, 'warn');
      const mockImg = {
        id: 'img-1',
        mediaType: 'image/png' as const,
        bytes: Buffer.from('fake'),
        sizeBytes: 4,
      };
      await dispatch('/forge', ctx, [mockImg]);
      // No warning emitted for acceptsAttachments: true
      expect(warnSpy).not.toHaveBeenCalled();
      // Attachments forwarded as third arg
      expect(handler).toHaveBeenCalledWith(ctx, '', [mockImg]);
    });

    it('does not warn when no attachments passed to a non-accepting command', async () => {
      const handler = vi.fn().mockResolvedValue('continue');
      register(makeCmd('/cost', handler));
      const ctx = fakeCtx();
      const warnSpy = vi.spyOn(ctx.out, 'warn');
      await dispatch('/cost', ctx, []);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns with did-you-mean for unknown commands close to a known one', async () => {
      register(makeCmd('/cost'));
      const ctx = fakeCtx();
      const warnSpy = vi.spyOn(ctx.out, 'warn');
      const out = await dispatch('/cot', ctx);
      expect(out.handled).toBe(true);
      expect(out.result).toBe('continue');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('did you mean /cost'));
    });

    it('warns with generic hint for far-off unknown commands', async () => {
      register(makeCmd('/cost'));
      const ctx = fakeCtx();
      const warnSpy = vi.spyOn(ctx.out, 'warn');
      await dispatch('/zzz-nothing-close', ctx);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('type /help'));
    });
  });
});
