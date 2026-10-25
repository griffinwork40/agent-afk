/**
 * Compositor-level tests for the tmux narrowing-reflow shift
 * (terminal-compositor.reflow-shift.ts): a width-only shrink under tmux
 * rewraps the full-width echo row into 2 rows with the cursor pinned, so every
 * row above the cursor moves UP by N. The compositor must translate its floor
 * and band up by N and drop rows pushed into tmux history.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { __resetCprRttForTests, CPR_REQUEST } from './terminal-compositor.lifecycle.cpr.js';
import { setReflowShiftGateForTests } from './terminal-compositor.reflow-shift.js';
import { formatSubmittedEcho } from './input/echo.js';

interface Internals {
  anchorRow: number | undefined;
  committedBand: string[];
  committedBandTopRow: number;
  lastMeasuredFrameBottom: number;
}

async function setup(anchorRow: number, preLines: number) {
  const stdout = makeMockStdout();
  const stdin = makeMockStdin();
  stdout.rows = 50;
  stdout.columns = 230;
  const writes = collectWrites(stdout);
  const c = new TerminalCompositor({ contentHug: true, stdout, stdin, onCancel: vi.fn(), anchorRow });
  await c.arm();
  vi.advanceTimersByTime(20);
  for (let i = 0; i < preLines; i++) c.commitAbove(`FILLER_${i}`);
  const echo = formatSubmittedEcho({ buffer: 'DUPCHECK hello', promptText: 'afk › ', isTTY: true, terminalWidth: 230 });
  c.commitAbove(echo);
  c.commitAbove('AFTER_LINE');
  vi.advanceTimersByTime(20);
  return { c, stdout, stdin, writes, internals: c as unknown as Internals };
}

/** Width-only shrink, then answer the CPR with the unchanged cursor row (tmux). */
function splitPane(s: Awaited<ReturnType<typeof setup>>): string {
  const row = s.internals.lastMeasuredFrameBottom;
  s.writes.clear();
  s.stdout.columns = 115;
  process.stdout.emit('resize');
  expect(s.writes.all()).toContain(CPR_REQUEST);
  s.stdin.emit('data', Buffer.from(`\x1b[${row};1R`));
  vi.advanceTimersByTime(50);
  return s.writes.all();
}

