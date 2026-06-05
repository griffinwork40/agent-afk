import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { BackgroundStatusBar } from './background-status-bar.js';
import { BackgroundTaskManager } from './commands/interactive/background.js';
import type {
  BackgroundAgentRegistry,
  BackgroundJob,
  BackgroundRegistryEvents,
} from '../agent/background-registry.js';

// ---------------------------------------------------------------------------
// Minimal fake BackgroundAgentRegistry for testing — extends the same
// EventEmitter base the real class uses so event wiring works identically.
// list() returns the internal jobs array so repaint() can read running jobs.
// ---------------------------------------------------------------------------
class FakeRegistry
  extends EventEmitter<BackgroundRegistryEvents>
  implements Pick<BackgroundAgentRegistry, 'list'>
{
  private jobs: BackgroundJob[] = [];

  list(): readonly BackgroundJob[] {
    return this.jobs;
  }

  fireStarted(job: BackgroundJob): void {
    this.jobs.push(job);
    this.emit('started', job);
  }

  fireSettled(job: BackgroundJob): void {
    // Update the stored job to terminal status so list() reflects it.
    const idx = this.jobs.findIndex((j) => j.jobId === job.jobId);
    if (idx >= 0) this.jobs[idx] = job;
    this.emit('settled', job);
  }
}

function makeJob(id: string, status: BackgroundJob['status'] = 'running'): BackgroundJob {
  return {
    jobId: id,
    subagentId: `subagent-${id}`,
    label: `agent-${id}`,
    model: 'claude-3-5-haiku-20241022',
    status,
    startedAt: Date.now(),
    result: undefined,
    endedAt: undefined,
  };
}

function makeMockStream(): NodeJS.WriteStream {
  return {
    columns: 80,
    rows: 24,
    isTTY: true,
    write: vi.fn(),
  } as unknown as NodeJS.WriteStream;
}

