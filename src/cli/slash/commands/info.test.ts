/**
 * Tests for the /model slash command's interactive picker + text-arg paths.
 *
 * The picker is exercised against a FakeHost that captures the PickerController
 * installed by runPicker and drives it synchronously (mirrors picker.test.ts).
 * No real compositor and no network — setModel is a spy.
 */

import { describe, it, expect, vi } from 'vitest';
import { infoCommands } from './info.js';
import type { SlashContext, SessionStats } from '../types.js';
import type { PickerController, TerminalCompositor } from '../../terminal-compositor.js';

class FakeHost {
  controller: PickerController | null = null;
  enterCalls = 0;
  exitCalls = 0;

  enterPickerMode(controller: PickerController): void {
    this.enterCalls += 1;
    this.controller = controller;
  }
  exitPickerMode(): void {
    this.exitCalls += 1;
    this.controller = null;
  }
  repaintPicker(): void {}

  press(name: string): void {
    if (!this.controller) throw new Error('FakeHost: no controller installed');
    this.controller.onKey(undefined, { name, ctrl: false, shift: false });
  }
}

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

function makeCtx(withCompositor: boolean): {
  ctx: SlashContext;
  lines: string[];
  setModel: ReturnType<typeof vi.fn>;
  host: FakeHost;
} {
  const lines: string[] = [];
  const setModel = vi.fn(async () => {});
  const host = new FakeHost();
  const ctx = {
    session: {
      current: { setModel, sessionId: undefined } as unknown as SlashContext['session']['current'],
    } as SlashContext['session'],
    stats: makeStats(),
    out: {
      line: (t = ''): void => { lines.push(t); },
      raw: (t: string): void => { lines.push(t); },
      success: (t: string): void => { lines.push(`SUCCESS:${t}`); },
      info: (t: string): void => { lines.push(`INFO:${t}`); },
      warn: (t: string): void => { lines.push(`WARN:${t}`); },
      error: (t: string): void => { lines.push(`ERROR:${t}`); },
    },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    ...(withCompositor ? { getCompositor: (): TerminalCompositor => host as unknown as TerminalCompositor } : {}),
  } as unknown as SlashContext;
  return { ctx, lines, setModel, host };
}

const modelCmd = infoCommands.find((c) => c.name === '/model')!;

describe('/model', () => {
  it('bare /model opens a picker and switches to the selected model (TTY)', async () => {
    const { ctx, setModel, host } = makeCtx(true);
    // current = sonnet (index 6); two downs → haiku (index 8).
    const p = modelCmd.handler(ctx, '');
    host.press('down');
    host.press('down');
    host.press('return');
    await p;

    expect(host.enterCalls).toBe(1);
    expect(host.exitCalls).toBe(1);
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith('haiku');
  });

  it('cancelling the picker (Esc) switches nothing', async () => {
    const { ctx, setModel, host } = makeCtx(true);
    const p = modelCmd.handler(ctx, '');
    host.press('escape');
    await p;

    expect(host.exitCalls).toBe(1);
    expect(setModel).not.toHaveBeenCalled();
  });

  it('/model <name> switches without opening a picker', async () => {
    const { ctx, setModel, host } = makeCtx(true);
    await modelCmd.handler(ctx, 'haiku');

    expect(setModel).toHaveBeenCalledWith('haiku');
    expect(host.enterCalls).toBe(0);
  });

  it('accepts a raw Anthropic wire id, not just short aliases (#548)', async () => {
    const { ctx, setModel } = makeCtx(true);
    await modelCmd.handler(ctx, 'claude-sonnet-5');

    // Previously rejected as "Unknown model" — a full claude- id is now selectable.
    expect(setModel).toHaveBeenCalledWith('claude-sonnet-5');
  });

  it('still rejects a bare typo that matches no alias/tier/provider', async () => {
    const { ctx, setModel, lines } = makeCtx(true);
    await modelCmd.handler(ctx, 'sonnnet');

    expect(setModel).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/Unknown model/);
  });

  it('bare /model on a non-TTY surface prints the current model (no picker)', async () => {
    const { ctx, lines, setModel } = makeCtx(false);
    await modelCmd.handler(ctx, '');

    expect(setModel).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/Current model/);
  });
});