describe('tmux narrowing-reflow shift (compositor)', () => {
  beforeEach(() => {
    __resetStdinClaimForTests();
    __resetCprRttForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    setReflowShiftGateForTests(null);
    vi.useRealTimers();
  });

  it('banner case: anchorRow 11 → 10, row 10 erased, band repainted from row 10', async () => {
    setReflowShiftGateForTests(() => true);
    const s = await setup(11, 0);
    expect(s.internals.committedBandTopRow).toBe(11);
    const out = splitPane(s);
    expect(s.internals.anchorRow).toBe(10);
    expect(out).toContain('\x1b[10;1H\x1b[2K');
    // Band (rewrapped echo: '▶' fragment first) repainted starting at row 10.
    expect(out).toMatch(/\x1b\[10;1H\x1b\[2K▶/);
    expect(s.internals.committedBandTopRow).toBe(10);
    s.c.disarm();
  });

  it('anchorRow 1: band rows pushed above row 1 are evicted, not repainted', async () => {
    setReflowShiftGateForTests(() => true);
    const s = await setup(1, 0);
    expect(s.internals.committedBandTopRow).toBe(1);
    const out = splitPane(s);
    // The echo's '▶' head fragment went into tmux history: dropped from the model.
    expect(s.internals.committedBand.some((r) => r.startsWith('▶'))).toBe(false);
    expect(out).not.toContain('▶');
    expect(out).toContain('DUPCHECK hello');
    expect(s.internals.anchorRow).toBe(1);
    s.c.disarm();
  });

  it('gate off (no TMUX): behaviour unchanged — floor stays, band repainted at old floor', async () => {
    setReflowShiftGateForTests(() => false);
    const s = await setup(11, 0);
    const out = splitPane(s);
    expect(s.internals.anchorRow).toBe(11);
    expect(out).not.toContain('\x1b[10;1H');
    expect(out).toMatch(/\x1b\[11;1H\x1b\[2K▶/);
    s.c.disarm();
  });

  it('CPR timeout under tmux: no shift (fallback)', async () => {
    setReflowShiftGateForTests(() => true);
    const s = await setup(11, 0);
    s.stdout.columns = 115;
    process.stdout.emit('resize');
    vi.advanceTimersByTime(500);
    expect(s.internals.anchorRow).toBe(11);
    s.c.disarm();
  });

  it('AFK_CENTER_CONTENT 230→115 at anchorRow 1: the echo is never silently dropped', async () => {
    // 65-col margin + 99-col echo = 164 painted cols: tmux splits it into 2
    // rows at 115 and pushes only the first into history, while the model
    // (band width 108, margin excluded) keeps it as 1 row. Evicting that row
    // would lose its visible remainder; the shift must fall back instead.
    const prev = process.env['AFK_CENTER_CONTENT'];
    process.env['AFK_CENTER_CONTENT'] = '1';
    try {
      setReflowShiftGateForTests(() => true);
      const s = await setup(1, 0);
      expect(s.internals.committedBand.some((r) => r.includes('DUPCHECK hello'))).toBe(true);
      splitPane(s);
      expect(s.internals.committedBand.some((r) => r.includes('DUPCHECK hello'))).toBe(true);
      expect(s.internals.committedBand.some((r) => r.includes('AFTER_LINE'))).toBe(true);
      s.c.disarm();
    } finally {
      if (prev === undefined) delete process.env['AFK_CENTER_CONTENT'];
      else process.env['AFK_CENTER_CONTENT'] = prev;
    }
  });

  it('AFK_CENTER_CONTENT 230→115 at anchorRow 1 with one committed row above echo: leading row evicted, echo survives', async () => {
    // One extra committed row (FILLER_0) sits above the echo in the band.
    // At 230 cols: marginCols=65, FILLER painted=73, echo painted≈164.
    // tmux at 115: FILLER→1 fragment (hist=1), echo→2 fragments.
    // hist=1 == FILLER's fragment count → wholeRowsInHistory returns evict=1.
    // FILLER_0 is dropped from the model; echo (and its content) survives.
    vi.stubEnv('AFK_CENTER_CONTENT', '1');
    try {
      setReflowShiftGateForTests(() => true);
      const s = await setup(1, 1);
      expect(s.internals.committedBand.some((r) => r.includes('FILLER_0'))).toBe(true);
      expect(s.internals.committedBand.some((r) => r.includes('DUPCHECK hello'))).toBe(true);
      splitPane(s);
      // Leading row evicted into tmux history — gone from the model.
      expect(s.internals.committedBand.some((r) => r.includes('FILLER_0'))).toBe(false);
      // Echo row straddles the history boundary — its visible tail survives.
      expect(s.internals.committedBand.some((r) => r.includes('DUPCHECK hello'))).toBe(true);
      // anchorRow clamps to 1 (max(1, 1-1)=1).
      expect(s.internals.anchorRow).toBe(1);
      s.c.disarm();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('AFK_CENTER_CONTENT, banner case (band on screen): shift still applies, nothing evicted', async () => {
    const prev = process.env['AFK_CENTER_CONTENT'];
    process.env['AFK_CENTER_CONTENT'] = '1';
    try {
      setReflowShiftGateForTests(() => true);
      const s = await setup(11, 0);
      const before = s.internals.committedBand.length;
      splitPane(s);
      expect(s.internals.anchorRow).toBe(10);
      expect(s.internals.committedBand.some((r) => r.includes('DUPCHECK hello'))).toBe(true);
      expect(s.internals.committedBand.length).toBeGreaterThanOrEqual(before);
      s.c.disarm();
    } finally {
      if (prev === undefined) delete process.env['AFK_CENTER_CONTENT'];
      else process.env['AFK_CENTER_CONTENT'] = prev;
    }
  });

  it('top-pinned terminal (cursor moved down N) under the gate: no shift', async () => {
    setReflowShiftGateForTests(() => true);
    const s = await setup(11, 0);
    const row = s.internals.lastMeasuredFrameBottom;
    s.stdout.columns = 115;
    process.stdout.emit('resize');
    s.stdin.emit('data', Buffer.from(`\x1b[${row + 1};1R`));
    // Net shift above the cursor is delta − N = 0: the floor stays at 11.
    expect(s.internals.anchorRow).toBe(11);
    vi.advanceTimersByTime(50);
    expect(s.internals.anchorRow).toBe(11);
    s.c.disarm();
  });
});
