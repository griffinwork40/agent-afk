import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  computeDAGHash,
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  serializeOutput,
  type DAGCheckpoint,
} from './dag-checkpoint.js';
import type { DAGGraph } from './dag.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpStateDir(): string {
  const dir = join(tmpdir(), `dag-checkpoint-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mockDagCheckpointsDir(stateDir: string): void {
  // Override getDagCheckpointsDir via paths.ts — but since that calls getAfkStateDir()
  // which reads AFK_STATE_DIR, we can set it in the environment.
  process.env['AFK_STATE_DIR'] = stateDir;
}

const sampleGraph: DAGGraph = {
  nodes: [
    { id: 'a', run: async () => 'out-a' },
    { id: 'b', run: async () => 'out-b' },
    { id: 'c', run: async () => 'out-c' },
  ],
  edges: [
    { from: 'a', to: 'c' },
    { from: 'b', to: 'c' },
  ],
};

const sampleCheckpoint: DAGCheckpoint = {
  dagHash: computeDAGHash(sampleGraph),
  completedNodes: ['a', 'b'],
  nodeOutputs: { a: 'out-a', b: 'out-b' },
  failedNodes: [],
  skippedNodes: [],
  timestamp: Date.now(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeDAGHash', () => {
  it('returns a 64-char hex SHA-256 string', () => {
    const hash = computeDAGHash(sampleGraph);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same graph', () => {
    const h1 = computeDAGHash(sampleGraph);
    const h2 = computeDAGHash(sampleGraph);
    expect(h1).toBe(h2);
  });

  it('is deterministic regardless of node array order', () => {
    const reversed: DAGGraph = {
      nodes: [...sampleGraph.nodes].reverse(),
      edges: sampleGraph.edges,
    };
    expect(computeDAGHash(sampleGraph)).toBe(computeDAGHash(reversed));
  });

  it('differs when a node is added', () => {
    const extended: DAGGraph = {
      nodes: [...sampleGraph.nodes, { id: 'd', run: async () => 'd' }],
      edges: sampleGraph.edges,
    };
    expect(computeDAGHash(sampleGraph)).not.toBe(computeDAGHash(extended));
  });

  it('differs when an edge is added', () => {
    const withEdge: DAGGraph = {
      nodes: sampleGraph.nodes,
      edges: [...sampleGraph.edges, { from: 'a', to: 'b' }],
    };
    expect(computeDAGHash(sampleGraph)).not.toBe(computeDAGHash(withEdge));
  });
});

describe('saveCheckpoint / loadCheckpoint round-trip', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tmpStateDir();
    mockDagCheckpointsDir(stateDir);
  });

  afterEach(() => {
    delete process.env['AFK_STATE_DIR'];
  });

  it('saves and loads a checkpoint successfully', async () => {
    const dagId = `test-${randomBytes(4).toString('hex')}`;
    await saveCheckpoint(dagId, sampleCheckpoint);
    const loaded = await loadCheckpoint(dagId, sampleCheckpoint.dagHash);
    expect(loaded).not.toBeNull();
    expect(loaded?.completedNodes).toEqual(['a', 'b']);
    expect(loaded?.nodeOutputs).toEqual({ a: 'out-a', b: 'out-b' });
    expect(loaded?.failedNodes).toEqual([]);
    expect(loaded?.skippedNodes).toEqual([]);
    expect(loaded?.timestamp).toBe(sampleCheckpoint.timestamp);
  });

  it('returns null when the checkpoint file does not exist (cold start)', async () => {
    const loaded = await loadCheckpoint('nonexistent-dag-id', 'anyhash');
    expect(loaded).toBeNull();
  });

  it('returns null when the dagHash does not match (stale checkpoint)', async () => {
    const dagId = `test-${randomBytes(4).toString('hex')}`;
    await saveCheckpoint(dagId, sampleCheckpoint);
    const loaded = await loadCheckpoint(dagId, 'different-hash-abc123');
    expect(loaded).toBeNull();
  });

  it('returns null for an invalid dagId (path traversal)', async () => {
    const loaded = await loadCheckpoint('../evil', 'hash');
    expect(loaded).toBeNull();
  });
});

describe('clearCheckpoint', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = tmpStateDir();
    mockDagCheckpointsDir(stateDir);
  });

  afterEach(() => {
    delete process.env['AFK_STATE_DIR'];
  });

  it('removes the checkpoint file after save', async () => {
    const dagId = `test-${randomBytes(4).toString('hex')}`;
    await saveCheckpoint(dagId, sampleCheckpoint);

    // File must exist before clear.
    const loaded = await loadCheckpoint(dagId, sampleCheckpoint.dagHash);
    expect(loaded).not.toBeNull();

    await clearCheckpoint(dagId);

    // File must be gone after clear.
    const afterClear = await loadCheckpoint(dagId, sampleCheckpoint.dagHash);
    expect(afterClear).toBeNull();
  });

  it('is a no-op when the file does not exist', async () => {
    await expect(clearCheckpoint('no-such-dag')).resolves.not.toThrow();
  });

  it('is a no-op for an invalid dagId', async () => {
    await expect(clearCheckpoint('../evil')).resolves.not.toThrow();
  });
});

describe('serializeOutput', () => {
  it('returns the string as-is when under the 10 KB limit', () => {
    const s = 'hello world';
    expect(serializeOutput(s)).toBe(s);
  });

  it('JSON-encodes non-string values', () => {
    expect(serializeOutput({ x: 1 })).toBe('{"x":1}');
    expect(serializeOutput(42)).toBe('42');
    expect(serializeOutput(null)).toBe('null');
  });

  it('truncates strings longer than 10 KB', () => {
    const big = 'x'.repeat(20_000);
    const result = serializeOutput(big);
    expect(result.length).toBe(10_240); // 10 * 1024
    expect(result).toBe('x'.repeat(10_240));
  });
});
