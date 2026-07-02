/**
 * Unit tests for the traces aggregator.
 *
 * Strategy: synthetic temp-dir fixture with controlled JSONL content.
 * No real AFK_HOME reads.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateTraces } from './traces.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = join(
    tmpdir(),
    `afk-traces-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tmpRoot, 'state', 'witness'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeTrace(sessionId: string, lines: string[]): void {
  const dir = join(tmpRoot, 'state', 'witness', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'trace.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

const NOW_ISO = new Date().toISOString();

function toolCallStarted(name: string, seq = 0): string {
  return JSON.stringify({
    ts: NOW_ISO,
    seq,
    kind: 'tool_call',
    payload: {
      phase: 'started',
      toolUseId: 'tuid-1',
      name,
      inputBytes: 100,
    },
  });
}

function toolCallCompleted(name: string, isError = false, durationMs = 50, seq = 1): string {
  return JSON.stringify({
    ts: NOW_ISO,
    seq,
    kind: 'tool_call',
    payload: {
      phase: 'completed',
      toolUseId: 'tuid-1',
      name,
      resultBytes: 200,
      isError,
      truncated: false,
      durationMs,
    },
  });
}

function subagentStarted(seq = 2): string {
  return JSON.stringify({
    ts: NOW_ISO,
    seq,
    kind: 'subagent_lifecycle',
    payload: {
      transition: 'started',
      subagentId: 'sub-1',
      parentId: 'parent-1',
      model: 'claude-3-5-sonnet',
    },
  });
}

function compactionEvent(seq = 3): string {
  return JSON.stringify({
    ts: NOW_ISO,
    seq,
    kind: 'compaction',
    payload: {
      trigger: 'turn_count',
      preCompactionMessagesRef: {
        path: 'compaction-0.json',
        sizeBytes: 1000,
        sha256: 'a'.repeat(64),
      },
      summary: 'summary text',
      keptTailCount: 5,
      keepLastNConfig: 5,
      messagesBefore: 20,
      messagesAfter: 5,
    },
  });
}

function closureEvent(reason: string, seq = 4): string {
  return JSON.stringify({
    ts: NOW_ISO,
    seq,
    kind: 'closure',
    payload: {
      reason,
      finalTurnCount: 3,
      finalCostUsd: 0.01,
      finalTokens: { input: 100, output: 200 },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregateTraces', () => {
  it('no witness dir → zero aggregates, no throw', () => {
    const result = aggregateTraces({ days: 30, afkHome: '/nonexistent/xyz' });
    expect(result.totalTracedSessions).toBe(0);
    expect(result.compactionCount).toBe(0);
    expect(Object.keys(result.toolCallCounts)).toHaveLength(0);
  });

  it('empty witness dir → zero aggregates', () => {
    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.totalTracedSessions).toBe(0);
  });

  it('tool_call completed phase → counted in toolCallCounts', () => {
    writeTrace('sess-1', [
      toolCallStarted('bash'),
      toolCallCompleted('bash', false, 100),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.toolCallCounts['bash']).toBe(1);
  });

  it('tool_call started phase → NOT counted (only completed)', () => {
    // Only a 'started' event — no 'completed'
    writeTrace('sess-1', [toolCallStarted('bash')]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.toolCallCounts['bash']).toBeUndefined();
  });

  it('isError: true → error count, not success duration', () => {
    writeTrace('sess-1', [
      toolCallCompleted('bash', true, 50),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.toolCallCounts['bash']).toBe(1);
    expect(result.toolErrorCounts['bash']).toBe(1);
    // Error events don't add to duration sum
    expect(result.toolDurationsMs['bash']).toBeUndefined();
  });

  it('successful tool call → duration added', () => {
    writeTrace('sess-1', [
      toolCallCompleted('read_file', false, 123),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.toolDurationsMs['read_file']).toBe(123);
  });

  it('malformed JSONL line → skipped, no throw', () => {
    writeTrace('sess-1', [
      '{ this is not valid json }',
      toolCallCompleted('bash', false, 50),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    // bash should still be counted from the valid line
    expect(result.toolCallCounts['bash']).toBe(1);
    expect(result.totalTracedSessions).toBe(1);
  });

  it('empty line in JSONL → skipped, no throw', () => {
    writeTrace('sess-1', [
      '',
      toolCallCompleted('bash', false, 50),
      '',
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.toolCallCounts['bash']).toBe(1);
  });

  it('subagent started event → fork depth incremented', () => {
    writeTrace('sess-1', [
      toolCallCompleted('bash', false, 50),
      subagentStarted(),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.subagentForkDepths[1]).toBe(1);
  });

  it('multiple subagent started events → depth count accumulated', () => {
    writeTrace('sess-1', [
      subagentStarted(0),
      subagentStarted(1),
      subagentStarted(2),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.subagentForkDepths[1]).toBe(3);
  });

  it('compaction event → compactionCount incremented', () => {
    writeTrace('sess-1', [
      toolCallCompleted('bash', false, 50, 0),
      compactionEvent(1),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.compactionCount).toBe(1);
  });

  it('multiple compaction events across sessions → all counted', () => {
    writeTrace('sess-1', [
      toolCallCompleted('bash', false, 50, 0),
      compactionEvent(1),
    ]);
    writeTrace('sess-2', [
      toolCallCompleted('grep', false, 30, 0),
      compactionEvent(1),
      compactionEvent(2),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.compactionCount).toBe(3);
  });

  it('closure reason budget_exceeded → appears in closureReasons map', () => {
    writeTrace('sess-1', [
      toolCallCompleted('bash', false, 50, 0),
      closureEvent('budget_exceeded', 1),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.closureReasons['budget_exceeded']).toBe(1);
  });

  it('multiple closure reasons accumulated', () => {
    writeTrace('sess-1', [closureEvent('model_end_turn')]);
    writeTrace('sess-2', [closureEvent('budget_exceeded')]);
    writeTrace('sess-3', [closureEvent('budget_exceeded')]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.closureReasons['model_end_turn']).toBe(1);
    expect(result.closureReasons['budget_exceeded']).toBe(2);
  });

  it('closure finalTokens + finalCostUsd accumulate (incl. cache split + cost guard)', () => {
    // sess-1: closureEvent helper → input 100, output 200, cost 0.01, no cache
    writeTrace('sess-1', [closureEvent('model_end_turn')]);
    // sess-2: richer closure with cache fields and ZERO cost
    writeTrace('sess-2', [
      JSON.stringify({
        ts: NOW_ISO,
        seq: 4,
        kind: 'closure',
        payload: {
          reason: 'model_end_turn',
          finalTurnCount: 1,
          finalCostUsd: 0,
          finalTokens: { input: 50, output: 150, cacheRead: 9000, cacheCreation: 300 },
        },
      }),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.totalInputTokens).toBe(150); // 100 + 50
    expect(result.totalOutputTokens).toBe(350); // 200 + 150
    expect(result.totalCacheReadTokens).toBe(9000); // 0 + 9000
    expect(result.totalCacheCreationTokens).toBe(300); // 0 + 300
    expect(result.totalCostUsd).toBeCloseTo(0.01, 5); // only sess-1 had cost
    expect(result.sessionsWithCost).toBe(1); // sess-2's zero cost not counted
  });

  it('session outside window → excluded from counts', () => {
    // Old timestamp — 40 days ago
    const oldTs = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const oldLine = JSON.stringify({
      ts: oldTs,
      seq: 0,
      kind: 'tool_call',
      payload: {
        phase: 'completed',
        toolUseId: 'tuid-old',
        name: 'bash',
        resultBytes: 100,
        isError: false,
        truncated: false,
        durationMs: 50,
      },
    });

    writeTrace('old-sess', [oldLine]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.totalTracedSessions).toBe(0);
    expect(result.toolCallCounts['bash']).toBeUndefined();
  });

  it('multiple tools across sessions: counts accumulate correctly', () => {
    writeTrace('sess-1', [
      toolCallCompleted('bash', false, 100, 0),
      toolCallCompleted('bash', false, 200, 1),
      toolCallCompleted('read_file', false, 50, 2),
    ]);
    writeTrace('sess-2', [
      toolCallCompleted('bash', true, 30, 0),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.toolCallCounts['bash']).toBe(3);
    expect(result.toolErrorCounts['bash']).toBe(1);
    expect(result.toolCallCounts['read_file']).toBe(1);
    expect(result.totalTracedSessions).toBe(2);
  });
});
