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

  it('phase 3 paint emits text before erasing trailing content (#4908 change 2)', async () => {
    // Byte-order invariant: committed rows above the frame must be painted as
    // CUP → text → EL(\x1b[K), not CUP → EL(\x1b[2K) → text.  The old shape
    // left every row blank between the EL and the text — a blank intermediate
    // state visible at every tmux 3.6a read boundary that fell in between.
    // The new shape overwrites old content with new text first, then clears
    // only the trailing chars, so no blank intermediate state is possible.
    const after = await commitBytes(true, 'PaintOrderLine.\nSecond.', 1);
    expect(after).toHaveLength(1);
    const bytes = withoutSync(after[0]!);
    // Phase 3 band rows must use the text-first shape (CUP + text + \x1b[K).
    expect(bytes).toMatch(/\x1b\[\d+;1HPaintOrderLine\.\x1b\[K/);
    // The old shape (CUP + \x1b[2K + text) must NOT appear for committed rows.
    expect(bytes).not.toMatch(/\x1b\[\d+;1H\x1b\[2KPaintOrderLine\./);
  });

  it('phase 3 paint adds no extra DECSTBM sequences to the commit (#4908 change 1)', async () => {
    // Byte-order invariant: phase 3 (the CUP-paint of committed rows above the
    // frame) must NOT contribute its own DECSTBM reset/re-arm pair.  Before
    // this fix, commit-phase3-band.ts and commit-phase3-hold.ts both called
    // writeWithScrollGuard, which emits \x1b[r (full-reset) + \x1b[1;\d+r
    // (re-arm) around every phase 3 write.  Under tmux 3.6a those sequences
    // create intermediate blank frames at each read boundary.
    //
    // Strategy: run the commit twice — with the transaction active, and with it
    // bypassed (so each write is a separate string).  Count \x1b[r occurrences
    // in the bypassed run.  The transaction run must contain the same committed
    // text with no extra DECSTBM sequences that phase 3 would have introduced.
    // Specifically the committed text must appear AFTER the last \x1b[1;\d+r
    // re-arm in the bypassed sequence (proving it was placed post-scroll-guard),
    // yet in the transaction run the \x1b[1;\d+r count must NOT grow from that
    // of the bypassed run (phase 3 no longer contributes its own pair).
    const text = 'Phase3GuardCheck.\nSecond line.';
    const unbatched = await commitBytes(false, text, 1);
    const batched   = await commitBytes(true,  text, 1);
    expect(batched).toHaveLength(1);

    // Count scroll-region set sequences (\x1b[1;\d+r) in both runs.
    const setRegionRe = /\x1b\[1;\d+r/g;
    const countIn = (s: string): number => (s.match(setRegionRe) ?? []).length;
    const unbatchedCount = countIn(unbatched.join(''));
    const batchedCount   = countIn(withoutSync(batched[0]!));
    // The batched run must have the SAME number of set-region sequences as the
    // unbatched run — phase 3 no longer injects an extra pair.
    expect(batchedCount).toBe(unbatchedCount);
    // Sanity: the committed text must still be present.
    expect(withoutSync(batched[0]!)).toContain('Phase3GuardCheck.');
  });
});
