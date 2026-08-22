/**
 * Regression tests for #731 — a REPL `/resume` silently blacking out the
 * resumed session's witness trace.
 *
 * The bug: the REPL allocated ONE TraceWriter for the whole process and
 * threaded that same instance into the swap-built session. `performResumeSwap`
 * closes the outgoing session (which seals the writer) BEFORE the pointer flip,
 * so the incoming session inherited a sealed writer. `write()` throws on a
 * sealed writer and `emit.ts` swallows the rejection, so every subsequent turn,
 * tool call, and subagent dispatch vanished with no error and no marker.
 *
 * Two properties are covered here, matching the two halves of the fix:
 *   1. The seam itself, against a REAL NdjsonTraceWriter (not a stub): sealing
 *      the outgoing writer must not disable the incoming session's own writer.
 *   2. The `setTraceWriter` cascade: the executors/managers/registry built once
 *      at bootstrap and never rebuilt across a swap must re-point at the live
 *      writer, or post-resume `agent` / skill / compose dispatches keep writing
 *      into the sealed one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NdjsonTraceWriter, type TraceWriter } from '../../../agent/trace/writer.js';
import { AbortGraph } from '../../../agent/abort-graph.js';
import { SubagentManager } from '../../../agent/subagent.js';
import { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
import { SubagentExecutor } from '../../../agent/tools/subagent-executor.js';
import { SkillExecutor } from '../../../agent/tools/skill-executor.js';
import { ComposeExecutor } from '../../../agent/tools/compose-executor.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'afk-731-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeWriter(label: string): NdjsonTraceWriter {
  return new NdjsonTraceWriter({ traceDir: join(tmpRoot, label) });
}

/** A minimal `tool_call` event — enough to exercise the write path. */
function sampleEvent() {
  return {
    kind: 'tool_call' as const,
    payload: {
      phase: 'started' as const,
      toolUseId: 'tu-1',
      name: 'bash',
      inputBytes: 12,
      argsFingerprint: 'a'.repeat(64),
    },
  };
}

describe('#731 — resumed session gets a live writer, not the sealed one', () => {
  it('sealing the outgoing writer does NOT disable the incoming session\'s writer', async () => {
    // The outgoing session owns writer A; the incoming session owns writer B.
    const outgoing = makeWriter('outgoing');
    const incoming = makeWriter('incoming');

    await outgoing.write(sampleEvent());

    // performResumeSwap step 5: closing the outgoing session seals ITS writer.
    await outgoing.seal({ reason: 'session_end' });

    // Pre-fix, incoming === outgoing, so this write threw and was swallowed.
    await expect(outgoing.write(sampleEvent())).rejects.toThrow(/sealed/);
    await expect(incoming.write(sampleEvent())).resolves.toBeUndefined();

    // The incoming session's records are actually on disk, in their own file.
    expect(incoming.getTracePath()).not.toBe(outgoing.getTracePath());
    expect(existsSync(incoming.getTracePath())).toBe(true);
    const body = readFileSync(incoming.getTracePath(), 'utf8');
    expect(body).toContain('"kind":"tool_call"');
  });

  it('a resumed label writes into that session\'s own witness directory', async () => {
    // Resuming session X appends to X's directory — mirrors how a launch-time
    // `--resume` labels its writer in createBootstrapInfra.
    const resumed = makeWriter('resumed-session-id');
    await resumed.write(sampleEvent());
    expect(resumed.getTracePath()).toContain('resumed-session-id');
  });
});

