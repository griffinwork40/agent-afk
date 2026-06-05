/**
 * Tests for TraceWriter implementations.
 *
 * Covers the invariants from `docs/philosophy/afk-contract.md`:
 *
 *   - append-only, ordered by monotonic seq
 *   - serialized concurrent writes
 *   - seal is terminal (post-seal writes reject)
 *   - witness memory full-fidelity preserved for compaction
 *   - sidecar integrity (sha256 + size + path)
 *   - sealed-clean state is distinguishable from sealed-crashed
 */

import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InMemoryTraceWriter,
  NdjsonTraceWriter,
} from './writer.js';
import type { TraceEvent } from './types.js';

async function readTrace(path: string): Promise<TraceEvent[]> {
  const body = await readFile(path, 'utf8');
  return body
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
}

// ---------------------------------------------------------------------------
// NdjsonTraceWriter — file-backed
// ---------------------------------------------------------------------------

describe('NdjsonTraceWriter', () => {
  let traceDir: string;

  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'afk-trace-test-'));
  });

  afterEach(async () => {
    await rm(traceDir, { recursive: true, force: true });
  });

  it('writes events as one JSONL line each with monotonic seq', async () => {
    const writer = new NdjsonTraceWriter({ traceDir });

    await writer.write({
      kind: 'tool_call',
      payload: {
        phase: 'started',
        toolUseId: 't1',
        name: 'bash',
        inputBytes: 42,
      },
    });
    await writer.write({
      kind: 'tool_call',
      payload: {
        phase: 'completed',
        toolUseId: 't1',
        name: 'bash',
        resultBytes: 100,
        isError: false,
        truncated: false,
        durationMs: 12,
      },
    });
    await writer.close();

    const events = await readTrace(writer.getTracePath());
    expect(events).toHaveLength(2);
    expect(events[0]?.seq).toBe(0);
    expect(events[1]?.seq).toBe(1);
    expect(events[0]?.kind).toBe('tool_call');
    expect(events[1]?.kind).toBe('tool_call');
  });

  it('serializes concurrent writes — seq order matches arrival order', async () => {
    const writer = new NdjsonTraceWriter({ traceDir });
    const N = 25;

    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        writer.write({
          kind: 'claim',
          payload: {
            source: `agent-${i}`,
            assertion: `claim ${i}`,
            evidence: [],
            confidence: 0.5,
          },
        }),
      );
    }
    await Promise.all(promises);
    await writer.close();

    const events = await readTrace(writer.getTracePath());
    expect(events).toHaveLength(N);
    // Seq must be strictly increasing and contiguous.
    for (let i = 0; i < N; i++) {
      expect(events[i]?.seq).toBe(i);
    }
  });

  it('seal() writes a session_sealed record and rejects subsequent writes', async () => {
    const writer = new NdjsonTraceWriter({ traceDir });
    await writer.write({
      kind: 'hook_decision',
      payload: { hookEvent: 'PreToolUse', decision: 'block', reason: 'denied' },
    });
    await writer.seal({
      status: 'succeeded',
      finalCostUsd: 0.42,
      finalTurnCount: 3,
      closedAt: new Date().toISOString(),
    });

    const events = await readTrace(writer.getTracePath());
    expect(events).toHaveLength(2);
    expect(events[1]?.kind).toBe('session_sealed');

    await expect(
      writer.write({
        kind: 'claim',
        payload: {
          source: 'x',
          assertion: 'late',
          evidence: [],
          confidence: 0.5,
        },
      }),
    ).rejects.toThrow(/sealed/i);
  });

  it('seal() is idempotent — second call is a no-op', async () => {
    const writer = new NdjsonTraceWriter({ traceDir });
    const sealPayload = {
      status: 'succeeded' as const,
      finalCostUsd: 0,
      finalTurnCount: 0,
      closedAt: new Date().toISOString(),
    };
    await writer.seal(sealPayload);
    await writer.seal(sealPayload);
    const events = await readTrace(writer.getTracePath());
    expect(events.filter((e) => e.kind === 'session_sealed')).toHaveLength(1);
  });

  it('close() without seal leaves the trace unsealed (sealed-crashed state)', async () => {
    const writer = new NdjsonTraceWriter({ traceDir });
    await writer.write({
      kind: 'budget',
      payload: {
        kind: 'monetary',
        runningCostUsd: 0.5,
        maxBudgetUsd: 1.0,
        lastTurnCostUsd: 0.1,
      },
    });
    await writer.close();
    const events = await readTrace(writer.getTracePath());
    expect(events).toHaveLength(1);
    expect(events.some((e) => e.kind === 'session_sealed')).toBe(false);
  });

  it('compaction event writes a sidecar with sha256 + size and embeds the reference', async () => {
    const writer = new NdjsonTraceWriter({ traceDir });
    const preCompactionMessages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];

    await writer.write({
      kind: 'compaction',
      payload: {
        trigger: 'manual',
        preCompactionMessages,
        summary: 'summary text',
        keptTailCount: 1,
        keepLastNConfig: 3,
        messagesBefore: 4,
        messagesAfter: 2,
      },
    });
    await writer.close();

    const events = await readTrace(writer.getTracePath());
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.kind).toBe('compaction');
    if (event?.kind !== 'compaction') throw new Error('unreachable');
    const ref = event.payload.preCompactionMessagesRef;
    expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.sizeBytes).toBeGreaterThan(0);

    // Sidecar must exist and round-trip the original messages.
    const sidecarBody = await readFile(ref.path, 'utf8');
    expect(JSON.parse(sidecarBody)).toEqual(preCompactionMessages);
    expect(Buffer.byteLength(sidecarBody, 'utf8')).toBe(ref.sizeBytes);
  });

  it('compaction sidecar filename embeds seq and is sortable', async () => {
    const writer = new NdjsonTraceWriter({ traceDir });
    for (let i = 0; i < 3; i++) {
      await writer.write({
        kind: 'compaction',
        payload: {
          trigger: 'manual',
          preCompactionMessages: [{ i }],
          summary: `summary-${i}`,
          keptTailCount: 0,
          keepLastNConfig: 3,
          messagesBefore: 1,
          messagesAfter: 0,
        },
      });
    }
    await writer.close();

    const entries = await readdir(traceDir);
    const sidecars = entries.filter((n) => n.endsWith('-pre-compaction.json'));
    expect(sidecars).toHaveLength(3);
    // Sorted lexicographically should match emission order (seq prefix).
    const sorted = [...sidecars].sort();
    expect(sorted[0]?.startsWith('000000-')).toBe(true);
    expect(sorted[1]?.startsWith('000001-')).toBe(true);
    expect(sorted[2]?.startsWith('000002-')).toBe(true);
  });

  it('rejects malformed events at the write boundary', async () => {
    const writer = new NdjsonTraceWriter({ traceDir });
    await expect(
      // @ts-expect-error — intentionally malformed: missing payload fields
      writer.write({ kind: 'tool_call', payload: { phase: 'started' } }),
    ).rejects.toThrow();
    await writer.close();
  });

  it('lazy directory creation — never writes until first event', async () => {
    const subdir = join(traceDir, 'nested', 'session-id');
    const writer = new NdjsonTraceWriter({ traceDir: subdir });
    // No write yet — subdir should not exist.
    await expect(readdir(subdir)).rejects.toThrow();
    await writer.write({
      kind: 'claim',
      payload: {
        source: 'x',
        assertion: 'y',
        evidence: [],
        confidence: 1,
      },
    });
    await writer.close();
    const entries = await readdir(subdir);
    expect(entries).toContain('trace.jsonl');
  });
});

