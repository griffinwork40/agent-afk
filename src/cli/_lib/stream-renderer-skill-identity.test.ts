import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { Writer } from '../slash/types.js';
import { stripAnsi } from '../display.js';

const identity = { name: 'review', purpose: 'Check changes', arguments: 'src/index.ts' };
function writer() {
  const line = vi.fn();
  return { line, raw: line, info: line, warn: line, error: line, success: line } satisfies Writer;
}
afterEach(() => vi.restoreAllMocks());
describe('renderer skill identity', () => {
  it('commits once per invocation without relying on capture deduplication', async () => {
    const out = writer();
    for (let i = 0; i < 2; i++) {
      const renderer = new StreamRenderer({ out, skillIdentity: identity, forceNonTty: true, captureMode: false });
      await renderer.arm();
      await renderer.arm();
      renderer.process({ type: 'done' }, { subagentId: 'child' });
      await renderer.dispose();
      await renderer.dispose();
    }
    const intros = out.line.mock.calls.filter(([line]) => String(line).includes('Check changes'));
    expect(intros).toHaveLength(2);
    expect(intros[0]![0]).toContain('args: src/index.ts');
    expect(intros[0]![0]).not.toContain('\x1b');
  });
  it('paints before arm resolves, survives immediate activity, and restores borrowed idle', async () => {
    const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const compositor = { setOverlay: vi.fn(), commitAbove: vi.fn(), setInputMode: vi.fn(), getOnCancel: vi.fn(), setOnCancel: vi.fn(), setSpinner: vi.fn() };
    const renderer = new StreamRenderer({ out: writer(), skillIdentity: identity, compositor: compositor as unknown as TerminalCompositor, reducedMotion: true });
    try {
      await renderer.arm();
      expect(compositor.setOverlay.mock.lastCall?.[0]).toContain('/review');
      renderer.process({ type: 'progress', progress: { taskId: 't', description: 'Working', totalTokens: 0, toolUses: 1, durationMs: 10 } });
      expect(stripAnsi(compositor.setOverlay.mock.lastCall?.[0] ?? '')).toContain('/review');
      renderer.notifyFirstContent();
      await Promise.resolve();
      expect(compositor.setOverlay.mock.lastCall?.[0]).toContain('/review');
    } finally {
      await renderer.dispose();
      if (stdoutTty) Object.defineProperty(process.stdout, 'isTTY', stdoutTty); else Reflect.deleteProperty(process.stdout, 'isTTY');
      if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty); else Reflect.deleteProperty(process.stdin, 'isTTY');
    }
    expect(compositor.setOverlay.mock.lastCall?.[0]).toBe('');
    expect(compositor.setInputMode.mock.lastCall?.[0]).toBe('idle');
    expect(compositor.setSpinner).not.toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });
});
