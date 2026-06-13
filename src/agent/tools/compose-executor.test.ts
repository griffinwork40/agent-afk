import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolCall } from './types.js';
import type { OutputEvent } from '../types.js';
import type {
  SubagentProgressMeta,
  SubagentProgressSink,
} from '../types/session-types.js';

// Mock SubagentManager + runSubagentDAG before importing the executor.
const mockForkSubagent = vi.fn();
const mockTeardownAll = vi.fn(async () => {});
const mockKill = vi.fn(async (_id: string) => true);

// Capture the most recent SubagentManager constructor options so tests can
// inspect / invoke the chained progressSink the executor installs.
interface CapturedManagerOpts {
  progressSink?: SubagentProgressSink;
  apiKey?: string;
  parentAbortSignal?: AbortSignal;
}
let lastManagerOpts: CapturedManagerOpts | undefined;

vi.mock('../subagent.js', () => ({
  SubagentManager: vi.fn((opts: CapturedManagerOpts = {}) => {
    lastManagerOpts = opts;
    return {
      forkSubagent: mockForkSubagent,
      teardownAll: mockTeardownAll,
      kill: mockKill,
    };
  }),
}));

// Capture runSubagentDAG calls to control results.
const mockRunSubagentDAG = vi.fn();
vi.mock('../dag-subagent.js', () => ({
  runSubagentDAG: (...args: unknown[]) => mockRunSubagentDAG(...args),
}));

// Telemetry is best-effort — stub to prevent fs writes.
vi.mock('../routing-telemetry.js', () => ({
  appendRoutingDecision: vi.fn(async () => {}),
}));

import { ComposeExecutor, cleanupComposeSpills, type ComposeExecutorContext } from './compose-executor.js';

// Synthetic event factory — a tool_use_detail chunk is what handle.ts emits
// for each tool_use block in the assistant message. The budget sink filters
// for these specifically.
function toolUseEvent(toolName: string, id: string): OutputEvent {
  return {
    type: 'chunk',
    chunk: {
      type: 'tool_use_detail',
      toolUseId: `tu-${id}-${Math.random().toString(36).slice(2, 8)}`,
      toolName,
      toolInput: '{}',
    },
  };
}

function meta(subagentId: string): SubagentProgressMeta {
  return { subagentId };
}

function makeCall(input: unknown): ToolCall {
  return {
    id: 'call-1',
    name: 'compose',
    input,
    signal: new AbortController().signal,
  };
}

function makeContext(overrides?: Partial<ComposeExecutorContext>): ComposeExecutorContext {
  return {
    parentSession: {
      sessionId: 'parent-session',
      abortSignal: new AbortController().signal,
    },
    apiKey: 'test-key',
    systemPrompt: 'You are a helpful assistant.',
    ...overrides,
  };
}

// Spill files for truncated node outputs land under getSessionsDir() (i.e.
// $AFK_HOME/state/sessions/...). Override AFK_HOME to a tmpdir so tests
// never touch the real user state directory. Set before any test runs so
// the module-level path resolution in compose-executor picks it up.
let originalAfkHome: string | undefined;
let testTmpHome: string;
beforeEach(() => {
  originalAfkHome = process.env['AFK_HOME'];
  testTmpHome = mkdtempSync(join(tmpdir(), 'compose-executor-test-'));
  process.env['AFK_HOME'] = testTmpHome;
});

