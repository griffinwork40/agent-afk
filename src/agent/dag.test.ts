import { describe, it, expect, vi } from 'vitest';
import { runDAG, validateDAG, type DAGNode } from './dag.js';
import { TimeoutError } from '../utils/errors.js';

function node(id: string, fn?: (inputs: Record<string, unknown>) => unknown): DAGNode {
  return {
    id,
    run: vi.fn(async (inputs: Record<string, unknown>, _signal: AbortSignal) => {
      return fn ? fn(inputs) : id;
    }),
  };
}

function delayNode(id: string, ms: number, fn?: () => unknown): DAGNode {
  return {
    id,
    run: vi.fn(async (_inputs: Record<string, unknown>, signal: AbortSignal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
      return fn ? fn() : id;
    }),
  };
}

function failNode(id: string, error?: Error): DAGNode {
  return {
    id,
    run: vi.fn(async () => {
      throw error ?? new Error(`${id} failed`);
    }),
  };
}

describe('validateDAG', () => {
  it('accepts empty graph', () => {
    expect(() => validateDAG({ nodes: [], edges: [] })).not.toThrow();
  });

  it('accepts single node', () => {
    expect(() => validateDAG({ nodes: [node('A')], edges: [] })).not.toThrow();
  });

  it('accepts linear chain', () => {
    expect(() =>
      validateDAG({
        nodes: [node('A'), node('B'), node('C')],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'C' },
        ],
      }),
    ).not.toThrow();
  });

  it('throws on duplicate node IDs', () => {
    expect(() =>
      validateDAG({ nodes: [node('A'), node('A')], edges: [] }),
    ).toThrow(/Duplicate node ID/);
  });

  it('throws on edge referencing non-existent node (from)', () => {
    expect(() =>
      validateDAG({ nodes: [node('A')], edges: [{ from: 'X', to: 'A' }] }),
    ).toThrow(/non-existent node.*X/);
  });

  it('throws on edge referencing non-existent node (to)', () => {
    expect(() =>
      validateDAG({ nodes: [node('A')], edges: [{ from: 'A', to: 'X' }] }),
    ).toThrow(/non-existent node.*X/);
  });

  it('throws on duplicate edges', () => {
    expect(() =>
      validateDAG({
        nodes: [node('A'), node('B')],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'A', to: 'B' },
        ],
      }),
    ).toThrow(/Duplicate edge/);
  });

  it('throws on self-loop', () => {
    expect(() =>
      validateDAG({ nodes: [node('A')], edges: [{ from: 'A', to: 'A' }] }),
    ).toThrow(/Cycle detected/);
  });

  it('throws on cycle A → B → A', () => {
    expect(() =>
      validateDAG({
        nodes: [node('A'), node('B')],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'A' },
        ],
      }),
    ).toThrow(/Cycle detected/);
  });

  it('throws on longer cycle A → B → C → A', () => {
    expect(() =>
      validateDAG({
        nodes: [node('A'), node('B'), node('C')],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'C' },
          { from: 'C', to: 'A' },
        ],
      }),
    ).toThrow(/Cycle detected/);
  });
});

