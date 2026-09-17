/**
 * Benchmark: crash-to-resume DAG checkpoint correctness.
 *
 * Validates that the DAG executor's checkpoint system correctly resumes
 * partial executions without re-running completed nodes. Proves four
 * properties documented in the checkpoint module (`dag-checkpoint.ts`):
 *
 *   1. **No re-run.** Completed nodes are skipped on resume.
 *   2. **Output preservation.** Checkpointed outputs are available as
 *      upstream inputs to downstream nodes on the resumed run.
 *   3. **Stale rejection.** A structurally different DAG (different hash)
 *      ignores the checkpoint and does a clean re-run.
 *   4. **Cleanup on success.** A fully successful run clears the checkpoint
 *      file so it does not leak.
 *
 * Unlike the trace-completeness and abort-cascade benchmarks (which spawn
 * child processes), this benchmark exercises the checkpoint system in-process
 * by manually writing a checkpoint (simulating a prior crashed run) and then
 * calling `runDAG()` with the same dagId. The checkpoint I/O uses synchronous
 * fs calls and the resume path is purely file-driven, so in-process testing
 * is faithful to the real crash-and-restart scenario.
 *
 * Contract ref: `docs/philosophy/afk-contract.md`
 * Module ref: `src/agent/dag-checkpoint.ts`
 *
 * @module agent/dag-checkpoint.bench
 */

import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runDAG, type DAGNode, type DAGGraph } from './dag.js';
import { computeDAGHash, saveCheckpoint } from './dag-checkpoint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a node that increments a shared counter and returns a value. */
function trackingNode(
  id: string,
  counter: Map<string, number>,
  returnValue: unknown = id,
  fn?: (inputs: Record<string, unknown>) => unknown,
): DAGNode {
  return {
    id,
    run: async (inputs: Record<string, unknown>) => {
      counter.set(id, (counter.get(id) ?? 0) + 1);
      return fn ? fn(inputs) : returnValue;
    },
  };
}

// ---------------------------------------------------------------------------
// Result accumulator
// ---------------------------------------------------------------------------
interface BenchResult {
  scenario: string;
  property: string;
  passed: boolean;
  detail: string;
}
const results: BenchResult[] = [];