describe('ComposeExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastManagerOpts = undefined;
  });

  afterEach(() => {
    if (originalAfkHome === undefined) {
      delete process.env['AFK_HOME'];
    } else {
      process.env['AFK_HOME'] = originalAfkHome;
    }
    try {
      rmSync(testTmpHome, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; tmpdir entries are auto-reaped by the OS.
    }
  });

  describe('input validation', () => {
    it('rejects non-object input', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall('not-an-object'));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('must be an object');
    });

    it('rejects missing nodes', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({ edges: [] }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('non-empty "nodes"');
    });

    it('rejects empty nodes array', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({ nodes: [] }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('non-empty "nodes"');
    });

    it('rejects duplicate node IDs', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [
          { id: 'a', prompt: 'task a' },
          { id: 'a', prompt: 'task a again' },
        ],
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Duplicate node ID');
    });

    it('rejects node without prompt', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a' }],
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('non-empty "prompt"');
    });

    it('rejects edge referencing non-existent node', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        edges: [{ from: 'a', to: 'missing' }],
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('non-existent node');
    });

    it('rejects non-boolean fail_fast', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        fail_fast: 'yes',
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('must be a boolean');
    });

    it('rejects node id containing ANSI escape sequences (M1 — terminal injection)', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'bad\x1b[2Jid', prompt: 'task' }],
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('must match /^[A-Za-z0-9_-]+$/');
    });

    it('rejects node id containing newlines (L2 — log forging)', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'injected\nfake-log: WARN something', prompt: 'task' }],
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('must match /^[A-Za-z0-9_-]+$/');
    });

    it('accepts node ids matching the strict character class', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { 'a-1_B': 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a-1_B', prompt: 'task' }],
      }));
      expect(result.isError).toBeFalsy();
    });
  });

  describe('execution', () => {
    it('pure parallel — delegates to runSubagentDAG with no edges', async () => {
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: 'result-a', b: 'result-b' },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [
          { id: 'a', prompt: 'task a' },
          { id: 'b', prompt: 'task b' },
        ],
      }));

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('result-a');
      expect(result.content).toContain('result-b');
      expect(mockRunSubagentDAG).toHaveBeenCalledOnce();
      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.edges).toEqual([]);
      expect(dagOpts.nodes).toHaveLength(2);
    });

    it('pipeline — passes edges through to runSubagentDAG', async () => {
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: 'result-a', b: 'result-b' },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      await executor.execute(makeCall({
        nodes: [
          { id: 'a', prompt: 'task a' },
          { id: 'b', prompt: 'task b' },
        ],
        edges: [{ from: 'a', to: 'b' }],
      }));

      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.edges).toEqual([{ from: 'a', to: 'b' }]);
    });

    it('fail_fast passed through', async () => {
      mockRunSubagentDAG.mockResolvedValue({
        outputs: {},
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        fail_fast: false,
      }));

      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.failFast).toBe(false);
    });

    it('reports failures with isError=true', async () => {
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: 'ok' },
        failed: [{ id: 'b', error: new Error('boom') }],
        skipped: ['c'],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [
          { id: 'a', prompt: 'task a' },
          { id: 'b', prompt: 'task b' },
          { id: 'c', prompt: 'task c' },
        ],
        edges: [{ from: 'b', to: 'c' }],
      }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('[FAILED]');
      expect(result.content).toContain('boom');
      expect(result.content).toContain('Skipped');
      expect(result.content).toContain('c');
    });

    /**
     * Render hints: each DAG node spec must carry the compose `call.id` as
     * `parentId` (so the CLI nests the spawned Agent entries under the
     * compose tool-lane entry) and a human-readable `agentType` of the form
     * `<nodeId> [k/N]` (so users can see which node is running and the
     * progress through the DAG).
     */
    it('passes parentId=call.id and agentType=`<id> [k/N]` to runSubagentDAG nodes', async () => {
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: 'ok', b: 'ok', c: 'ok' },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const call: ToolCall = {
        id: 'tu_compose_xyz',
        name: 'compose',
        input: {
          nodes: [
            { id: 'a', prompt: 'task a' },
            { id: 'b', prompt: 'task b' },
            { id: 'c', prompt: 'task c' },
          ],
        },
        signal: new AbortController().signal,
      };
      await executor.execute(call);

      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodes).toHaveLength(3);
      // parentId: every node anchors to the compose call's tool_use_id.
      expect(dagOpts.nodes[0].parentId).toBe('tu_compose_xyz');
      expect(dagOpts.nodes[1].parentId).toBe('tu_compose_xyz');
      expect(dagOpts.nodes[2].parentId).toBe('tu_compose_xyz');
      // agentType: `<id> [k/N]` — node id + 1-indexed position over total.
      expect(dagOpts.nodes[0].agentType).toBe('a [1/3]');
      expect(dagOpts.nodes[1].agentType).toBe('b [2/3]');
      expect(dagOpts.nodes[2].agentType).toBe('c [3/3]');
      // idPrefix stays unchanged — still used for routing telemetry.
      expect(dagOpts.nodes[0].idPrefix).toBe('compose-a');
    });

    it('model override per node', async () => {
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: 'done' },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a', model: 'opus' }],
      }));

      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodes[0].model).toBe('opus');
    });

    it('returns aborted when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const call: ToolCall = {
        id: 'call-abort',
        name: 'compose',
        input: { nodes: [{ id: 'a', prompt: 'task a' }] },
        signal: controller.signal,
      };

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(call);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('aborted');
    });

    it('teardownAll is called even on error', async () => {
      mockRunSubagentDAG.mockRejectedValue(new Error('dag exploded'));

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('dag exploded');
      expect(mockTeardownAll).toHaveBeenCalledOnce();
    });
  });

  describe('promptBuilder', () => {
    it('appends upstream context to node prompt', async () => {
      let capturedNodes: Array<{ promptBuilder: (inputs: Record<string, unknown>) => string }> = [];
      mockRunSubagentDAG.mockImplementation(async (opts: { nodes: typeof capturedNodes }) => {
        capturedNodes = opts.nodes;
        return { outputs: {}, failed: [], skipped: [] };
      });

      const executor = new ComposeExecutor(makeContext());
      await executor.execute(makeCall({
        nodes: [
          { id: 'a', prompt: 'research this' },
          { id: 'b', prompt: 'implement based on research' },
        ],
        edges: [{ from: 'a', to: 'b' }],
      }));

      const bNode = capturedNodes[1]!;
      const builtPrompt = bNode.promptBuilder({ a: 'research findings here' });
      expect(builtPrompt).toContain('implement based on research');
      // M-2: strengthened delimiters — non-XML fenced format to prevent tag injection
      expect(builtPrompt).toContain('<<<UPSTREAM_OUTPUT_BEGIN node="a">>>');
      expect(builtPrompt).toContain('<<<UPSTREAM_OUTPUT_END node="a">>>');
      expect(builtPrompt).toContain('research findings here');
      expect(builtPrompt).toContain('untrusted, user-controlled data');
    });

    it('returns raw prompt when no upstream inputs', async () => {
      let capturedNodes: Array<{ promptBuilder: (inputs: Record<string, unknown>) => string }> = [];
      mockRunSubagentDAG.mockImplementation(async (opts: { nodes: typeof capturedNodes }) => {
        capturedNodes = opts.nodes;
        return { outputs: {}, failed: [], skipped: [] };
      });

      const executor = new ComposeExecutor(makeContext());
      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'standalone task' }],
      }));

      const aNode = capturedNodes[0]!;
      const builtPrompt = aNode.promptBuilder({});
      expect(builtPrompt).toBe('standalone task');
    });

    it('systemPrompt from context flows through to DAG nodes (L3)', async () => {
      let capturedNodes: Array<{ systemPrompt: string }> = [];
      mockRunSubagentDAG.mockImplementation(async (opts: { nodes: typeof capturedNodes }) => {
        capturedNodes = opts.nodes;
        return { outputs: {}, failed: [], skipped: [] };
      });

      const executor = new ComposeExecutor(makeContext({ systemPrompt: 'custom system prompt' }));
      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(capturedNodes[0]!.systemPrompt).toBe('custom system prompt');
    });
  });

  describe('guards', () => {
    it('rejects more than 20 nodes (H1)', async () => {
      const executor = new ComposeExecutor(makeContext());
      const nodes = Array.from({ length: 21 }, (_, i) => ({ id: `n${i}`, prompt: `task ${i}` }));
      const result = await executor.execute(makeCall({ nodes }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('at most 20 nodes');
      expect(mockRunSubagentDAG).not.toHaveBeenCalled();
    });

    it('accepts exactly 20 nodes (H1 boundary)', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: {}, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());
      const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, prompt: `task ${i}` }));
      const result = await executor.execute(makeCall({ nodes }));
      expect(result.isError).toBeFalsy();
      expect(mockRunSubagentDAG).toHaveBeenCalledOnce();
    });

    it('returns isError when apiKey is missing (M5)', async () => {
      const executor = new ComposeExecutor(makeContext({ apiKey: undefined }));
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('API key');
      expect(mockRunSubagentDAG).not.toHaveBeenCalled();
    });

    it('returns isError when apiKey is empty string (M5)', async () => {
      const executor = new ComposeExecutor(makeContext({ apiKey: '' }));
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('API key');
    });

    it('surfaces cycle-detected error from runSubagentDAG as isError (L2)', async () => {
      mockRunSubagentDAG.mockRejectedValue(new Error('Cycle detected in DAG'));

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [
          { id: 'a', prompt: 'task a' },
          { id: 'b', prompt: 'task b' },
        ],
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
        ],
      }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('Cycle detected in DAG');
    });
  });

  describe('output formatting', () => {
    it('truncates long node output at 8000 chars with structured marker (M4/L1)', async () => {
      const longOutput = 'x'.repeat(9000);
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: longOutput },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.isError).toBeFalsy();
      // New marker carries emitted/total counts so the model knows how
      // much was dropped, not just that truncation happened.
      expect(result.content).toContain('… (truncated at 8000 / 9000 chars');
      // The 9000-char body should not survive in full — the inline section
      // is sliced to 8000 chars plus the marker (well under 9000).
      const sectionMatch = result.content.match(/## a\n([\s\S]*)$/);
      expect(sectionMatch).not.toBeNull();
      // The marker line is preceded by exactly MAX_NODE_OUTPUT_CHARS chars
      // of the original payload.
      expect(result.content.split('… (truncated')[0]!.length).toBeGreaterThanOrEqual(8000);
    });

    it('emits a structured truncation warning when a node output exceeds the cap', async () => {
      // Historically truncation was silent: only `… (truncated)` appended
      // to the prose. The warning channel surfaces it as metadata so the
      // parent model can recognize data loss without inferring it from a
      // trailing ellipsis.
      const longOutput = 'z'.repeat(10_000);
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: longOutput },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.content).toMatch(/^> \[compose warnings\]/);
      expect(result.content).toContain('node "a" output truncated');
      expect(result.content).toContain('emitted 8000 of 10000 chars');
      expect(result.content).toContain('use read_file to retrieve');
    });

    it('spills the full pre-truncation output to disk under the session-scoped path', async () => {
      // Spill layout: <sessions>/<sessionId>/compose/<callId>/<nodeId>.txt.
      // The path is namespaced by callId so concurrent or sequential compose
      // calls that reuse a node id cannot clobber each other's spill.
      const longOutput = 'q'.repeat(12_500);
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { node_alpha: longOutput },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'node_alpha', prompt: 'task' }],
      }));

      const expectedPath = join(
        testTmpHome,
        'state',
        'sessions',
        'parent-session',
        'compose',
        'call-1',
        'node_alpha.txt',
      );
      expect(result.content).toContain(expectedPath);
      const spilled = readFileSync(expectedPath, 'utf8');
      expect(spilled).toBe(longOutput);
      expect(spilled.length).toBe(12_500);
    });

    it('cleanupComposeSpills removes the per-session compose directory', async () => {
      // Wired into SessionEnd via default-hook-registry.ts so spill files
      // are reclaimed when the session ends. The recovery window for the
      // parent agent is bounded to session lifetime — once the session
      // ends, the parent is gone and the files no longer have a reader.
      const longOutput = 'r'.repeat(9_000);
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: longOutput },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      await executor.execute(makeCall({ nodes: [{ id: 'a', prompt: 'task' }] }));

      const spillDir = join(
        testTmpHome, 'state', 'sessions', 'parent-session', 'compose',
      );
      expect(existsSync(spillDir)).toBe(true);

      cleanupComposeSpills('parent-session');
      expect(existsSync(spillDir)).toBe(false);
    });

    it('cleanupComposeSpills is a no-op when the directory does not exist', () => {
      // The cleanup hook fires for every SessionEnd, not just sessions that
      // actually used compose. It must not throw on the no-spills path.
      expect(() => cleanupComposeSpills('session-that-never-composed')).not.toThrow();
    });

    it('does not spill or warn when node output fits under the cap', async () => {
      // The spill is only paid for when truncation actually fires — every
      // node otherwise would write a file for nothing.
      const shortOutput = 'fits';
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: shortOutput },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.content).not.toContain('[compose warnings]');
      expect(result.content).not.toContain('truncated');
    });

    it('does not truncate output at exactly 8000 chars', async () => {
      const exactOutput = 'y'.repeat(8000);
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: exactOutput },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.content).not.toContain('… (truncated)');
    });

    it('truncates long error messages at 500 chars with suffix (L1)', async () => {
      const longError = 'e'.repeat(600);
      mockRunSubagentDAG.mockResolvedValue({
        outputs: {},
        failed: [{ id: 'a', error: new Error(longError) }],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('… (truncated)');
      // Error section should not contain the full 600-char error
      const errorSection = result.content.split('[FAILED]')[1]!;
      expect(errorSection.length).toBeLessThan(600);
    });

    it('surfaces partial findings attached to a failed node error', async () => {
      // dag-subagent.ts decorates the thrown error with `partialOutput` via
      // `attachSubagentContext`. formatDAGResult reads it and renders a
      // "Partial findings" subsection so the parent receives whatever text
      // the failed child managed to stream before erroring.
      const errWithPartial = Object.assign(
        new Error('connection reset'),
        { partialOutput: 'I was checking the database schema...' },
      );
      mockRunSubagentDAG.mockResolvedValue({
        outputs: {},
        failed: [{ id: 'a', error: errWithPartial }],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('## a [FAILED]');
      expect(result.content).toContain('connection reset');
      expect(result.content).toContain('### Partial findings before failure:');
      expect(result.content).toContain('I was checking the database schema...');
    });

    it('omits partial-findings subsection when no partialOutput is attached', async () => {
      mockRunSubagentDAG.mockResolvedValue({
        outputs: {},
        failed: [{ id: 'a', error: new Error('plain failure') }],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('plain failure');
      expect(result.content).not.toContain('Partial findings before failure');
    });

    it('truncates over-large partial findings at 4000 chars', async () => {
      const longPartial = 'p'.repeat(5000);
      const errWithPartial = Object.assign(
        new Error('failed'),
        { partialOutput: longPartial },
      );
      mockRunSubagentDAG.mockResolvedValue({
        outputs: {},
        failed: [{ id: 'a', error: errWithPartial }],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.content).toContain('### Partial findings before failure:');
      expect(result.content).toContain('… (truncated)');
      // Should contain at most 4000 chars of 'p' in a row (the truncation
      // boundary). 5000 consecutive 'p's would only appear if untruncated.
      expect(result.content).not.toMatch(/p{5000}/);
    });

    it('serializes structured partialOutput via JSON.stringify', async () => {
      const structuredPartial = { step: 2, finding: 'tests reveal a regression' };
      const errWithPartial = Object.assign(
        new Error('failed'),
        { partialOutput: structuredPartial },
      );
      mockRunSubagentDAG.mockResolvedValue({
        outputs: {},
        failed: [{ id: 'a', error: errWithPartial }],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.content).toContain('### Partial findings before failure:');
      expect(result.content).toContain('tests reveal a regression');
      expect(result.content).toContain('"step":2');
    });
  });

  // -------------------------------------------------------------------------
  // node_timeout_ms input — opt-in per-node max-runtime policy.
  // -------------------------------------------------------------------------
  describe('node_timeout_ms input', () => {
    it('forwards node_timeout_ms as nodeTimeoutMs to runSubagentDAG', async () => {
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: 'ok' },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        node_timeout_ms: 30_000,
      }));

      expect(mockRunSubagentDAG).toHaveBeenCalledOnce();
      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodeTimeoutMs).toBe(30_000);
    });

    it('omits nodeTimeoutMs when input field is absent (default behavior preserved)', async () => {
      mockRunSubagentDAG.mockResolvedValue({
        outputs: { a: 'ok' },
        failed: [],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodeTimeoutMs).toBeUndefined();
    });

    it('rejects non-number node_timeout_ms', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        node_timeout_ms: '30000',
      }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('node_timeout_ms');
      expect(mockRunSubagentDAG).not.toHaveBeenCalled();
    });

    it('rejects zero', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        node_timeout_ms: 0,
      }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('node_timeout_ms');
    });

    it('rejects negative values', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        node_timeout_ms: -100,
      }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('node_timeout_ms');
    });

    it('rejects NaN and Infinity', async () => {
      const executor = new ComposeExecutor(makeContext());
      for (const v of [NaN, Infinity, -Infinity]) {
        mockRunSubagentDAG.mockClear();
        const result = await executor.execute(makeCall({
          nodes: [{ id: 'a', prompt: 'task a' }],
          node_timeout_ms: v,
        }));
        expect(result.isError).toBe(true);
        expect(result.content).toContain('node_timeout_ms');
      }
    });

    it('rejects sub-second values with a unit-mistake hint', async () => {
      // Catches the common "I meant seconds" bug: passing 30 instead of 30000.
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        node_timeout_ms: 30,
      }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('1000ms');
      expect(result.content).toContain('unit mistake');
    });

    it('accepts exactly the minimum 1000ms', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        node_timeout_ms: 1_000,
      }));

      expect(result.isError).toBeFalsy();
      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodeTimeoutMs).toBe(1_000);
    });

    it('clamps over-large values to MAX_NODE_TIMEOUT_MS (3,600,000)', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        node_timeout_ms: 999_999_999,
      }));

      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodeTimeoutMs).toBe(3_600_000);
    });

    it('coexists with fail_fast: both forwarded independently', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        fail_fast: false,
        node_timeout_ms: 5_000,
      }));

      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.failFast).toBe(false);
      expect(dagOpts.nodeTimeoutMs).toBe(5_000);
    });
  });

  // -------------------------------------------------------------------------
  // max_tool_calls_per_node input + budget enforcement.
  //
  // The budget is enforced via a chained progressSink installed on the
  // SubagentManager. The sink counts `tool_use_detail` chunks per
  // subagentId and fires `manager.kill(id)` when the count exceeds the
  // budget. Tests synthesize events directly into the captured sink to
  // avoid timing-dependent assertions.
  // -------------------------------------------------------------------------
  describe('max_tool_calls_per_node input validation', () => {
    it('rejects non-number', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        max_tool_calls_per_node: '5',
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('max_tool_calls_per_node');
      expect(mockRunSubagentDAG).not.toHaveBeenCalled();
    });

    it('rejects zero', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        max_tool_calls_per_node: 0,
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('max_tool_calls_per_node');
    });

    it('rejects negative values', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        max_tool_calls_per_node: -5,
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('max_tool_calls_per_node');
    });

    it('rejects fractional values with an integer-only hint', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        max_tool_calls_per_node: 5.5,
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('integer');
    });

    it('rejects NaN and Infinity', async () => {
      const executor = new ComposeExecutor(makeContext());
      for (const v of [NaN, Infinity, -Infinity]) {
        mockRunSubagentDAG.mockClear();
        const result = await executor.execute(makeCall({
          nodes: [{ id: 'a', prompt: 'task a' }],
          max_tool_calls_per_node: v,
        }));
        expect(result.isError).toBe(true);
        expect(result.content).toContain('max_tool_calls_per_node');
      }
    });

    it('rejects values above the maximum (1000)', async () => {
      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        max_tool_calls_per_node: 1001,
      }));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('at most 1000');
    });

    it('accepts the minimum value of 1', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        max_tool_calls_per_node: 1,
      }));

      expect(result.isError).toBeFalsy();
      expect(mockRunSubagentDAG).toHaveBeenCalledOnce();
    });

    it('accepts the maximum value of 1000', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        max_tool_calls_per_node: 1000,
      }));

      expect(result.isError).toBeFalsy();
    });
  });

  describe('max_tool_calls_per_node enforcement', () => {
    it('installs a progressSink on the SubagentManager when budget is set', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        max_tool_calls_per_node: 3,
      }));

      expect(lastManagerOpts).toBeDefined();
      expect(typeof lastManagerOpts?.progressSink).toBe('function');
    });

    it('installs a progressSink even when budget is absent (preserves ambient routing)', async () => {
      // The sink is always chained so CLI rendering keeps working. Disabling
      // the budget just means the counter branch never fires; ambient
      // forwarding stays intact.
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(typeof lastManagerOpts?.progressSink).toBe('function');
    });

    it('calls manager.kill once when a subagent exceeds the budget', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: {}, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        max_tool_calls_per_node: 2,
      }));

      const sink = lastManagerOpts?.progressSink;
      expect(sink).toBeDefined();
      if (!sink) return;

      // Two events under budget: no kill yet.
      sink(toolUseEvent('bash', 'a-sub'), meta('a-sub-1'));
      sink(toolUseEvent('read_file', 'a-sub'), meta('a-sub-1'));
      expect(mockKill).not.toHaveBeenCalled();

      // Third event pushes over budget: kill fires exactly once for the
      // offender. Subsequent events for the same id don't re-fire kill.
      sink(toolUseEvent('write_file', 'a-sub'), meta('a-sub-1'));
      expect(mockKill).toHaveBeenCalledTimes(1);
      expect(mockKill).toHaveBeenCalledWith('a-sub-1');

      // SDK may yield buffered events between our kill and the iterator
      // actually throwing — guard against double-kill of the same id.
      sink(toolUseEvent('grep', 'a-sub'), meta('a-sub-1'));
      sink(toolUseEvent('glob', 'a-sub'), meta('a-sub-1'));
      expect(mockKill).toHaveBeenCalledTimes(1);
    });

    it('does not kill siblings under the same budget', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: {}, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      await executor.execute(makeCall({
        nodes: [
          { id: 'a', prompt: 'a' },
          { id: 'b', prompt: 'b' },
        ],
        max_tool_calls_per_node: 2,
      }));

      const sink = lastManagerOpts?.progressSink;
      if (!sink) throw new Error('progressSink missing');

      // A exceeds: 3 tool calls under id 'a-sub-1'.
      sink(toolUseEvent('bash', 'a'), meta('a-sub-1'));
      sink(toolUseEvent('bash', 'a'), meta('a-sub-1'));
      sink(toolUseEvent('bash', 'a'), meta('a-sub-1'));
      // B stays within budget: 1 tool call under id 'b-sub-1'.
      sink(toolUseEvent('bash', 'b'), meta('b-sub-1'));

      expect(mockKill).toHaveBeenCalledTimes(1);
      expect(mockKill).toHaveBeenCalledWith('a-sub-1');
      expect(mockKill).not.toHaveBeenCalledWith('b-sub-1');
    });

    it('counts only tool_use_detail chunks — content / thinking / message events are ignored', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: {}, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'a' }],
        max_tool_calls_per_node: 1,
      }));

      const sink = lastManagerOpts?.progressSink;
      if (!sink) throw new Error('progressSink missing');

      // Non-tool events: not counted.
      sink({ type: 'chunk', chunk: { type: 'content', content: 'hello' } }, meta('s1'));
      sink({ type: 'chunk', chunk: { type: 'thinking', content: 'think' } }, meta('s1'));
      sink({ type: 'message', message: { role: 'assistant', content: '', timestamp: new Date() } }, meta('s1'));
      sink({ type: 'done' }, meta('s1'));
      expect(mockKill).not.toHaveBeenCalled();

      // Two tool calls: first under budget, second exceeds (budget = 1).
      sink(toolUseEvent('bash', 'a'), meta('s1'));
      expect(mockKill).not.toHaveBeenCalled();
      sink(toolUseEvent('bash', 'a'), meta('s1'));
      expect(mockKill).toHaveBeenCalledTimes(1);
    });

    it('forwards every event to the ambient sink for CLI rendering', async () => {
      // The compose-executor reads `getCurrentSink()` at execute time. We
      // can't easily inject one in unit tests, but we CAN verify that when
      // ambient is undefined (the default in tests), no error is thrown
      // and budget logic still works. The chained-sink defensive try/catch
      // around the ambient call is exercised here implicitly: any throw
      // from the ambient path must not break counting.
      mockRunSubagentDAG.mockResolvedValue({ outputs: {}, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'a' }],
        max_tool_calls_per_node: 1,
      }));

      const sink = lastManagerOpts?.progressSink;
      if (!sink) throw new Error('progressSink missing');

      // These should not throw even with no ambient sink.
      expect(() => sink(toolUseEvent('bash', 'a'), meta('s1'))).not.toThrow();
      expect(() => sink(toolUseEvent('bash', 'a'), meta('s1'))).not.toThrow();
      expect(mockKill).toHaveBeenCalledOnce();
    });

    it('relabels the failed error message to name the budget violation', async () => {
      // The sink fires kill (which records 's1' as exceeded), then the DAG
      // returns a failed entry whose error carries `subagentId: 's1'`.
      // compose's post-process replaces the message with a budget-named
      // string while preserving partialOutput on cause.
      const originalErr = Object.assign(new Error('Subagent a cancelled'), {
        subagentId: 's1',
        partialOutput: 'I had read 3 files when killed',
      });
      mockRunSubagentDAG.mockImplementation(async () => {
        // Fire the budget-exceed events while runSubagentDAG is "running"
        // so the executor's `exceeded` set contains 's1' by the time we
        // return the failed result.
        const sink = lastManagerOpts?.progressSink;
        if (!sink) throw new Error('progressSink missing');
        sink(toolUseEvent('bash', 'a'), meta('s1'));
        sink(toolUseEvent('bash', 'a'), meta('s1'));
        sink(toolUseEvent('bash', 'a'), meta('s1')); // exceeds budget=2
        return { outputs: {}, failed: [{ id: 'a', error: originalErr }], skipped: [] };
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'a' }],
        max_tool_calls_per_node: 2,
      }));

      expect(result.isError).toBe(true);
      expect(result.content).toContain('## a [FAILED]');
      expect(result.content).toContain('exceeded max_tool_calls_per_node of 2');
      expect(result.content).toContain('observed 3');
      // Partial findings still surface — the relabel preserves them.
      expect(result.content).toContain('### Partial findings before failure:');
      expect(result.content).toContain('I had read 3 files when killed');
    });

    it('does NOT relabel failed entries that did not exceed the budget', async () => {
      // A failure with a different cause (e.g. timeout, internal error)
      // must keep its original message even when the budget option is set.
      const timeoutErr = Object.assign(
        new Error('Subagent a aborted: DAG node "a" exceeded nodeTimeoutMs of 30ms'),
        { subagentId: 's-different' },
      );
      mockRunSubagentDAG.mockResolvedValue({
        outputs: {},
        failed: [{ id: 'a', error: timeoutErr }],
        skipped: [],
      });

      const executor = new ComposeExecutor(makeContext());
      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'a' }],
        max_tool_calls_per_node: 5,
      }));

      // The original timeout message survives — no budget relabel.
      expect(result.content).toContain('exceeded nodeTimeoutMs');
      expect(result.content).not.toContain('exceeded max_tool_calls_per_node');
    });

    it('coexists with node_timeout_ms and fail_fast', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'a' }],
        fail_fast: false,
        node_timeout_ms: 30_000,
        max_tool_calls_per_node: 20,
      }));

      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      // Budget enforcement is internal to compose-executor — only fail_fast
      // and nodeTimeoutMs propagate to the DAG layer (correct separation of
      // concerns: the DAG doesn't know about subagent tool calls).
      expect(dagOpts.failFast).toBe(false);
      expect(dagOpts.nodeTimeoutMs).toBe(30_000);
      expect(dagOpts).not.toHaveProperty('maxToolCallsPerNode');
    });

    it('default behavior unchanged when max_tool_calls_per_node is absent', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'a' }],
      }));

      const sink = lastManagerOpts?.progressSink;
      if (!sink) throw new Error('progressSink missing');

      // Even an absurd number of tool calls must not trigger kill when
      // budget is undefined.
      for (let i = 0; i < 100; i++) {
        sink(toolUseEvent('bash', 'a'), meta('s1'));
      }
      expect(mockKill).not.toHaveBeenCalled();
    });

    it('TDZ guard: sink invoked during SubagentManager construction does not throw (issue #1)', async () => {
      // Simulate a pathological SubagentManager constructor that fires the
      // progressSink synchronously before returning (e.g. via a hook). The
      // sink must silently return early instead of dereferencing `manager`
      // (which is unassigned at that moment). This tests the `if (!manager) return`
      // guard added to address the TDZ footgun.
      const { SubagentManager } = await import('../subagent.js');
      const mockCtor = vi.mocked(SubagentManager);

      mockCtor.mockImplementationOnce((opts: CapturedManagerOpts) => {
        lastManagerOpts = opts;
        // Fire the sink synchronously inside the constructor — before
        // `manager = new SubagentManager(...)` has returned and the LHS binding
        // has been updated.
        if (opts.progressSink) {
          expect(() =>
            opts.progressSink!(toolUseEvent('bash', 'ctor-test'), meta('s-ctor')),
          ).not.toThrow();
        }
        return {
          forkSubagent: mockForkSubagent,
          teardownAll: mockTeardownAll,
          kill: mockKill,
        };
      });

      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      // Should not throw even though the sink fires before manager is assigned.
      await expect(executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'a' }],
        max_tool_calls_per_node: 1,
      }))).resolves.not.toThrow();

      // The early-return guard means kill was NOT fired during construction
      // (the event was dropped rather than crashing). Normal budget
      // enforcement still works for events that arrive after construction.
      expect(mockKill).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // node_timeout_ms clamping warnings (issue #3)
  // -------------------------------------------------------------------------
  describe('node_timeout_ms clamp warnings', () => {
    it('surfaces a warning in the result when node_timeout_ms is clamped to MAX (3,600,000ms)', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        node_timeout_ms: 999_999_999,
      }));

      expect(result.isError).toBeFalsy();
      // The warning block should appear before the node output sections.
      expect(result.content).toContain('[compose warnings]');
      expect(result.content).toContain('node_timeout_ms clamped');
      expect(result.content).toContain('999999999ms');
      expect(result.content).toContain('3600000ms');
    });

    it('does NOT surface a warning when node_timeout_ms is within bounds', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        node_timeout_ms: 30_000,
      }));

      expect(result.isError).toBeFalsy();
      expect(result.content).not.toContain('[compose warnings]');
      expect(result.content).not.toContain('clamped');
    });

    it('does NOT surface a warning when node_timeout_ms is absent', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.isError).toBeFalsy();
      expect(result.content).not.toContain('[compose warnings]');
    });

    it('warning appears before node output sections', async () => {
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'my result content' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext());

      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
        node_timeout_ms: 7_200_000,
      }));

      const warningIdx = result.content.indexOf('[compose warnings]');
      const nodeIdx = result.content.indexOf('## a');
      expect(warningIdx).toBeGreaterThanOrEqual(0);
      expect(nodeIdx).toBeGreaterThan(warningIdx);
    });
  });

  describe('resolveApiKeyForModel — per-node credential resolution', () => {
    // Regression: "Anthropic node starves when parent is OpenAI-routed."
    //
    // `getApiKey()` captures ONE credential keyed to the *main* model at
    // bootstrap. When the main model is OpenAI-routed, that credential is an
    // OpenAI key (or undefined) — but compose nodes that default to 'sonnet'
    // (Anthropic-routed) need an Anthropic keychain/env credential instead.
    // Forwarding the parent's pre-captured ctx.apiKey verbatim to every node
    // made Anthropic-routed nodes throw "requires config.apiKey". The fix
    // injects a resolver that re-derives the credential by the *node's* model
    // at fork time. See compose-executor.ts: resolvedNodeApiKey wiring.
    //
    // These tests probe the executor boundary only (SubagentDAGNode.apiKey
    // forwarding). The manager-level config.apiKey || parentApiKey fallback
    // (SubagentManager.forkSubagent) is exercised in subagent.test.ts and is
    // intentionally out of scope here.

    it('resolves the node apiKey by the node model, not the parent ctx.apiKey', async () => {
      // Parent is OpenAI-routed: ctx.apiKey is the OpenAI credential.
      // An Anthropic-routed 'sonnet' node must NOT inherit it — it must get
      // the Anthropic credential the resolver returns for its own model.
      const resolveApiKeyForModel = vi.fn((model: string) =>
        model === 'sonnet' ? 'anthropic-keychain-token' : 'openai-key',
      );

      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext({
        defaultModel: 'gpt-4o',
        apiKey: 'openai-key',
        resolveApiKeyForModel,
      }));

      // The orchestrating agent chooses each node's model explicitly via
      // `n.model` — that choice drives per-node credential resolution. A node
      // without an explicit model inherits ctx.defaultModel ('gpt-4o' here),
      // so set it to 'sonnet' to exercise the Anthropic-under-OpenAI-parent path.
      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a', model: 'sonnet' }],
      }));

      // Resolver called with the node's own model ('sonnet'), not the parent's.
      expect(resolveApiKeyForModel).toHaveBeenCalledWith('sonnet');
      // DAG node carries the resolved Anthropic key, not the parent's OpenAI key.
      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodes[0].apiKey).toBe('anthropic-keychain-token');
    });

    it('resolves by the explicit per-node model override', async () => {
      // When a node specifies model: 'opus', the resolver is called with
      // 'opus' — not with the default subagent model or ctx.defaultModel.
      const resolveApiKeyForModel = vi.fn(() => 'resolved-for-opus');

      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext({
        defaultModel: 'gpt-4o',
        apiKey: 'parent-key',
        resolveApiKeyForModel,
      }));

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a', model: 'opus' }],
      }));

      expect(resolveApiKeyForModel).toHaveBeenCalledWith('opus');
      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodes[0].apiKey).toBe('resolved-for-opus');
    });

    it('preserves explicit same-provider ctx.apiKey over ambient resolver credentials', async () => {
      // Threads and other per-session surfaces may pass an explicit Anthropic
      // session token in ctx.apiKey while the process env/keychain has a
      // different ambient Anthropic credential. Same-provider compose nodes
      // must keep the session token rather than silently switching accounts.
      const resolveApiKeyForModel = vi.fn(() => 'ambient-anthropic-token');

      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext({
        defaultModel: 'sonnet',
        apiKey: 'session-anthropic-token',
        resolveApiKeyForModel,
      }));

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(resolveApiKeyForModel).not.toHaveBeenCalled();
      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodes[0].apiKey).toBe('session-anthropic-token');
    });

    it('falls back to ctx.apiKey when no resolver is injected and providers differ (cross-provider no-resolver else arm, backward compat only — production always injects a resolver)', async () => {
      // Exercises the genuine else arm: cross-provider (OpenAI parent, Anthropic
      // node) with no resolver. nodeIsOpenAI=false, preserveParentApiKey=false
      // (different providers) → falls to `else` → no resolver → ctx.apiKey.
      // Note: without a resolver, production would forward the wrong credential
      // (OpenAI key to an Anthropic node). This path exists for backward compat
      // only; callers should always inject resolveApiKeyForModel.
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext({
        defaultModel: 'gpt-4o',
        apiKey: 'legacy-key',
        // no resolveApiKeyForModel
      }));

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a', model: 'sonnet' }],
      }));

      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      // Node receives the ctx.apiKey as its per-node apiKey (backward compat path).
      expect(dagOpts.nodes[0].apiKey).toBe('legacy-key');
    });

    it('does not inject the resolver value into an OpenAI-routed node config (cross-provider anti-leak guard)', async () => {
      // The nodeIsOpenAI guard forces resolvedNodeApiKey = undefined for
      // OpenAI-routed nodes, so the node fork config carries no apiKey field.
      // This means the openai-compatible provider reads OPENAI_API_KEY from
      // env directly, rather than being handed a potentially-wrong credential.
      //
      // Note: this test proves the executor boundary only. The manager-level
      // `config.apiKey || parentApiKey` fallback in SubagentManager.forkSubagent
      // is unchanged and out of scope — the node falling back to parentApiKey
      // (ctx.apiKey) inside forkSubagent is the same pre-existing behavior as
      // the agent/skill paths and is intentional.
      const resolveApiKeyForModel = vi.fn(() => 'anthropic-token-must-not-reach-openai-node');

      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext({
        apiKey: 'some-parent-key',
        resolveApiKeyForModel,
      }));

      await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a', model: 'gpt-4o' }],
      }));

      // The executor must NOT inject the resolver's value into the node config.
      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodes[0].apiKey).toBeUndefined();
    });

    it('proceeds without error when resolver is present and ctx.apiKey is absent (keyless-parent setup)', async () => {
      // When resolveApiKeyForModel is provided, the keyless precondition guard
      // is relaxed — a local-shim OpenAI parent with no apiKey can still serve
      // Anthropic-routed compose nodes via the resolver.
      const resolveApiKeyForModel = vi.fn(() => 'anthropic-key-from-env');

      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext({
        apiKey: undefined,
        resolveApiKeyForModel,
      }));

      const result = await executor.execute(makeCall({
        nodes: [{ id: 'a', prompt: 'task a' }],
      }));

      expect(result.isError).toBeFalsy();
      expect(mockRunSubagentDAG).toHaveBeenCalledOnce();
      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodes[0].apiKey).toBe('anthropic-key-from-env');
    });

    it('injects no node apiKey when the resolver returns undefined for a cross-provider node (forkSubagent applies the parentApiKey fallback)', async () => {
      // OpenAI-routed parent, Anthropic node, but the resolver finds NO Anthropic
      // credential. The executor forwards no per-node apiKey; SubagentManager.forkSubagent
      // then applies `config.apiKey || parentApiKey` — the same fallback the agent/skill
      // paths use (verified parity; exercised in subagent.test.ts, out of scope here).
      const resolveApiKeyForModel = vi.fn(() => undefined);
      mockRunSubagentDAG.mockResolvedValue({ outputs: { a: 'ok' }, failed: [], skipped: [] });
      const executor = new ComposeExecutor(makeContext({
        defaultModel: 'gpt-4o',
        apiKey: 'openai-key',
        resolveApiKeyForModel,
      }));
      await executor.execute(makeCall({ nodes: [{ id: 'a', prompt: 'task a', model: 'sonnet' }] }));
      expect(resolveApiKeyForModel).toHaveBeenCalledWith('sonnet');
      const dagOpts = mockRunSubagentDAG.mock.calls[0][0];
      expect(dagOpts.nodes[0].apiKey).toBeUndefined();
    });
  });
});
