/**
 * Integration tests for the `activeSubagents` lifecycle inside `processEvent`
 * (stream-renderer-process.ts lines 139–147 for addition, 240–247 for removal).
 *
 * Issue #1329: the processEvent path that populates and removes `activeSubagents`
 * entries for the subagent status bar overlay had no integration test coverage.
 *
 * Three behaviors under test:
 *   1. Entry addition: the first event from a new subagent registers an entry in
 *      `activeSubagents` (keyed by subagentId, value contains the agentType label
 *      and initial elapsedMs: 0).
 *   2. Entry removal on `done`: a terminal `done` event removes the entry.
 *   3. Entry removal on `error`: a terminal `error` event also removes the entry.
 *
 * The elapsed ticker (stream-renderer.ts:356–367) reads `activeSubagents` and
 * `subagentStartedAt` every 250 ms. Its correctness is covered indirectly here:
 * a `subagentStartedAt` timestamp must be written when the entry is added (so
 * the ticker can compute elapsedMs), and removed when the entry is deleted.
 *
 * All tests use `forceNonTty: true` so no TerminalCompositor is armed and no real
 * TTY is required — matching the pattern used throughout stream-renderer.test.ts.
 * Private fields are accessed via a typed cast (`as unknown as PrivateRenderer`)
 * following the convention established in stream-renderer-ordering.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { StreamRenderer } from './stream-renderer.js';
import type { Writer } from '../slash/types.js';
import type { OutputEvent, SubagentProgressMeta } from '../../agent/types.js';
import type { SubagentStatusBarSpec } from '../render.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeWriter(): { writer: Writer } {
  const writer: Writer = {
    line() {},
    raw() {},
    success() {},
    info() {},
    warn() {},
    error() {},
  };
  return { writer };
}

/** Minimum event to trigger source-state creation on the first processEvent call. */
function contentEvent(chunk: string): OutputEvent {
  return { type: 'chunk', chunk: { type: 'content', content: chunk } };
}

function doneEvent(): OutputEvent {
  return { type: 'done' };
}

function errorEvent(message: string): OutputEvent {
  return { type: 'error', error: new Error(message) };
}

function subagentMeta(subagentId: string, agentType?: string): SubagentProgressMeta {
  return agentType !== undefined ? { subagentId, agentType } : { subagentId };
}

/**
 * Private field shape needed for assertions.
 *
 * Only the two maps relevant to the subagent status bar are typed here.
 * Adding more private fields would couple the tests too tightly to the
 * implementation; keep it narrow.
 */
type PrivateRenderer = {
  activeSubagents: Map<string, SubagentStatusBarSpec>;
  subagentStartedAt: Map<string, number>;
};

