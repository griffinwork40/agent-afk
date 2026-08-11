/**
 * Regression tests for #733 — a parent that ends mid-wave sealing the shared
 * trace writer over its live children, silently dropping their terminal rows.
 *
 * The detector these tests assert against is the one that actually finds the
 * bug corpus-wide: **an unmatched `started` in a trace that ALSO contains
 * `session_sealed`**. The intuitive alternative — "a `started` row is the
 * file's last line" — finds only 6 files across 12,252 and would wrongly
 * suggest the gap is nearly closed, because the seal row is written AFTER the
 * orphaned rows, so the `started` is never actually last.
 *
 * Everything here writes to a temp dir. Nothing touches the real `~/.afk`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NdjsonTraceWriter } from './trace/writer.js';
import { emitSubagentLifecycle } from './trace/emit.js';
import { SUBAGENT_DRAIN_TIMEOUT_MS } from './subagent/constants.js';
import { SubagentManager } from './subagent.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'afk-733-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface TraceRow {
  kind: string;
  payload?: { transition?: string; subagentId?: string; reason?: string };
}

function readRows(path: string): TraceRow[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TraceRow);
}

/**
 * The corpus detector: subagentIds with a `started` row and no terminal row,
 * in a trace that contains `session_sealed`.
 */
function orphanedChildren(rows: TraceRow[]): string[] {
  if (!rows.some((r) => r.kind === 'session_sealed')) return [];
  const started = new Set<string>();
  const terminal = new Set<string>();
  for (const r of rows) {
    if (r.kind !== 'subagent_lifecycle') continue;
    const id = r.payload?.subagentId;
    if (id === undefined) continue;
    if (r.payload?.transition === 'started') started.add(id);
    else terminal.add(id);
  }
  return [...started].filter((id) => !terminal.has(id));
}

describe('#733 — terminal rows must be enqueued before the seal', () => {
  it('reproduces the orphan when a child emits AFTER the seal', async () => {
    // This is the pre-fix shape: the parent seals while a child is in flight.
    const writer = new NdjsonTraceWriter({ traceDir: join(root, 'unfixed') });
    await emitSubagentLifecycle(writer, { transition: 'started', subagentId: 'child-1', parentId: 'root', model: 'sonnet' });

    await writer.seal({ reason: 'session_end' });

    // emitSubagentLifecycle swallows the rejection — the caller sees success.
    await expect(
      emitSubagentLifecycle(writer, { transition: 'cancelled', subagentId: 'child-1', source: 'cascade' }),
    ).resolves.toBeUndefined();

    const rows = readRows(writer.getTracePath());
    expect(orphanedChildren(rows)).toEqual(['child-1']);
  });

  it('drains cleanly when the terminal row is enqueued BEFORE the seal', async () => {
    const writer = new NdjsonTraceWriter({ traceDir: join(root, 'fixed') });
    await emitSubagentLifecycle(writer, { transition: 'started', subagentId: 'child-1', parentId: 'root', model: 'sonnet' });

    // What abortAllAndDrain guarantees: the cancelled row enters write() first.
    await emitSubagentLifecycle(writer, {
      transition: 'cancelled',
      subagentId: 'child-1',
      source: 'explicit',
    });
    await writer.seal({ reason: 'session_end' });

    const rows = readRows(writer.getTracePath());
    expect(orphanedChildren(rows)).toEqual([]);

    const cancelled = rows.find(
      (r) => r.kind === 'subagent_lifecycle' && r.payload?.transition === 'cancelled',
    );
    expect(cancelled).toBeDefined();
    // The row carries a reason/source, so the loss is explained, not implied.
    expect(JSON.stringify(cancelled)).toContain('explicit');
    // Ordering: the seal is genuinely last.
    expect(rows[rows.length - 1]?.kind).toBe('session_sealed');
  });

  it('a write merely ENQUEUED before the seal still lands (no await needed)', async () => {
    // This is why awaiting handle.cancel() is sufficient: cancel() enters
    // write() synchronously before its own first await, so the row is queued
    // ahead of the seal even though the emit itself is fire-and-forget.
    const writer = new NdjsonTraceWriter({ traceDir: join(root, 'enqueued') });
    await emitSubagentLifecycle(writer, { transition: 'started', subagentId: 'child-1', parentId: 'root', model: 'sonnet' });

    void emitSubagentLifecycle(writer, { transition: 'cancelled', subagentId: 'child-1', source: 'cascade' });
    await writer.seal({ reason: 'session_end' });

    expect(orphanedChildren(readRows(writer.getTracePath()))).toEqual([]);
  });
});

describe('#733 — the drain bound', () => {
  it('is a named constant matching the background-registry precedent', () => {
    expect(SUBAGENT_DRAIN_TIMEOUT_MS).toBe(5000);
  });

  it('abortAllAndDrain is a fast no-op when no children are in flight', async () => {
    const manager = new SubagentManager({});
    const before = Date.now();
    const result = await manager.abortAllAndDrain('session_end');
    // Must not pay the timeout when there is nothing to wait for — every
    // session close goes through this path, including the overwhelming
    // majority that never dispatched a subagent at all.
    expect(result).toEqual({ drained: 0, timedOut: false });
    expect(Date.now() - before).toBeLessThan(SUBAGENT_DRAIN_TIMEOUT_MS);
  });

  it('resolves rather than rejecting, so a drain failure cannot block the seal', async () => {
    const manager = new SubagentManager({});
    await expect(manager.abortAllAndDrain('session_end')).resolves.toBeDefined();
  });

  it('re-arms the manager root after a reset drain', async () => {
    const manager = new SubagentManager({});
    manager.abortAll('first lifecycle ended');

    await manager.abortAllAndDrain('reset', 'user_signal', undefined, true);

    const internal = manager as unknown as {
      rootController: AbortController;
    };
    expect(internal.rootController.signal.aborted).toBe(false);
  });
});

describe('#733 — the wrong detector would miss this', () => {
  it('"started is the last line" does not fire, because the seal is written after', async () => {
    const writer = new NdjsonTraceWriter({ traceDir: join(root, 'detector') });
    await emitSubagentLifecycle(writer, { transition: 'started', subagentId: 'child-1', parentId: 'root', model: 'sonnet' });
    await writer.seal({ reason: 'session_end' });

    const rows = readRows(writer.getTracePath());
    // The naive detector: last row is a `started`. It is NOT — the seal is.
    expect(rows[rows.length - 1]?.kind).toBe('session_sealed');
    // The correct detector still catches the orphan.
    expect(orphanedChildren(rows)).toEqual(['child-1']);
  });
});