describe('BackgroundStatusBar', () => {
  let manager: BackgroundTaskManager;

  beforeEach(() => {
    manager = new BackgroundTaskManager();
  });

  // -------------------------------------------------------------------------
  // Existing tests preserved — opts now passed as 3rd argument
  // -------------------------------------------------------------------------

  it('formats a task line with stats', () => {
    const bar = new BackgroundStatusBar(manager, undefined, {
      stream: { columns: 100, rows: 24, isTTY: true } as NodeJS.WriteStream,
    });
    const task = manager.register('diagnose');
    manager.updateStats(task.id, { tokens: 5000, toolUses: 3 }, 'testing hypothesis 2/4');
    const line = bar.formatTaskLine(task);
    expect(line).toContain('diagnose');
    expect(line).toContain('testing hypothesis 2/4');
    expect(line).toContain('3 tools');
    expect(line).toContain('tok');
  });

  it('formats a task line without progress description', () => {
    const bar = new BackgroundStatusBar(manager, undefined, {
      stream: { columns: 80, rows: 24, isTTY: true } as NodeJS.WriteStream,
    });
    const task = manager.register('mint');
    const line = bar.formatTaskLine(task);
    expect(line).toContain('mint');
    expect(line).toContain('bg-1');
  });

  it('calls row count change handler when tasks change (turn-tasks only)', () => {
    const mockStream = makeMockStream();
    const bar = new BackgroundStatusBar(manager, undefined, {
      stream: mockStream,
      throttleMs: 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    manager.register('test');
    expect(rowHandler).toHaveBeenCalledWith(1);

    bar.stop();
  });

  it('stops cleanly (no registry)', () => {
    const bar = new BackgroundStatusBar(manager);
    bar.start();
    bar.stop();
    // Should not throw on double stop
    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 1. Count reflects turn-tasks only when registry is undefined (backward compat)
  // -------------------------------------------------------------------------
  it('count reflects turn-tasks only when registry is undefined', () => {
    const mockStream = makeMockStream();
    const bar = new BackgroundStatusBar(manager, undefined, {
      stream: mockStream,
      throttleMs: 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    manager.register('task-a');
    manager.register('task-b');

    // Should have been called with 1 then 2
    expect(rowHandler).toHaveBeenLastCalledWith(2);

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 2. Count reflects subagent jobs only when bgManager is empty (registry-only)
  // -------------------------------------------------------------------------
  it('count reflects subagent jobs only when bgManager is empty', () => {
    const mockStream = makeMockStream();
    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    const job = makeJob('j1');
    registry.fireStarted(job);

    expect(rowHandler).toHaveBeenCalledWith(1);

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 3. Mixed: 2 turns running + 3 subagent jobs running → count of 5
  // -------------------------------------------------------------------------
  it('mixed: 2 turn tasks + 3 subagent jobs → row count of 5', () => {
    const mockStream = makeMockStream();
    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    manager.register('task-a');
    manager.register('task-b');

    const j1 = makeJob('j1');
    const j2 = makeJob('j2');
    const j3 = makeJob('j3');
    registry.fireStarted(j1);
    registry.fireStarted(j2);
    registry.fireStarted(j3);

    expect(rowHandler).toHaveBeenLastCalledWith(5);

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 4. Decrement on subagent `settled` event
  // -------------------------------------------------------------------------
  it('decrements count on subagent settled event', () => {
    const mockStream = makeMockStream();
    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    manager.register('task-a');
    manager.register('task-b');

    const j1 = makeJob('j1');
    const j2 = makeJob('j2');
    const j3 = makeJob('j3');
    registry.fireStarted(j1);
    registry.fireStarted(j2);
    registry.fireStarted(j3);

    // 2 turns + 3 subagents = 5
    expect(rowHandler).toHaveBeenLastCalledWith(5);

    // One subagent settles
    const settledJob = { ...j1, status: 'completed' as const };
    registry.fireSettled(settledJob);

    // 2 turns + 2 subagents = 4
    expect(rowHandler).toHaveBeenLastCalledWith(4);

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 5. Decrement on turn `complete` event: existing behavior preserved
  // -------------------------------------------------------------------------
  it('decrements count when a turn task completes', () => {
    const mockStream = makeMockStream();
    const bar = new BackgroundStatusBar(manager, undefined, {
      stream: mockStream,
      throttleMs: 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    const task1 = manager.register('task-a');
    manager.register('task-b');
    expect(rowHandler).toHaveBeenLastCalledWith(2);

    manager.complete(task1.id, 'done', undefined);
    expect(rowHandler).toHaveBeenLastCalledWith(1);

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 6. stop() unsubscribes — emitting started after stop() does NOT change count
  // -------------------------------------------------------------------------
  it('stop() unsubscribes registry — started after stop does not change count', () => {
    const mockStream = makeMockStream();
    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    const j1 = makeJob('j1');
    registry.fireStarted(j1);
    expect(rowHandler).toHaveBeenCalledWith(1);

    bar.stop();
    rowHandler.mockClear();

    // Fire after stop — should be ignored
    const j2 = makeJob('j2');
    registry.fireStarted(j2);
    expect(rowHandler).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 7. 200ms throttle fires at most once per 200ms window
  // -------------------------------------------------------------------------
  it('throttle: scheduleRepaint skips if within throttle window', () => {
    vi.useFakeTimers();
    const mockStream = makeMockStream();
    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 200,
    });
    bar.start();

    // Fire two started events back-to-back within the same ms
    const j1 = makeJob('j1');
    const j2 = makeJob('j2');
    registry.fireStarted(j1);
    // stream.write is called for the first repaint (rowCount changed from 0→1)
    const writeCalls = (mockStream.write as ReturnType<typeof vi.fn>).mock.calls.length;

    registry.fireStarted(j2);
    // Second repaint throttled — no additional writes within the same ms window
    const writeCallsAfter = (mockStream.write as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(writeCallsAfter).toBe(writeCalls);

    bar.stop();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // 8. A registered subagent job shows up as its own row (per-row rendering)
  // -------------------------------------------------------------------------
  it('a registered subagent job renders as its own row', () => {
    const mockStream = makeMockStream();
    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
    });
    bar.start();

    const job = makeJob('j1');
    registry.fireStarted(job);

    // The job label should appear in the written output
    const writes = (mockStream.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('');
    expect(writes).toContain('agent-j1');

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 9. 1 turn-task + 1 subagent job → 2 write rows
  // -------------------------------------------------------------------------
  it('1 turn-task + 1 subagent job → 2 rows written', () => {
    const mockStream = makeMockStream();
    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    manager.register('my-turn');
    const job = makeJob('j1');
    registry.fireStarted(job);

    expect(rowHandler).toHaveBeenLastCalledWith(2);

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 10. A settled subagent job no longer renders (row count drops)
  // -------------------------------------------------------------------------
  it('a settled subagent job no longer renders', () => {
    const mockStream = makeMockStream();
    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    const job = makeJob('j1');
    registry.fireStarted(job);
    expect(rowHandler).toHaveBeenLastCalledWith(1);

    const settled = { ...job, status: 'completed' as const };
    registry.fireSettled(settled);
    expect(rowHandler).toHaveBeenLastCalledWith(0);

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 11. formatJobLine shows elapsed time — metadata only, never result text
  // -------------------------------------------------------------------------
  it('formatJobLine shows label and elapsed time, no result text', () => {
    const bar = new BackgroundStatusBar(manager, undefined, {
      stream: { columns: 80, rows: 24, isTTY: true } as NodeJS.WriteStream,
    });
    const job: BackgroundJob = {
      jobId: 'bg-test-1',
      subagentId: 'sub-x',
      label: 'analyze logs',
      model: 'claude-sonnet',
      status: 'running',
      startedAt: Date.now() - 3000,
      result: undefined,
      endedAt: undefined,
    };

    const line = bar.formatJobLine(job);
    // Label present
    expect(line).toContain('analyze logs');
    // Duration present (3 seconds elapsed)
    expect(line).toMatch(/\ds/);
    // Result text must never appear — job has no result, but guard the invariant
    expect(line).not.toContain('SECRET');
  });

  // -------------------------------------------------------------------------
  // 12. Negative-row guard: job count ≥ terminal rows must not produce row ≤ 0
  //     Regression for: startRow = totalRows - newRowCount going ≤ 0.
  // -------------------------------------------------------------------------
  it('negative-row guard: row addresses stay ≥ 1 when job count ≥ terminal rows', () => {
    // Small terminal: only 3 rows total.
    const mockStream: NodeJS.WriteStream = {
      columns: 80,
      rows: 3,
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
    });
    bar.start();

    // Register 5 subagent jobs — far more than the 3-row terminal can fit.
    for (let i = 1; i <= 5; i++) {
      registry.fireStarted(makeJob(`overflow-${i}`));
    }

    // Collect all ANSI cursor-positioning sequences written.
    const writes = (mockStream.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('');

    // Extract all \x1b[ROW;1H sequences and assert every row number ≥ 1.
    const rowMatches = [...writes.matchAll(/\x1b\[(\d+);1H/g)];
    expect(rowMatches.length).toBeGreaterThan(0); // at least something was written

    for (const m of rowMatches) {
      const row = parseInt(m[1]!, 10);
      expect(row).toBeGreaterThanOrEqual(1);
    }

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 13. H-C1 regression: rowHandler reflects the CLAMPED visible row count,
  //     not the raw item count. Without clamping at the source, setExtraRows
  //     over-reserves rows that can't be painted, and the equality guard in
  //     repaint() fails to trip on SIGWINCH-driven geometry changes (item
  //     count unchanged but clamp changes) — leaving stale rows behind.
  // -------------------------------------------------------------------------
  it('row count change handler receives clamped visible count, not raw item count', () => {
    // Small terminal: only 3 rows total. With 1 status row reserved, only 2
    // rows are paintable.
    const mockStream: NodeJS.WriteStream = {
      columns: 80,
      rows: 3,
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    // Fire 5 jobs into a 3-row terminal — only 2 can be painted.
    for (let i = 1; i <= 5; i++) {
      registry.fireStarted(makeJob(`overflow-${i}`));
    }

    // rowHandler must reflect what's actually painted (2), not raw items.length (5).
    // Previously (unclamped): would have been called with 5 — telling
    // setExtraRows to reserve 5 rows in a 3-row terminal.
    expect(rowHandler).toHaveBeenLastCalledWith(2);

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 14. H-C1 regression: equality guard correctly trips when terminal resize
  //     changes the clamp without changing items.length. Pre-fix, rowCount
  //     stored the raw item count, so resize-induced clamp changes were
  //     skipped, leaving rowHandler stale and the previous paint orphaned.
  // -------------------------------------------------------------------------
  it('equality guard trips when SIGWINCH changes the clamp (item count unchanged)', () => {
    // Start with a generous terminal — all 5 items paintable.
    const mockStream: NodeJS.WriteStream = {
      columns: 80,
      rows: 30,
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    for (let i = 1; i <= 5; i++) {
      registry.fireStarted(makeJob(`job-${i}`));
    }
    // All 5 items fit in 30 rows.
    expect(rowHandler).toHaveBeenLastCalledWith(5);

    // Simulate SIGWINCH: shrink terminal to 3 rows. The bar's resize subscriber
    // calls repaint() directly; trigger an equivalent repaint by mutating
    // stream.rows + firing a registry event (item count unchanged at 5).
    Object.defineProperty(mockStream, 'rows', { value: 3, configurable: true });
    rowHandler.mockClear();
    // Fire a settled event for a job NOT in the list — registry list() returns
    // the same 5 running jobs, so this triggers a repaint without changing
    // item count. With the bug, rowCount stays 5 and rowHandler is never called.
    // With the fix, newRowCount clamps to 2, the equality guard trips, and
    // rowHandler fires with 2.
    registry.fireSettled(makeJob('phantom', 'completed'));

    expect(rowHandler).toHaveBeenCalledWith(2);

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // getAdjacentRows: bg bar paints above the verdict-rail row
  // -------------------------------------------------------------------------

  it('getAdjacentRows=1: bg bar rows are offset above the adjacent row', () => {
    // totalRows=10, adjacentRows=1 → status line at row 10, adjacent at row 9,
    // bg bar item (1 item) at row 8.
    const mockStream: NodeJS.WriteStream = {
      columns: 80,
      rows: 10,
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    const adjacentRows = vi.fn(() => 1);
    const bar = new BackgroundStatusBar(manager, undefined, {
      stream: mockStream,
      throttleMs: 0,
      getAdjacentRows: adjacentRows,
    });
    bar.start();

    manager.register('task-a');

    const writes = (mockStream.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('');

    // Row 8 = totalRows(10) - newRowCount(1) - adjacentRows(1) = 8
    expect(writes).toContain('\x1b[8;1H');
    // Must NOT paint into adjacent row 9 (the verdict rail slot)
    expect(writes).not.toContain('\x1b[9;1H');

    bar.stop();
  });

  it('getAdjacentRows=1: row count change handler receives count clamped against totalRows-1-adjacentRows', () => {
    // totalRows=3, adjacentRows=1 → only 1 paintable bg-bar row (3-1-1=1)
    const mockStream: NodeJS.WriteStream = {
      columns: 80,
      rows: 3,
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
      getAdjacentRows: () => 1,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    // Register 5 items: clamped to 1 (totalRows-1-adjacentRows = 3-1-1 = 1)
    for (let i = 1; i <= 5; i++) {
      registry.fireStarted(makeJob(`j${i}`));
    }

    expect(rowHandler).toHaveBeenLastCalledWith(1);
    bar.stop();
  });

  it('getAdjacentRows=0 (default): behaviour unchanged from pre-adjacent baseline', () => {
    const mockStream = makeMockStream(); // rows=24
    const bar = new BackgroundStatusBar(manager, undefined, {
      stream: mockStream,
      throttleMs: 0,
      getAdjacentRows: () => 0,
    });
    const rowHandler = vi.fn();
    bar.setRowCountChangeHandler(rowHandler);
    bar.start();

    manager.register('task-a');
    manager.register('task-b');
    expect(rowHandler).toHaveBeenLastCalledWith(2);

    bar.stop();
  });

  // -------------------------------------------------------------------------
  // 15. H-C1 bonus: totalRows ≤ 1 yields newRowCount = 0 → early-return
  //     prevents the \x1b[s / \x1b[u escape pair from leaking when no rows
  //     are paintable.
  // -------------------------------------------------------------------------
  it('skips ANSI save/restore escapes when terminal too small to paint any row', () => {
    const mockStream: NodeJS.WriteStream = {
      columns: 80,
      rows: 1, // totalRows - 1 = 0 → no paintable rows
      isTTY: true,
      write: vi.fn(),
    } as unknown as NodeJS.WriteStream;

    const registry = new FakeRegistry();
    const bar = new BackgroundStatusBar(manager, registry as unknown as BackgroundAgentRegistry, {
      stream: mockStream,
      throttleMs: 0,
    });
    bar.start();

    registry.fireStarted(makeJob('j1'));

    const writes = (mockStream.write as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('');

    // No save-cursor escape, no restore-cursor escape, no row-positioning escapes.
    expect(writes).not.toContain('\x1b[s');
    expect(writes).not.toContain('\x1b[u');
    expect(writes).not.toMatch(/\x1b\[\d+;1H/);

    bar.stop();
  });
});