// ---------------------------------------------------------------------------
// Benchmark scenarios
// ---------------------------------------------------------------------------
describe('crash-to-resume DAG checkpoint correctness', () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeAll(() => {
    originalStateDir = process.env['AFK_STATE_DIR'];
  });

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'afk-dag-bench-'));
    process.env['AFK_STATE_DIR'] = stateDir;
  });

  afterEach(() => {
    if (originalStateDir !== undefined) {
      process.env['AFK_STATE_DIR'] = originalStateDir;
    } else {
      delete process.env['AFK_STATE_DIR'];
    }
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch { /* best-effort cleanup */ }
  });

  afterAll(() => {
    process.stdout.write('\n=== Crash-to-Resume Benchmark Results ===\n');
    for (const r of results) {
      const status = r.passed ? 'PASS' : 'FAIL';
      process.stdout.write(
        `  ${r.scenario.padEnd(40)} ${r.property.padEnd(22)} [${status}]  ${r.detail}\n`,
      );
    }
    const allPass = results.every((r) => r.passed);
    process.stdout.write(
      `  ${'VERDICT'.padEnd(40)} ${' '.padEnd(22)} ${allPass ? 'ALL PASS' : 'FAILURES DETECTED'}\n`,
    );
    process.stdout.write('==========================================\n\n');
  });

  // -----------------------------------------------------------------------
  // Scenario A: Completed nodes are NOT re-run on resume
  //
  // Simulates: Run 1 executed A (layer 0) then crashed before B or C ran.
  // We write a checkpoint with A completed, then run the full DAG with the
  // same dagId. A must be skipped; B and C must run.
  // -----------------------------------------------------------------------
  it('completed nodes are not re-run after checkpoint resume', async () => {
    const dagId = `bench-no-rerun-${randomBytes(4).toString('hex')}`;
    const counter = new Map<string, number>();

    // The DAG: A -> B -> C (3-layer linear chain).
    const graph: DAGGraph = {
      nodes: [
        trackingNode('A', counter, 'output-A'),
        trackingNode('B', counter, 'output-B'),
        trackingNode('C', counter, 'output-C'),
      ],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
      ],
    };

    // Simulate a prior crashed run that completed only node A.
    const dagHash = computeDAGHash(graph);
    await saveCheckpoint(dagId, {
      dagHash,
      completedNodes: ['A'],
      nodeOutputs: { A: JSON.stringify('output-A') },
      failedNodes: [],
      skippedNodes: [],
      timestamp: Date.now(),
    });

    // Resume: run the full DAG with the same dagId.
    const controller = new AbortController();
    const result = await runDAG(graph, controller.signal, { dagId, maxConcurrency: 1 });

    const aCount = counter.get('A') ?? 0;
    const bCount = counter.get('B') ?? 0;
    const cCount = counter.get('C') ?? 0;

    // A must NOT have been called (restored from checkpoint).
    expect(aCount).toBe(0);
    // B and C must have run exactly once.
    expect(bCount).toBe(1);
    expect(cCount).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(result.outputs['A']).toBe('output-A');
    expect(result.outputs['B']).toBe('output-B');
    expect(result.outputs['C']).toBe('output-C');

    results.push({
      scenario: 'no-rerun-on-resume',
      property: 'skip completed nodes',
      passed: aCount === 0 && bCount === 1 && cCount === 1,
      detail: `A=${aCount} B=${bCount} C=${cCount} (want A=0 B=1 C=1)`,
    });
  }, 15_000);

  // -----------------------------------------------------------------------
  // Scenario B: Checkpointed outputs are available as upstream inputs
  //
  // Simulates: Run 1 executed A (produced { value: 42 }) then crashed.
  // Run 2 resumes; B must receive A's output as its upstream input.
  // -----------------------------------------------------------------------
  it('checkpointed outputs are preserved as upstream inputs', async () => {
    const dagId = `bench-output-${randomBytes(4).toString('hex')}`;
    const counter = new Map<string, number>();
    let receivedInputInB: unknown = undefined;

    const graph: DAGGraph = {
      nodes: [
        trackingNode('A', counter, { value: 42 }),
        trackingNode('B', counter, 'output-B', (inputs) => {
          receivedInputInB = inputs['A'];
          return 'output-B';
        }),
      ],
      edges: [{ from: 'A', to: 'B' }],
    };

    // Simulate prior crashed run: A completed with output { value: 42 }.
    const dagHash = computeDAGHash(graph);
    await saveCheckpoint(dagId, {
      dagHash,
      completedNodes: ['A'],
      nodeOutputs: { A: JSON.stringify({ value: 42 }) },
      failedNodes: [],
      skippedNodes: [],
      timestamp: Date.now(),
    });

    // Resume.
    const controller = new AbortController();
    const result = await runDAG(graph, controller.signal, { dagId, maxConcurrency: 1 });

    // B must have received A's deserialized output.
    expect(receivedInputInB).toEqual({ value: 42 });
    expect(counter.get('A') ?? 0).toBe(0); // A was not re-run
    expect(counter.get('B') ?? 0).toBe(1);
    expect(result.failed).toHaveLength(0);

    const outputPreserved =
      receivedInputInB !== undefined &&
      typeof receivedInputInB === 'object' &&
      (receivedInputInB as Record<string, unknown>).value === 42;

    results.push({
      scenario: 'output-preservation',
      property: 'upstream inputs intact',
      passed: outputPreserved,
      detail: `B received: ${JSON.stringify(receivedInputInB)} (want {value:42})`,
    });
  }, 15_000);

  // -----------------------------------------------------------------------
  // Scenario C: Stale checkpoints are rejected on structure change
  //
  // A checkpoint from a 2-node DAG (A -> B) must be rejected when the DAG
  // structure changes to 3 nodes (A -> B -> C). All nodes must re-run.
  // -----------------------------------------------------------------------
  it('stale checkpoint is rejected when DAG structure changes', async () => {
    const dagId = `bench-stale-${randomBytes(4).toString('hex')}`;
    const counter = new Map<string, number>();

    // Original DAG: A -> B.
    const originalGraph: DAGGraph = {
      nodes: [
        trackingNode('A', counter, 'output-A'),
        trackingNode('B', counter, 'output-B'),
      ],
      edges: [{ from: 'A', to: 'B' }],
    };

    // Write a checkpoint for the original graph with A completed.
    const originalHash = computeDAGHash(originalGraph);
    await saveCheckpoint(dagId, {
      dagHash: originalHash,
      completedNodes: ['A'],
      nodeOutputs: { A: JSON.stringify('output-A') },
      failedNodes: [],
      skippedNodes: [],
      timestamp: Date.now(),
    });

    // New DAG: A -> B -> C (DIFFERENT structure).
    const newGraph: DAGGraph = {
      nodes: [
        trackingNode('A', counter, 'output-A'),
        trackingNode('B', counter, 'output-B'),
        trackingNode('C', counter, 'output-C'),
      ],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
      ],
    };

    const newHash = computeDAGHash(newGraph);
    expect(originalHash).not.toBe(newHash); // Sanity: hashes differ

    // Run with the new graph but the same dagId -- stale checkpoint must be rejected.
    const controller = new AbortController();
    const result = await runDAG(newGraph, controller.signal, { dagId, maxConcurrency: 1 });

    const aCount = counter.get('A') ?? 0;
    const bCount = counter.get('B') ?? 0;
    const cCount = counter.get('C') ?? 0;

    // All nodes must re-run (checkpoint was stale).
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
    expect(cCount).toBe(1);
    expect(result.failed).toHaveLength(0);

    results.push({
      scenario: 'stale-checkpoint-rejection',
      property: 'hash mismatch -> re-run',
      passed: aCount === 1 && bCount === 1 && cCount === 1,
      detail: `A=${aCount} B=${bCount} C=${cCount} (all must be 1 = fresh run)`,
    });
  }, 15_000);

  // -----------------------------------------------------------------------
  // Scenario D: Successful completion clears the checkpoint
  // -----------------------------------------------------------------------
  it('successful completion clears the checkpoint file', async () => {
    const dagId = `bench-cleanup-${randomBytes(4).toString('hex')}`;
    const counter = new Map<string, number>();

    const graph: DAGGraph = {
      nodes: [
        trackingNode('A', counter, 'output-A'),
        trackingNode('B', counter, 'output-B'),
      ],
      edges: [{ from: 'A', to: 'B' }],
    };

    // Run to full completion (no abort, no failure).
    const controller = new AbortController();
    const result = await runDAG(graph, controller.signal, { dagId, maxConcurrency: 1 });

    expect(result.failed).toHaveLength(0);
    expect(result.outputs['A']).toBe('output-A');
    expect(result.outputs['B']).toBe('output-B');

    // The checkpoint file must not exist after successful completion.
    const checkpointPath = join(stateDir, 'dag-checkpoints', `${dagId}.json`);
    const fileExists = existsSync(checkpointPath);
    expect(fileExists).toBe(false);

    results.push({
      scenario: 'cleanup-on-success',
      property: 'checkpoint cleared',
      passed: !fileExists,
      detail: `checkpoint exists=${fileExists} (want false)`,
    });
  }, 15_000);
});
