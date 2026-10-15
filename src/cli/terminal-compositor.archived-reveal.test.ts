import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Terminal } from '@xterm/headless';
import { TerminalCompositor } from './terminal-compositor.js';
import { hiddenArchivedRows, resetArchivedReveal } from './terminal-compositor.archived-reveal.js';
import { repositionCommittedBand } from './terminal-compositor.committed-band-repin.js';
import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';
import { reshownArchivedRows, mergeSeamBuffer } from './_lib/testing/scrollback-seam.js';

async function rig(rows = 62) {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { isTTY: true, rows, columns: 80 });
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, { isTTY: true, isRaw: false, setRawMode: vi.fn() });
  const chunks: string[] = [];
  stdout.on('data', (d) => chunks.push(String(d)));
  const c = new TerminalCompositor({ stdout, stdin, contentHug: true, anchorRow: 1, onCancel: vi.fn(),
    scrollRegion: {
      withFullScrollRegion<T>(fn: () => T): T {
        stdout.write('\x1b[s\x1b[r\x1b[u');
        try { return fn(); } finally { stdout.write(`\x1b[s\x1b[1;${stdout.rows}r\x1b[u`); }
      }, getExtraRows: () => 0,
    },
  });
  await c.arm();
  const term = new Terminal({ cols: 80, rows, scrollback: 2000, allowProposedApi: true, convertEol: true });
  let fed = 0;
  const repaint = () => (c as unknown as { repaint(): void }).repaint();
  const read = async () => {
    const data = chunks.slice(fed).join(''); fed = chunks.length;
    await new Promise<void>((resolve) => term.write(data, resolve));
    const b = term.buffer.active;
    return Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true).trimEnd() ?? '');
  };
  const markers = Array.from({ length: rows * 2 }, (_, i) => `ROW-${String(i).padStart(4, '0')}`);
  c.commitAbove(`${markers.join('\n')}\n`); repaint();
  return { c, stdout, term, markers, repaint, read, dispose() { c.disarm(); term.dispose(); } };
}

function exactlyOnce(lines: string[], markers: string[]) {
  for (const m of markers) expect(lines.filter((l) => l.includes(m)), `${m}\n${lines.join('\n')}`).toHaveLength(1);
}

describe('archived-prefix reveal episodes', () => {
  it('incremental growth to 20 rows still refills after a large collapse', async () => {
    const r = await rig();
    for (let h = 1; h <= 20; h++) {
      r.c.setOverlay(Array.from({ length: h }, (_, i) => `LIVE-${i}`).join('\n')); r.repaint();
    }
    r.c.setOverlay(''); r.repaint();
    const all = await r.read();
    const overlap = reshownArchivedRows(r.c);
    expect(overlap).toBeGreaterThan(7);
    exactlyOnce(mergeSeamBuffer(all, r.term.buffer.active.baseY, overlap, all.join('\n')), r.markers);
    expect(all[r.term.buffer.active.baseY + 60]).toContain('⎯');
    r.dispose();
  });

  it('small collapse then new commits neither duplicate nor lose rows', async () => {
    const r = await rig(24);
    r.c.setSpinner({ enabled: true }); r.repaint();
    r.c.setSpinner({ enabled: false }); r.repaint();
    r.c.commitAbove('NEW-A\n'); r.repaint();
    r.c.commitAbove('NEW-B\n'); r.repaint();
    const all = await r.read();
    expect(reshownArchivedRows(r.c)).toBe(0);
    exactlyOnce(all, [...r.markers, 'NEW-A', 'NEW-B']);
    r.dispose();
  });

  it('zero-fit erases stale band footprint and records zero painted rows', async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.assign(stdout, { rows: 24, columns: 80 });
    const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    let output = '';
    stdout.on('data', (d) => { output += String(d); });
    await new Promise<void>((resolve) => term.write('\x1b[1;1HOLD\x1b[2;1HOLD', resolve));
    const host = { stdout, placementMode: 'content-hug', committedBand: ['OLD', 'OLD'],
      committedBandArchivedPrefix: 2, committedBandPaintedRows: 2,
      committedBandTopRow: 1, committedBandBottomRow: 2, anchorRow: 1,
      commitInFlight: false, logUpdate: {}, bandGeometryStale: false,
    } as unknown as CommittedBandHost;
    repositionCommittedBand(host, 3, 0, 3);
    await new Promise<void>((resolve) => term.write(output, resolve));
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('');
    expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe('');
    expect(host.committedBandPaintedRows).toBe(0);
    expect(host.committedBandTopRow).toBe(0);
    term.dispose();
  });

  it('threshold oscillation cannot reverse a latched reveal', () => {
    const stdout = { rows: 24, columns: 80 } as NodeJS.WriteStream;
    const host = { stdout, placementMode: 'content-hug' as const, anchorRow: 1,
      committedBand: Array(22).fill('x') as string[], committedBandArchivedPrefix: 6 };
    const atGap = (gap: number) => hiddenArchivedRows(host, { physicalRows: 7 - gap, absoluteBottom: 23 });
    expect(atGap(3)).toBe(6);
    expect(atGap(4)).toBe(0);
    for (const gap of [3, 4, 2, 5, 3]) expect(atGap(gap)).toBe(0);
    resetArchivedReveal(host);
    expect(atGap(3)).toBe(6);
  });

  it('resize while hidden preserves exactly-once history and truthful screen rows', async () => {
    const r = await rig(24);
    r.c.setSpinner({ enabled: true }); r.repaint();
    r.c.setSpinner({ enabled: false }); r.repaint();
    expect(reshownArchivedRows(r.c)).toBe(0);
    await r.read();
    r.stdout.rows = 28; r.term.resize(80, 28); r.stdout.emit('resize');
    await new Promise((resolve) => setTimeout(resolve, 100)); r.repaint();
    const all = await r.read();
    const overlap = reshownArchivedRows(r.c);
    exactlyOnce(mergeSeamBuffer(all, r.term.buffer.active.baseY, overlap, all.join('\n')), r.markers);
    r.dispose();
  });
});