describe('runDAG', () => {
  it('returns empty result for empty graph', async () => {
    const result = await runDAG({ nodes: [], edges: [] }, new AbortController().signal);
    expect(result).toEqual({ outputs: {}, failed: [], skipped: [] });
  });

  it('executes single root node', async () => {
    const a = node('A', () => 42);
    const result = await runDAG({ nodes: [a], edges: [] }, new AbortController().signal);
    expect(result.outputs).toEqual({ A: 42 });
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(a.run).toHaveBeenCalledOnce();
  });

  it('executes isolated node (no edges)', async () => {
    const a = node('A', () => 'alone');
    const result = await runDAG({ nodes: [a], edges: [] }, new AbortController().signal);
    expect(result.outputs['A']).toBe('alone');
  });

  it('executes linear chain A → B → C with input forwarding', async () => {
    const a = node('A', () => 10);
    const b = node('B', (inputs) => (inputs['A'] as number) + 5);
    const c = node('C', (inputs) => (inputs['B'] as number) * 2);

    const result = await runDAG(
      { nodes: [a, b, c], edges: [{ from: 'A', to: 'B' }, { from: 'B', to: 'C' }] },
      new AbortController().signal,
    );

    expect(result.outputs).toEqual({ A: 10, B: 15, C: 30 });
    expect(result.failed).toEqual([]);
  });

  it('executes diamond: A → B, A → C, B → D, C → D', async () => {
    const a = node('A', () => 1);
    const b = node('B', (inputs) => (inputs['A'] as number) + 10);
    const c = node('C', (inputs) => (inputs['A'] as number) + 100);
    const d = node('D', (inputs) => (inputs['B'] as number) + (inputs['C'] as number));

    const result = await runDAG(
      {
        nodes: [a, b, c, d],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'A', to: 'C' },
          { from: 'B', to: 'D' },
          { from: 'C', to: 'D' },
        ],
      },
      new AbortController().signal,
    );

    expect(result.outputs).toEqual({ A: 1, B: 11, C: 101, D: 112 });
  });

  it('D receives inputs keyed by upstream node IDs', async () => {
    const d = node('D', (inputs) => inputs);
    const result = await runDAG(
      {
        nodes: [node('B', () => 'from-B'), node('C', () => 'from-C'), d],
        edges: [
          { from: 'B', to: 'D' },
          { from: 'C', to: 'D' },
        ],
      },
      new AbortController().signal,
    );
    expect(result.outputs['D']).toEqual({ B: 'from-B', C: 'from-C' });
  });

  it('wide fan-out: A → B₁, B₂, B₃ run in same layer', async () => {
    const order: string[] = [];
    const a = node('A', () => { order.push('A'); return 1; });
    const b1 = delayNode('B1', 10, () => { order.push('B1'); return 'b1'; });
    const b2 = delayNode('B2', 10, () => { order.push('B2'); return 'b2'; });
    const b3 = delayNode('B3', 10, () => { order.push('B3'); return 'b3'; });

    const result = await runDAG(
      {
        nodes: [a, b1, b2, b3],
        edges: [
          { from: 'A', to: 'B1' },
          { from: 'A', to: 'B2' },
          { from: 'A', to: 'B3' },
        ],
      },
      new AbortController().signal,
    );

    expect(order[0]).toBe('A');
    expect(result.outputs).toMatchObject({ A: 1, B1: 'b1', B2: 'b2', B3: 'b3' });
  });

  it('fan-in: B₁, B₂ → C waits for all', async () => {
    const c = node('C', (inputs) => Object.keys(inputs).sort().join(','));
    const result = await runDAG(
      {
        nodes: [node('B1', () => 1), node('B2', () => 2), c],
        edges: [
          { from: 'B1', to: 'C' },
          { from: 'B2', to: 'C' },
        ],
      },
      new AbortController().signal,
    );
    expect(result.outputs['C']).toBe('B1,B2');
  });
});

describe('runDAG — fail-fast', () => {
  it('error in B aborts sibling C and skips downstream D', async () => {
    const cRun = vi.fn();
    const result = await runDAG(
      {
        nodes: [
          node('A', () => 1),
          failNode('B'),
          delayNode('C', 500, cRun),
          node('D'),
        ],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'A', to: 'C' },
          { from: 'B', to: 'D' },
          { from: 'C', to: 'D' },
        ],
      },
      new AbortController().signal,
      { failFast: true },
    );

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('B');
    expect(result.skipped).toContain('D');
    expect(result.outputs['A']).toBe(1);
    expect(result.outputs['D']).toBeUndefined();
  });

  it('failFast=false: B fails, C completes, D skipped', async () => {
    const result = await runDAG(
      {
        nodes: [
          node('A', () => 1),
          failNode('B'),
          node('C', () => 'c-ok'),
          node('D', (inputs) => inputs),
        ],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'A', to: 'C' },
          { from: 'B', to: 'D' },
          { from: 'C', to: 'D' },
        ],
      },
      new AbortController().signal,
      { failFast: false },
    );

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('B');
    expect(result.outputs['C']).toBe('c-ok');
    expect(result.skipped).toContain('D');
    expect(result.outputs['D']).toBeUndefined();
  });

  it('multiple nodes fail in same layer: all reported in failed[]', async () => {
    const result = await runDAG(
      {
        nodes: [
          node('A', () => 1),
          failNode('B'),
          failNode('C'),
          node('D', () => 'ok'),
        ],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'A', to: 'C' },
          { from: 'A', to: 'D' },
        ],
      },
      new AbortController().signal,
      { failFast: false },
    );

    expect(result.failed).toHaveLength(2);
    const failedIds = result.failed.map((f) => f.id);
    expect(failedIds).toContain('B');
    expect(failedIds).toContain('C');
    expect(result.outputs['D']).toBe('ok');
    expect(result.outputs['A']).toBe(1);
  });

  it('failFast=false: independent branches continue', async () => {
    // A → B (fails), C → D (independent)
    const result = await runDAG(
      {
        nodes: [
          node('A', () => 1),
          failNode('B'),
          node('C', () => 2),
          node('D', (inputs) => inputs['C']),
        ],
        edges: [
          { from: 'A', to: 'B' },
          { from: 'C', to: 'D' },
        ],
      },
      new AbortController().signal,
      { failFast: false },
    );

    expect(result.failed).toHaveLength(1);
    expect(result.outputs['D']).toBe(2);
    expect(result.skipped).toEqual([]);
  });
});