describe('#731 — setTraceWriter cascade re-points long-lived holders', () => {
  it('SubagentManager accepts a new writer for future forks', () => {
    const manager = new SubagentManager({ traceWriter: makeWriter('a') });
    const next = makeWriter('b');
    // Contract: re-pointing never throws and never disturbs in-flight children.
    expect(() => manager.setTraceWriter(next)).not.toThrow();
    expect(() => manager.setTraceWriter(undefined)).not.toThrow();
  });

  it('BackgroundAgentRegistry accepts a new writer', () => {
    const registry = new BackgroundAgentRegistry({ traceWriter: makeWriter('a') });
    expect(() => registry.setTraceWriter(makeWriter('b'))).not.toThrow();
  });

  it('SubagentExecutor re-points its own ctx AND the root manager', () => {
    const setTraceWriter = vi.fn();
    const ctx = {
      subagentManager: { setCwd: vi.fn(), setTraceWriter },
      traceWriter: makeWriter('a') as TraceWriter | undefined,
    };
    const executor = new SubagentExecutor(ctx as never);
    const next = makeWriter('b');

    executor.setTraceWriter(next);

    // Both halves matter: depth-2+ forks read ctx.traceWriter, depth-1 forks
    // are dispatched by the root manager.
    expect(ctx.traceWriter).toBe(next);
    expect(setTraceWriter).toHaveBeenCalledWith(next);
  });

  it('SkillExecutor and ComposeExecutor re-point their ctx writer', () => {
    const skillCtx = { traceWriter: makeWriter('a') as TraceWriter | undefined };
    const composeCtx = { traceWriter: makeWriter('a') as TraceWriter | undefined };
    const next = makeWriter('b');

    new SkillExecutor(skillCtx as never).setTraceWriter(next);
    new ComposeExecutor(composeCtx as never).setTraceWriter(next);

    expect(skillCtx.traceWriter).toBe(next);
    expect(composeCtx.traceWriter).toBe(next);
  });

  it('propagates undefined when tracing is disabled rather than keeping the sealed writer', () => {
    const ctx = { traceWriter: makeWriter('a') as TraceWriter | undefined };
    new ComposeExecutor(ctx as never).setTraceWriter(undefined);
    expect(ctx.traceWriter).toBeUndefined();
  });

  it('AbortGraph accepts setTraceWriter without throwing', () => {
    const graph = new AbortGraph(makeWriter('ag-a'));
    const next = makeWriter('ag-b');
    expect(() => graph.setTraceWriter(next)).not.toThrow();
    expect(() => graph.setTraceWriter(undefined)).not.toThrow();
  });

  it('SubagentManager.setTraceWriter cascades to the abort graph', () => {
    const setTraceWriter = vi.fn();
    // Patch AbortGraph's prototype so we can verify the call without
    // constructing a real subagent runner.
    const original = AbortGraph.prototype.setTraceWriter;
    AbortGraph.prototype.setTraceWriter = setTraceWriter;
    try {
      const manager = new SubagentManager({ traceWriter: makeWriter('sm-a') });
      const next = makeWriter('sm-b');
      manager.setTraceWriter(next);
      expect(setTraceWriter).toHaveBeenCalledWith(next);
    } finally {
      AbortGraph.prototype.setTraceWriter = original;
    }
  });
});

describe('#985 — resumed writer continues seq from where outgoing left off', () => {
  it('a second NdjsonTraceWriter on the same traceDir with startSeq produces monotonic seq numbers', async () => {
    const traceDir = join(tmpRoot, 'resumed');

    // First writer — writes two events (seq 0, seq 1), then seals (seq 2).
    const first = new NdjsonTraceWriter({ traceDir });
    await first.write(sampleEvent());
    await first.write(sampleEvent());
    await first.seal({ reason: 'session_end' });

    // Read the last seq from the sealed file.
    const lines = readFileSync(join(traceDir, 'trace.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const lastSeq: number = JSON.parse(lines[lines.length - 1]).seq as number;

    // Second writer — starts at lastSeq + 1.
    const second = new NdjsonTraceWriter({ traceDir, startSeq: lastSeq + 1 });
    await second.write(sampleEvent());
    await second.write(sampleEvent());
    await second.close();

    // Verify all seq values across the combined file are strictly increasing.
    const allLines = readFileSync(join(traceDir, 'trace.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const seqs = allLines.map((l) => (JSON.parse(l) as { seq: number }).seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // And the second writer's first event directly follows lastSeq.
    expect(seqs[lines.length]).toBe(lastSeq + 1);
  });
});
