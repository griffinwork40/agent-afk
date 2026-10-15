// Real dispatch helper and renderer; only the provider stream and terminal I/O are faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSkillDispatchTurn } from './run-skill-dispatch-turn.js';
import type { SlashContext } from '../types.js';
import type { OutputEvent } from '../../../agent/types.js';
import { TerminalCompositor } from '../../terminal-compositor.js';
import { stripAnsi } from '../../display.js';

const descriptors = [process.stdout, process.stdin].map(s => Object.getOwnPropertyDescriptor(s, 'isTTY'));
beforeEach(() => {
  for (const s of [process.stdout, process.stdin]) Object.defineProperty(s, 'isTTY', { configurable: true, value: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  [process.stdout, process.stdin].forEach((s, i) => {
    const d = descriptors[i];
    if (d) Object.defineProperty(s, 'isTTY', d);
    else Reflect.deleteProperty(s, 'isTTY');
  });
});

function fixture() {
  const ownerCancel = vi.fn();
  let cancel = ownerCancel;
  let softStop: (() => void) | null = null;
  const c = {
    setOverlay: vi.fn(), commitAbove: vi.fn(), setInputMode: vi.fn(), setSpinner: vi.fn(),
    getOnCancel: () => cancel,
    setOnCancel: vi.fn((fn: () => void) => { cancel = fn; }),
    disarm: vi.fn(),
  };
  const interrupt = vi.fn().mockResolvedValue(undefined);
  const sendMessageStream = vi.fn<() => AsyncIterable<OutputEvent>>();
  const line = vi.fn();
  const ctx: SlashContext = {
    session: { current: { interrupt, sendMessageStream } } as unknown as SlashContext['session'],
    stats: { totalTurns: 0, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0, sessionStartTime: Date.now(), turnCosts: [], turnTokens: [], turns: [], model: 'sonnet', permissionMode: 'default' },
    out: { line, raw: line, info: line, error: line, warn: line, success: line },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
    getCompositor: () => c as unknown as TerminalCompositor,
    setSoftStopHandler: vi.fn(fn => { softStop = fn; }),
  };
  return { ctx, c, interrupt, sendMessageStream, ownerCancel, cancel: () => cancel(), softStop: () => softStop!() };
}
const params = {
  skillName: 'review', args: 'src/index.ts',
  skillMeta: { name: 'review', description: 'Check changes', handler: async () => undefined },
};
const activity: OutputEvent = { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 'root', toolName: 'read_file', toolInput: 'src/index.ts' } };
function expectCleanup(f: ReturnType<typeof fixture>) {
  // In-flight tool rows are retained by disposal; identity and input ownership reset.
  expect(stripAnsi(f.c.setOverlay.mock.lastCall![0])).not.toContain('/review');
  expect(f.c.setSpinner).toHaveBeenLastCalledWith({ enabled: false });
  expect(f.c.setInputMode.mock.lastCall![0]).toBe('idle');
  expect(f.c.setOnCancel.mock.lastCall![0]).toBe(f.ownerCancel);
  expect(f.ctx.setSoftStopHandler).toHaveBeenLastCalledWith(null);
  expect(f.c.disarm).not.toHaveBeenCalled();
  expect(f.ctx.stats.totalTurns).toBe(0);
  const intros = f.c.commitAbove.mock.calls.filter(([s]) => stripAnsi(s).includes('Check changes'));
  expect(intros).toHaveLength(1);
  expect(stripAnsi(intros[0]![0])).toContain('src/index.ts');
}

describe('identity-bearing dispatch abnormal exits', () => {
  it('propagates a provider exception and disposes the actual borrowed renderer', async () => {
    const f = fixture();
    const failure = new Error('provider stream failed');
    f.sendMessageStream.mockImplementation(async function* () {
      yield activity;
      expect(stripAnsi(f.c.setOverlay.mock.lastCall![0])).not.toContain('/review'); // intro is scrollback-only
      expect(stripAnsi(f.c.setOverlay.mock.lastCall![0])).toContain('read_file');
      throw failure;
    });
    await expect(runSkillDispatchTurn(f.ctx, params)).rejects.toBe(failure);
    expectCleanup(f);
  });

  it.each(['cancel', 'softStop'] as const)('routes %s during a real stream to interrupt and cleans up', async kind => {
    const f = fixture();
    let closed = false;
    f.sendMessageStream.mockImplementation(async function* () {
      try {
        yield activity;
        expect(stripAnsi(f.c.setOverlay.mock.lastCall![0])).not.toContain('/review'); // intro is scrollback-only
        expect(stripAnsi(f.c.setOverlay.mock.lastCall![0])).toContain('read_file');
        f[kind]();
        expect(f.interrupt).toHaveBeenCalledTimes(1);
        // The cancellation-aware fake provider ends; soft-stop must additionally
        // reject an already-queued assistant event at the dispatch loop boundary.
        if (kind === 'softStop') yield { type: 'message', message: { role: 'assistant', content: 'MUST NOT RENDER' } } as OutputEvent;
      } finally { closed = true; }
    });
    await expect(runSkillDispatchTurn(f.ctx, params)).resolves.toBe('');
    expect(closed).toBe(true);
    expectCleanup(f);
    expect(JSON.stringify(f.c.commitAbove.mock.calls)).not.toContain('MUST NOT RENDER');
    expect(JSON.stringify(f.c.setOverlay.mock.calls)).not.toContain('MUST NOT RENDER');
    expect(f.ownerCancel).not.toHaveBeenCalled();
  });
});
