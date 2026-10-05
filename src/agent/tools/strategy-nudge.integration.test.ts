/**
 * Integration tests: StrategyNudger wired into SessionToolDispatcher.
 *
 * Verifies that varied attempts hitting the same error get the nudge on the
 * single-call execute() path and on the batch path, that isError is kept, and
 * that exactly one `strategy_nudge_fired` trace event is emitted.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionToolDispatcher } from './dispatcher.js';
import { builtinToolSchemas } from './schemas.js';
import { InMemoryTraceWriter } from '../trace/writer.js';
import type { ToolCall, ToolHandler } from './types.js';

const ABORT = new AbortController().signal;
let seq = 0;

function testRunCall(): ToolCall {
  seq += 1;
  // Unique input per call so the repeat breaker and repeat-failure guard
  // (both keyed on the call) never fire: this is the varied-attempt case.
  return { id: `t${seq}`, name: 'test_run', input: { name: `case ${seq}` }, signal: ABORT };
}

const failing: ToolHandler = async () => ({
  content: 'FAIL src/x.test.ts\nError: Cannot find module "zod" imported from /repo/src/x.ts',
  isError: true,
});

function makeDispatcher(writer: InMemoryTraceWriter) {
  return new SessionToolDispatcher({
    handlers: new Map<string, ToolHandler>([['test_run', failing]]),
    schemas: [...builtinToolSchemas],
    permissions: { allowedTools: ['test_run'] },
    traceWriter: writer,
  });
}

function nudgeEvents(writer: InMemoryTraceWriter) {
  return writer.events.filter(
    (e) => e.kind === 'session_phase' && (e.payload as { phase?: string }).phase === 'strategy_nudge_fired',
  );
}

describe('StrategyNudger integration (dispatcher)', () => {
  let writer: InMemoryTraceWriter;

  beforeEach(() => {
    writer = new InMemoryTraceWriter();
  });

  it('appends the nudge on the second varied attempt via execute()', async () => {
    const d = makeDispatcher(writer);
    const first = await d.execute(testRunCall());
    expect(first.content).not.toContain('[strategy-nudge]');
    const second = await d.execute(testRunCall());
    expect(second.isError).toBe(true);
    expect(second.content).toContain('[strategy-nudge]');
    expect(second.content).toContain('even though the attempts differed');
    const third = await d.execute(testRunCall());
    expect(third.content).not.toContain('[strategy-nudge]');
    await new Promise((r) => setTimeout(r, 0));
    expect(nudgeEvents(writer)).toHaveLength(1);
  });

  it('nudges exactly once across a multi-call batch', async () => {
    const d = makeDispatcher(writer);
    const results = await d.executeBatch([testRunCall(), testRunCall(), testRunCall()]);
    const nudged = results.filter((r) => r.content.includes('[strategy-nudge]'));
    expect(nudged).toHaveLength(1);
    expect(results.every((r) => r.isError === true)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(nudgeEvents(writer)).toHaveLength(1);
  });
});