function privateFields(r: StreamRenderer): PrivateRenderer {
  return r as unknown as PrivateRenderer;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('processEvent — activeSubagents status bar lifecycle', () => {
  it('adds an entry to activeSubagents on the first event from a new subagent', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // The first event from 'sub-1' triggers source-state creation and the
    // status bar entry registration (stream-renderer-process.ts:139–147).
    r.process(contentEvent('hello'), subagentMeta('sub-1', 'researcher'));

    const { activeSubagents, subagentStartedAt } = privateFields(r);

    // Entry is present.
    expect(activeSubagents.has('sub-1')).toBe(true);

    // Label matches the provided agentType.
    const entry = activeSubagents.get('sub-1')!;
    expect(entry.label).toBe('researcher');

    // Initial elapsedMs is 0 (the ticker will update it later).
    expect(entry.elapsedMs).toBe(0);

    // A corresponding start timestamp must be stored so the ticker can
    // compute elapsedMs correctly.
    expect(subagentStartedAt.has('sub-1')).toBe(true);
    expect(typeof subagentStartedAt.get('sub-1')).toBe('number');

    await r.dispose();
  });

  it('falls back to subagentId as the label when agentType is absent', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // No agentType — label must fall back to the subagentId.
    r.process(contentEvent('hi'), subagentMeta('my-subagent-id'));

    const entry = privateFields(r).activeSubagents.get('my-subagent-id');
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('my-subagent-id');

    await r.dispose();
  });

  it('does NOT add an entry for orchestrator events (no meta / sourceId = __main__)', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    // Orchestrator event — no meta, so sourceId = ORCHESTRATOR_SOURCE_KEY.
    r.process(contentEvent('orch content'));

    // activeSubagents must remain empty — status bar is for subagents only.
    expect(privateFields(r).activeSubagents.size).toBe(0);

    await r.dispose();
  });

  it('does not duplicate an entry when multiple events arrive from the same subagent', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(contentEvent('first'), subagentMeta('sub-1', 'analyst'));
    r.process(contentEvent('second'), subagentMeta('sub-1', 'analyst'));
    r.process(contentEvent('third'), subagentMeta('sub-1', 'analyst'));

    // Still exactly one entry for 'sub-1'.
    expect(privateFields(r).activeSubagents.size).toBe(1);
    expect(privateFields(r).activeSubagents.has('sub-1')).toBe(true);

    await r.dispose();
  });

  it('removes the entry from activeSubagents on a `done` terminal event', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(contentEvent('working'), subagentMeta('sub-1', 'researcher'));

    // Entry must be present before the terminal event.
    expect(privateFields(r).activeSubagents.has('sub-1')).toBe(true);

    // `done` is the normal completion terminal event
    // (stream-renderer-process.ts:238–247).
    r.process(doneEvent(), subagentMeta('sub-1', 'researcher'));

    const { activeSubagents, subagentStartedAt } = privateFields(r);

    // Entry is gone.
    expect(activeSubagents.has('sub-1')).toBe(false);

    // Corresponding start timestamp is also cleaned up.
    expect(subagentStartedAt.has('sub-1')).toBe(false);

    await r.dispose();
  });

  it('removes the entry from activeSubagents on an `error` terminal event', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(contentEvent('working'), subagentMeta('sub-1', 'analyst'));

    // Entry must be present before the terminal event.
    expect(privateFields(r).activeSubagents.has('sub-1')).toBe(true);

    // `error` is the abort-path terminal event (Ctrl+C / provider failure).
    r.process(errorEvent('aborted'), subagentMeta('sub-1', 'analyst'));

    const { activeSubagents, subagentStartedAt } = privateFields(r);

    // Entry is gone.
    expect(activeSubagents.has('sub-1')).toBe(false);

    // Corresponding start timestamp is also cleaned up.
    expect(subagentStartedAt.has('sub-1')).toBe(false);

    await r.dispose();
  });

  it('removes only the terminated subagent entry when two run in parallel', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(contentEvent('sub-A working'), subagentMeta('sub-A', 'pragmatist'));
    r.process(contentEvent('sub-B working'), subagentMeta('sub-B', 'paranoid'));

    // Both entries must be present.
    expect(privateFields(r).activeSubagents.size).toBe(2);

    // Terminate only sub-A.
    r.process(doneEvent(), subagentMeta('sub-A', 'pragmatist'));

    // sub-A is gone; sub-B is still active.
    expect(privateFields(r).activeSubagents.has('sub-A')).toBe(false);
    expect(privateFields(r).activeSubagents.has('sub-B')).toBe(true);

    // Clean up sub-B.
    r.process(doneEvent(), subagentMeta('sub-B', 'paranoid'));
    expect(privateFields(r).activeSubagents.size).toBe(0);

    await r.dispose();
  });

  it('is idempotent: a second terminal event for the same source is a safe no-op', async () => {
    // Defensive: some abort-chain paths may emit both error and done for the same
    // source. The second terminal event must not throw or corrupt state.
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    r.process(contentEvent('working'), subagentMeta('sub-1', 'analyst'));

    r.process(errorEvent('first abort'), subagentMeta('sub-1', 'analyst'));
    // Entry already gone after first terminal event.
    expect(privateFields(r).activeSubagents.has('sub-1')).toBe(false);

    // Second terminal event must not throw.
    expect(() => {
      r.process(doneEvent(), subagentMeta('sub-1', 'analyst'));
    }).not.toThrow();

    // Map is still empty — no phantom re-insertion.
    expect(privateFields(r).activeSubagents.size).toBe(0);

    await r.dispose();
  });

  it('subagentStartedAt timestamp is set at or before Date.now() on entry creation', async () => {
    const { writer } = makeWriter();
    const r = new StreamRenderer({ out: writer, forceNonTty: true });

    const before = Date.now();
    r.process(contentEvent('hi'), subagentMeta('sub-ts', 'tester'));
    const after = Date.now();

    const ts = privateFields(r).subagentStartedAt.get('sub-ts');
    expect(ts).toBeDefined();
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(after);

    await r.dispose();
  });
});
