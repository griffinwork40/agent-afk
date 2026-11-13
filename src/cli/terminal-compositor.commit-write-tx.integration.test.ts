import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { BackgroundAgentRegistry, BackgroundJob } from '../agent/background-registry.js';
import { TerminalCompositor } from './terminal-compositor.js';
import { CommitWriteTx } from './terminal-compositor.commit-write-tx.js';
import { StatusLine } from './status-line.js';
import { HealthRail } from './health-rail.js';
import { BackgroundStatusBar } from './background-status-bar.js';
import { LoopStageBar } from './commands/interactive/loop-stage.js';
import { SYNC_START, SYNC_END } from './cup-frame-renderer.escapes.js';

class Registry extends EventEmitter {
  list(): readonly BackgroundJob[] {
    return [{
      jobId: 'job', subagentId: 'sub', label: 'BACKGROUND', model: 'test',
      status: 'running', startedAt: Date.now(), result: undefined, endedAt: undefined,
      provenance: 'model',
    }];
  }
}

function recordingTTY(): { stdout: NodeJS.WriteStream; writes: string[] } {
  const writes: string[] = [];
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 }) as unknown as NodeJS.WriteStream;
  stdout.write = ((chunk: unknown, a?: unknown, b?: unknown) => {
    writes.push(String(chunk));
    const callback = typeof a === 'function' ? a : typeof b === 'function' ? b : undefined;
    if (callback) callback();
    return true;
  }) as NodeJS.WriteStream['write'];
  return { stdout, writes };
}

async function commitBytes(transaction: boolean, text: string, anchorRow: number): Promise<string[]> {
  const { stdout, writes } = recordingTTY();
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: false, setRawMode: vi.fn(),
  }) as unknown as NodeJS.ReadStream;
  const status = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
  const registry = new Registry() as unknown as BackgroundAgentRegistry;
  const background = new BackgroundStatusBar(registry, { stream: stdout });
  const loop = new LoopStageBar({ stream: stdout, getExtraRows: () => status.getExtraRows() });
  const health = new HealthRail({ stream: stdout, getExtraRows: () => status.getExtraRows() });
  status.start();
  status.repaint({ model: 'STATUS', cost: 0, tokens: 0, contextPct: 0 });
  status.setExtraRows(3);
  background.start();
  loop.start();
  health.start();
  status.setAfterScrollRestore(() => { background.redraw(); loop.redraw(); health.redraw(); });
  const compositor = new TerminalCompositor({
    stdout, stdin, scrollRegion: status, anchorRow, onCancel: vi.fn(),
    caretBlink: false, captureMode: false, goblinSpinner: false,
  });
  try {
    await compositor.arm();
    compositor.setOverlay('pending paragraph');
    // Stable frame ticks must stay on CupWriteBatcher's existing cheap path.
    const begin = vi.spyOn(CommitWriteTx, 'begin');
    try {
      (compositor as unknown as { repaint(): void }).repaint();
      expect(begin).not.toHaveBeenCalled();
    } finally {
      begin.mockRestore();
    }
    writes.length = 0;
    const bypass = !transaction
      ? vi.spyOn(CommitWriteTx, 'begin').mockReturnValue({ end: () => undefined })
      : undefined;
    try { compositor.commitAbove(text); } finally { bypass?.mockRestore(); }
    return [...writes];
  } finally {
    compositor.disarm();
    health.stop();
    loop.stop();
    background.stop();
    status.stop();
  }
}

function withoutSync(text: string): string {
  return text.split(SYNC_START).join('').split(SYNC_END).join('');
}

describe('real commit write transaction with active scroll guard and footer painters', () => {
  it('batches footer row-count changes without changing their byte order', () => {
    const run = (transaction: boolean): string[] => {
      const { stdout, writes } = recordingTTY();
      const status = new StatusLine({ stream: stdout, force: true, throttleMs: 0 });
      status.start();
      status.repaint({ model: 'STATUS', cost: 0, tokens: 0, contextPct: 0 });
      writes.length = 0;
      const bypass = !transaction
        ? vi.spyOn(CommitWriteTx, 'begin').mockReturnValue({ end: () => undefined })
        : undefined;
      try {
        status.setExtraRows(3);
        return [...writes];
      } finally {
        bypass?.mockRestore();
        status.stop();
      }
    };
    const before = run(false);
    const after = run(true);
    expect(before.length).toBeGreaterThan(1);
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(SYNC_START + before.join('') + SYNC_END);
  });

  it.each([
    ['short block', 'A committed paragraph.\nSecond line.', 1],
    ['banner transition', 'First response after the banner.', 8],
    ['overflow block', Array.from({ length: 40 }, (_, i) => `archive row ${i}`).join('\n'), 1],
  ] as const)('%s is one physical write with byte-identical phase ordering', async (_name, text, anchorRow) => {
    const before = await commitBytes(false, text, anchorRow);
    const after = await commitBytes(true, text, anchorRow);
    expect(before.length).toBeGreaterThan(10);
    expect(after).toHaveLength(1);
    const bytes = after[0]!;
    expect(bytes.startsWith(SYNC_START)).toBe(true);
    expect(bytes.endsWith(SYNC_END)).toBe(true);
    expect(bytes.split(SYNC_START)).toHaveLength(2);
    expect(bytes.split(SYNC_END)).toHaveLength(2);
    expect(withoutSync(bytes)).toBe(withoutSync(before.join('')));
    // Both DECSTBM guards and actual sibling redraws must be in this write.
    expect(bytes).toContain('\x1b[r');
    expect(bytes).toContain('STATUS');
    expect(bytes).toContain('BACKGROUND');
  });
});