describe('runDAG — abort signal', () => {
  it('already-aborted signal returns immediately', async () => {
    const a = node('A');
    const result = await runDAG(
      { nodes: [a], edges: [] },
      AbortSignal.abort('pre-aborted'),
    );
    expect(a.run).not.toHaveBeenCalled();
    expect(result.outputs).toEqual({});
  });

  it('parent abort mid-layer cancels in-flight nodes', async () => {
    const controller = new AbortController();
    const started: string[] = [];

    const a: DAGNode = {
      id: 'A',
      run: async (_inputs, signal) => {
        started.push('A');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
        return 'a';
      },
    };

    const resultPromise = runDAG({ nodes: [a], edges: [] }, controller.signal);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort('test-abort');
    const result = await resultPromise;

    expect(started).toContain('A');
    expect(result.failed.length + result.skipped.length).toBeGreaterThan(0);
  });
});

describe('runDAG — stress', () => {
  it('wide layer: 50 parallel nodes complete correctly', async () => {
    const root = node('A', () => 'root');
    const fanOut = Array.from({ length: 50 }, (_, i) =>
      node(`B${i}`, () => i),
    );
    const edges = fanOut.map((n) => ({ from: 'A', to: n.id }));

    const result = await runDAG(
      { nodes: [root, ...fanOut], edges },
      new AbortController().signal,
    );

    expect(Object.keys(result.outputs)).toHaveLength(51);
    expect(result.outputs['A']).toBe('root');
    for (let i = 0; i < 50; i++) {
      expect(result.outputs[`B${i}`]).toBe(i);
    }
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('deep chain: 100-node sequential pipeline', async () => {
    const nodes = Array.from({ length: 100 }, (_, i) =>
      node(`N${i}`, (inputs) => {
        if (i === 0) return 0;
        return (inputs[`N${i - 1}`] as number) + 1;
      }),
    );
    const edges = nodes.slice(1).map((n, i) => ({ from: `N${i}`, to: n.id }));

    const result = await runDAG(
      { nodes, edges },
      new AbortController().signal,
    );

    expect(result.outputs['N99']).toBe(99);
    expect(Object.keys(result.outputs)).toHaveLength(100);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runDAG — nodeTimeoutMs (per-node max-runtime policy).
//
// The DAG layer enforces wall-clock max runtime per node. The node's own
// AbortController is the abort source — siblings stay independent. Honest
// because the DAG cannot see intra-node progress; idle-detection would
// require new instrumentation (not added here on purpose).
// ---------------------------------------------------------------------------
describe('runDAG — nodeTimeoutMs', () => {
  it('aborts a slow node without affecting sibling progress', async () => {
    const slow = delayNode('slow', 5_000);
    let fastFinished = false;
    const fast: DAGNode = {
      id: 'fast',
      run: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 20));
        fastFinished = true;
        return 'fast-output';
      }),
    };

    const result = await runDAG(
      { nodes: [slow, fast], edges: [] },
      new AbortController().signal,
      { nodeTimeoutMs: 100, failFast: false },
    );

    expect(fastFinished).toBe(true);
    expect(result.outputs['fast']).toBe('fast-output');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('slow');
    expect(result.skipped).toEqual([]);
  });

  it('aborts with a TimeoutError reason on the node signal', async () => {
    let capturedReason: unknown;
    const slow: DAGNode = {
      id: 'slow',
      run: vi.fn(async (_inputs, signal) => {
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => {
            capturedReason = signal.reason;
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      }),
    };

    const result = await runDAG(
      { nodes: [slow], edges: [] },
      new AbortController().signal,
      { nodeTimeoutMs: 50 },
    );

    expect(result.failed).toHaveLength(1);
    expect(capturedReason).toBeInstanceOf(TimeoutError);
    const reason = capturedReason as TimeoutError;
    expect(reason.name).toBe('TimeoutError');
    expect(reason.timeoutMs).toBe(50);
    expect(reason.message).toContain('"slow"');
    expect(reason.message).toContain('50ms');
  });

  it('does not fire when a node completes before the deadline', async () => {
    const quick = delayNode('quick', 20);

    const result = await runDAG(
      { nodes: [quick], edges: [] },
      new AbortController().signal,
      { nodeTimeoutMs: 1_000 },
    );

    expect(result.outputs['quick']).toBe('quick');
    expect(result.failed).toEqual([]);
  });

  it('disabled (undefined) preserves prior behavior — no abort', async () => {
    const medium = delayNode('medium', 30);

    const result = await runDAG(
      { nodes: [medium], edges: [] },
      new AbortController().signal,
      // No nodeTimeoutMs — opt-in.
    );

    expect(result.outputs['medium']).toBe('medium');
    expect(result.failed).toEqual([]);
  });

  it('treats nodeTimeoutMs <= 0 as disabled (defensive)', async () => {
    const medium = delayNode('medium', 30);

    const result = await runDAG(
      { nodes: [medium], edges: [] },
      new AbortController().signal,
      { nodeTimeoutMs: 0 },
    );

    expect(result.outputs['medium']).toBe('medium');
    expect(result.failed).toEqual([]);
  });

  it('with failFast=true, timed-out node skips its downstream subtree', async () => {
    const slow = delayNode('slow', 5_000);
    const downstream = node('downstream');

    const result = await runDAG(
      { nodes: [slow, downstream], edges: [{ from: 'slow', to: 'downstream' }] },
      new AbortController().signal,
      { nodeTimeoutMs: 50, failFast: true },
    );

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('slow');
    expect(result.skipped).toContain('downstream');
    expect(result.outputs['downstream']).toBeUndefined();
  });

  it('with failFast=false, timed-out node still skips its own downstream subtree', async () => {
    // Downstream of a *failed* node is always skipped (it has no input).
    // failFast only controls whether sibling subtrees are cancelled.
    const slow = delayNode('slow', 5_000);
    const downstreamOfSlow = node('downstreamOfSlow');
    const independentSibling: DAGNode = {
      id: 'independent',
      run: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 40));
        return 'independent-output';
      }),
    };

    const result = await runDAG(
      {
        nodes: [slow, downstreamOfSlow, independentSibling],
        edges: [{ from: 'slow', to: 'downstreamOfSlow' }],
      },
      new AbortController().signal,
      { nodeTimeoutMs: 100, failFast: false },
    );

    expect(result.failed.map((f) => f.id)).toEqual(['slow']);
    expect(result.skipped).toContain('downstreamOfSlow');
    expect(result.outputs['independent']).toBe('independent-output');
  });

  it('clears its timer on completion — no stale abort observable after node returns', async () => {
    // If clearTimeout were missing, the timer would fire after the node had
    // already resolved. We can't directly observe the timer firing, but we
    // CAN observe that a subsequent node in the same DAG run completes
    // without its controller being aborted by a leaked timer.
    const fast = delayNode('fast', 10);
    const followUp = delayNode('followUp', 30);

    const result = await runDAG(
      { nodes: [fast, followUp], edges: [{ from: 'fast', to: 'followUp' }] },
      new AbortController().signal,
      { nodeTimeoutMs: 100 },
    );

    expect(result.outputs['fast']).toBe('fast');
    expect(result.outputs['followUp']).toBe('followUp');
    expect(result.failed).toEqual([]);
  });

  it('parent abort still cascades — independent of nodeTimeoutMs', async () => {
    const slow = delayNode('slow', 5_000);
    const outerController = new AbortController();

    const promise = runDAG(
      { nodes: [slow], edges: [] },
      outerController.signal,
      { nodeTimeoutMs: 10_000, failFast: true },
    );

    // Abort the parent before the node timeout would fire.
    setTimeout(() => outerController.abort('user-cancel'), 30);
    const result = await promise;

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.id).toBe('slow');
  });
});
