import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import { TerminalCompositor } from '../terminal-compositor.js';
import type { OverlayComposer } from './overlay-composer.js';
import type { Writer } from '../slash/types.js';
import type { OutputEvent } from '../../agent/types.js';
import { stripAnsi } from '../display.js';
import * as terminalSize from '../terminal-size.js';

const identity = { name: 'review', purpose: 'Check changes', arguments: 'src/index.ts' };
const ttyDescriptors = [process.stdout, process.stdin].map(s => Object.getOwnPropertyDescriptor(s, 'isTTY'));
function writer(): Writer {
  const line = vi.fn();
  return { line, raw: line, info: line, warn: line, error: line, success: line };
}
function compositor() {
  return {
    setOverlay: vi.fn(), commitAbove: vi.fn(), setInputMode: vi.fn(),
    getOnCancel: vi.fn(), setOnCancel: vi.fn(), setSpinner: vi.fn(), disarm: vi.fn(),
  };
}
function tool(id: string, path: string): OutputEvent {
  return { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: id, toolName: 'read_file', toolInput: JSON.stringify({ file_path: path }) } };
}
beforeEach(() => {
  for (const stream of [process.stdout, process.stdin]) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
  vi.spyOn(terminalSize, 'getTerminalWidth').mockReturnValue(120);
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
});
afterEach(() => {
  vi.restoreAllMocks();
  [process.stdout, process.stdin].forEach((s, i) => {
    const descriptor = ttyDescriptors[i];
    if (descriptor) Object.defineProperty(s, 'isTTY', descriptor);
    else Reflect.deleteProperty(s, 'isTTY');
  });
});

describe('identity and live tool activity', () => {
  it.each([false, true])('preserves root and child activity in the same frame (direct fallback=%s)', async direct => {
    const c = compositor();
    const renderer = new StreamRenderer({ out: writer(), skillIdentity: identity, compositor: c as unknown as TerminalCompositor, reducedMotion: true });
    try {
      await renderer.arm();
      // Deliberate private seam: bypass OverlayComposer, not the TTY compositor.
      if (direct) (renderer as unknown as { overlayComposer: OverlayComposer | null }).overlayComposer = null;
      renderer.process(tool('root', '/tmp/root-evidence.ts'));
      let frame = stripAnsi(c.setOverlay.mock.lastCall![0]);
      expect(frame).toContain('/review');
      expect(frame).toContain('root-evidence.ts');
      renderer.process(tool('child-tool', '/tmp/child-evidence.ts'), { subagentId: 'child', agentType: 'research-agent' });
      frame = stripAnsi(c.setOverlay.mock.lastCall![0]);
      for (const token of ['/review', 'root-evidence.ts', 'child-evidence.ts']) expect(frame).toContain(token);
      expect(c.commitAbove.mock.calls.filter(([s]) => stripAnsi(s).includes('Check changes'))).toHaveLength(1);
    } finally { await renderer.dispose(); }
    // Pending tools may survive borrow-dispose; the invocation identity must not.
    expect(stripAnsi(c.setOverlay.mock.lastCall![0])).not.toContain('/review');
    expect(c.disarm).not.toHaveBeenCalled();
  });

  it('compares actual direct-fallback and OverlayComposer frames after identical activity', async () => {
    const frames: string[] = [];
    for (const direct of [false, true]) {
      const c = compositor();
      const renderer = new StreamRenderer({ out: writer(), skillIdentity: identity, compositor: c as unknown as TerminalCompositor, reducedMotion: true });
      try {
        await renderer.arm();
        if (direct) (renderer as unknown as { overlayComposer: OverlayComposer | null }).overlayComposer = null;
        renderer.process(tool('root', '/tmp/root-evidence.ts'));
        renderer.process(tool('child-tool', '/tmp/child-evidence.ts'), { subagentId: 'child', agentType: 'research-agent' });
        frames.push(stripAnsi(c.setOverlay.mock.lastCall![0]));
      } finally { await renderer.dispose(); }
    }
    expect(frames[0]).toContain('child-evidence.ts');
    expect(frames[0]).toContain('/review');
    expect(frames[1]).toBe(frames[0]);
  });

  it('commits identity before actual root tool scrollback in plain mode', async () => {
    const out = writer();
    const renderer = new StreamRenderer({ out, skillIdentity: identity, forceNonTty: true });
    try {
      await renderer.arm();
      renderer.process(tool('root', '/tmp/root-evidence.ts'));
      renderer.process({ type: 'chunk', chunk: { type: 'tool_result', toolUseId: 'root', content: 'ok', isError: false } });
      renderer.process({ type: 'done' });
    } finally { await renderer.dispose(); }
    const lines = vi.mocked(out.line).mock.calls.map(([s]) => stripAnsi(s ?? ''));
    const intro = lines.findIndex(s => s.includes('Check changes'));
    const activity = lines.findIndex(s => s.includes('root-evidence.ts'));
    expect(intro).toBeGreaterThanOrEqual(0);
    expect(activity).toBeGreaterThan(intro);
    expect(lines.filter(s => s.includes('Check changes'))).toHaveLength(1);
  });

  it('disarms the owned compositor exactly once and rejects post-disposal activity', async () => {
    const arm = vi.spyOn(TerminalCompositor.prototype, 'arm').mockResolvedValue(undefined);
    const disarm = vi.spyOn(TerminalCompositor.prototype, 'disarm').mockResolvedValue(undefined);
    const overlay = vi.spyOn(TerminalCompositor.prototype, 'setOverlay').mockImplementation(() => {});
    const commit = vi.spyOn(TerminalCompositor.prototype, 'commitAbove').mockImplementation(() => {});
    vi.spyOn(TerminalCompositor.prototype, 'setSpinner').mockImplementation(() => {});
    const renderer = new StreamRenderer({ out: writer(), skillIdentity: identity, reducedMotion: true });
    try {
      await renderer.arm();
      expect(arm).toHaveBeenCalledTimes(1);
      expect(renderer.getCompositor()).toBeInstanceOf(TerminalCompositor);
      renderer.process(tool('root', '/tmp/root-evidence.ts'));
      expect(stripAnsi(overlay.mock.lastCall![0])).toContain('/review');
    } finally { await renderer.dispose(); }
    await renderer.dispose();
    expect(disarm).toHaveBeenCalledTimes(1);
    expect(renderer.getCompositor()).toBeNull();
    const counts = [overlay.mock.calls.length, commit.mock.calls.length];
    renderer.process(tool('late', '/tmp/late.ts'));
    expect([overlay.mock.calls.length, commit.mock.calls.length]).toEqual(counts);
  });
});