// ---------------------------------------------------------------------------
// InMemoryTraceWriter — test sink
// ---------------------------------------------------------------------------

describe('InMemoryTraceWriter', () => {
  it('accumulates events with monotonic seq', async () => {
    const writer = new InMemoryTraceWriter();
    await writer.write({
      kind: 'abort',
      payload: { origin: 'user_signal', cascadedTo: ['a', 'b'] },
    });
    await writer.write({
      kind: 'closure',
      payload: {
        reason: 'abort',
        finalTurnCount: 2,
        finalCostUsd: 0.1,
        finalTokens: {},
      },
    });
    expect(writer.events).toHaveLength(2);
    expect(writer.events[0]?.seq).toBe(0);
    expect(writer.events[1]?.seq).toBe(1);
  });

  it('rejects post-seal writes', async () => {
    const writer = new InMemoryTraceWriter();
    await writer.seal({
      status: 'succeeded',
      finalCostUsd: 0,
      finalTurnCount: 0,
      closedAt: new Date().toISOString(),
    });
    await expect(
      writer.write({
        kind: 'claim',
        payload: {
          source: 'x',
          assertion: 'y',
          evidence: [],
          confidence: 1,
        },
      }),
    ).rejects.toThrow(/sealed/i);
  });

  it('preserves inline compaction payload via side-channel for tests', async () => {
    const writer = new InMemoryTraceWriter();
    const messages = [{ role: 'user', content: 'hello' }];
    await writer.write({
      kind: 'compaction',
      payload: {
        trigger: 'manual',
        preCompactionMessages: messages,
        summary: 's',
        keptTailCount: 0,
        keepLastNConfig: 3,
        messagesBefore: 1,
        messagesAfter: 0,
      },
    });
    const event = writer.events[0];
    expect(event?.kind).toBe('compaction');
    if (event?.kind !== 'compaction') throw new Error('unreachable');
    const inline = writer.getInlineCompactionPayload(event.seq);
    expect(inline?.preCompactionMessages).toEqual(messages);
    // Persisted form has the reference, not the inline messages.
    expect(event.payload.preCompactionMessagesRef.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('seal appends a session_sealed event and is idempotent', async () => {
    const writer = new InMemoryTraceWriter();
    const sealPayload = {
      status: 'cancelled' as const,
      finalCostUsd: 0.05,
      finalTurnCount: 1,
      closedAt: new Date().toISOString(),
    };
    await writer.seal(sealPayload);
    await writer.seal(sealPayload);
    const sealEvents = writer.events.filter((e) => e.kind === 'session_sealed');
    expect(sealEvents).toHaveLength(1);
  });
});
