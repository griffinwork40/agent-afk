/**
 * Unit tests for the traces aggregator.
 *
 * Strategy: synthetic temp-dir fixture with controlled JSONL + sidecar content.
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
  mkdirSync(join(tmpRoot, 'state', 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeTrace(sessionId: string, lines: string[]): void {
  const dir = join(tmpRoot, 'state', 'witness', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'trace.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

function writeSession(sessionId: string, obj: object): void {
  const dir = join(tmpRoot, 'state', 'sessions');
  writeFileSync(join(dir, `${sessionId}.json`), JSON.stringify(obj), 'utf-8');
}

function makeSession(overrides: Record<string, unknown> = {}): object {
  return {
    sessionId: overrides['sessionId'] ?? 'sess-x',
    model: 'claude-3-5-sonnet',
    startedAt: Date.now() - 1000,
    savedAt: Date.now(),
    totalTurns: 1,
    turns: [],
    ...overrides,
  };
}

const NOW_ISO = new Date().toISOString();

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

function closureEvent(reasonOrCost: string | number, seq = 4): string {
  const reason = typeof reasonOrCost === 'string' ? reasonOrCost : 'model_end_turn';
  const cost = typeof reasonOrCost === 'number' ? reasonOrCost : 0.01;
  return JSON.stringify({
    ts: NOW_ISO,
    seq,
    kind: 'closure',
    payload: {
      reason,
      finalTurnCount: 3,
      finalCostUsd: cost,
      finalTokens: { input: 100, output: 200 },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('aggregateTraces', () => {
  it('no sessions dir → zero aggregates, no throw', () => {
    const result = aggregateTraces({ days: 30, afkHome: '/nonexistent/xyz' });
    expect(result.totalTracedSessions).toBe(0);
    expect(result.compactionCount).toBe(0);
    expect(Object.keys(result.toolCallCounts)).toHaveLength(0);
  });

  it('empty sessions dir → zero aggregates', () => {
    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.totalTracedSessions).toBe(0);
  });

  it('tool_call counts come from facet (sidecar only, no trace needed)', () => {
    writeSession('sess-1', makeSession({
      sessionId: 'sess-1',
      turns: [{ user: 'hi', assistant: 'ok', toolEvents: [
        { toolName: 'bash', toolUseId: 'a', result: 'ok' },
      ] }],
    }));

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.toolCallCounts['bash']).toBe(1);
    expect(result.totalTracedSessions).toBe(1);
  });

  it('tool_call error count comes from facet', () => {
    writeSession('sess-1', makeSession({
      sessionId: 'sess-1',
      turns: [{ user: 'hi', assistant: 'ok', toolEvents: [
        { toolName: 'bash', toolUseId: 'a', isError: true, result: 'err' },
      ] }],
    }));
    // Add trace for duration (error → no duration added)
    writeTrace('sess-1', [toolCallCompleted('bash', true, 50)]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.toolErrorCounts['bash']).toBe(1);
    expect(result.toolDurationsMs['bash']).toBeUndefined();
  });

  it('subagent invocations come from facet (sidecar with agent tool event)', () => {
    writeSession('sess-1', makeSession({
      sessionId: 'sess-1',
      turns: [{ user: 'hi', assistant: 'ok', toolEvents: [
        { toolName: 'agent', toolUseId: 'f1' },
        { toolName: 'agent', toolUseId: 'f2' },
        { toolName: 'agent', toolUseId: 'f3' },
      ] }],
    }));

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    // facet.subagents.length = 3 → incNum(subagentForkDepths, 1, 3)
    expect(result.subagentForkDepths[1]).toBe(3);
  });

  it('successful tool call duration comes from trace fallback', () => {
    writeSession('sess-1', makeSession({ sessionId: 'sess-1' }));
    writeTrace('sess-1', [toolCallCompleted('read_file', false, 123)]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.toolDurationsMs['read_file']).toBe(123);
  });

  it('malformed JSONL line in trace → skipped, no throw', () => {
    writeSession('sess-1', makeSession({ sessionId: 'sess-1' }));
    writeTrace('sess-1', [
      '{ this is not valid json }',
      toolCallCompleted('bash', false, 50),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    // duration still accumulated from the valid line
    expect(result.toolDurationsMs['bash']).toBe(50);
    expect(result.totalTracedSessions).toBe(1);
  });

  it('compaction event → compactionCount incremented', () => {
    writeSession('sess-1', makeSession({ sessionId: 'sess-1' }));
    writeTrace('sess-1', [compactionEvent()]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.compactionCount).toBe(1);
  });

  it('multiple compaction events across sessions → all counted', () => {
    writeSession('sess-1', makeSession({ sessionId: 'sess-1' }));
    writeTrace('sess-1', [compactionEvent(1)]);
    writeSession('sess-2', makeSession({ sessionId: 'sess-2' }));
    writeTrace('sess-2', [compactionEvent(1), compactionEvent(2)]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.compactionCount).toBe(3);
  });

  it('closure reason budget_exceeded → appears in closureReasons map', () => {
    writeSession('sess-1', makeSession({ sessionId: 'sess-1' }));
    writeTrace('sess-1', [closureEvent('budget_exceeded', 1)]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.closureReasons['budget_exceeded']).toBe(1);
  });

  it('multiple closure reasons accumulated', () => {
    writeSession('sess-1', makeSession({ sessionId: 'sess-1' }));
    writeTrace('sess-1', [closureEvent('model_end_turn')]);
    writeSession('sess-2', makeSession({ sessionId: 'sess-2' }));
    writeTrace('sess-2', [closureEvent('budget_exceeded')]);
    writeSession('sess-3', makeSession({ sessionId: 'sess-3' }));
    writeTrace('sess-3', [closureEvent('budget_exceeded')]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.closureReasons['model_end_turn']).toBe(1);
    expect(result.closureReasons['budget_exceeded']).toBe(2);
  });

  it('closure finalTokens + finalCostUsd accumulate (incl. cache split + cost guard)', () => {
    writeSession('sess-1', makeSession({ sessionId: 'sess-1' }));
    writeTrace('sess-1', [closureEvent('model_end_turn')]);
    writeSession('sess-2', makeSession({ sessionId: 'sess-2' }));
    writeTrace('sess-2', [
      JSON.stringify({
        ts: NOW_ISO, seq: 4, kind: 'closure',
        payload: {
          reason: 'model_end_turn', finalTurnCount: 1, finalCostUsd: 0,
          finalTokens: { input: 50, output: 150, cacheRead: 9000, cacheCreation: 300 },
        },
      }),
    ]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.totalInputTokens).toBe(150); // 100 + 50
    expect(result.totalOutputTokens).toBe(350); // 200 + 150
    expect(result.totalCacheReadTokens).toBe(9000);
    expect(result.totalCacheCreationTokens).toBe(300);
    expect(result.totalCostUsd).toBeCloseTo(0.01, 5); // only sess-1 had cost
    expect(result.sessionsWithCost).toBe(1);
  });

  it('session outside window → excluded from counts', () => {
    const oldStart = Date.now() - 40 * 24 * 60 * 60 * 1000;
    writeSession('old-sess', makeSession({ sessionId: 'old-sess', startedAt: oldStart, savedAt: oldStart + 1000 }));
    writeTrace('old-sess', [toolCallCompleted('bash', false, 50)]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.totalTracedSessions).toBe(0);
    expect(result.toolCallCounts['bash']).toBeUndefined();
  });

  it('multiple tools across sessions: counts accumulate correctly', () => {
    writeSession('sess-1', makeSession({
      sessionId: 'sess-1',
      turns: [{ user: 'hi', assistant: 'ok', toolEvents: [
        { toolName: 'bash', toolUseId: 'a' },
        { toolName: 'bash', toolUseId: 'b' },
        { toolName: 'read_file', toolUseId: 'c' },
      ] }],
    }));
    writeSession('sess-2', makeSession({
      sessionId: 'sess-2',
      turns: [{ user: 'hi', assistant: 'ok', toolEvents: [
        { toolName: 'bash', toolUseId: 'd', isError: true },
      ] }],
    }));

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.toolCallCounts['bash']).toBe(3);
    expect(result.toolErrorCounts['bash']).toBe(1);
    expect(result.toolCallCounts['read_file']).toBe(1);
    expect(result.totalTracedSessions).toBe(2);
  });

  it('session with sidecar but no trace.jsonl → toolCallCounts populated from facet', () => {
    writeSession('no-trace', makeSession({
      sessionId: 'no-trace',
      turns: [{ user: 'hi', assistant: 'ok', toolEvents: [
        { toolName: 'bash', toolUseId: 'x', result: 'ok' },
      ] }],
    }));

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.toolCallCounts['bash']).toBe(1);
    expect(result.totalTracedSessions).toBe(1);
  });

  it('sessionsWithCost populated from closure event in trace fallback', () => {
    writeSession('with-cost', makeSession({ sessionId: 'with-cost' }));
    writeTrace('with-cost', [closureEvent(0.05)]);

    const result = aggregateTraces({ days: 30, afkHome: tmpRoot });
    expect(result.sessionsWithCost).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.05);
  });
});
