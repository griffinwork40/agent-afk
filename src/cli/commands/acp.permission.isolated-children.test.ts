/**
 * Regression guard for red team R2 break 2 (D19): a worktree-isolated compose node runs in
 * `<repoRoot>/.afk-worktrees/<slug>` (worktree-managed.ts:55-65), a full
 * checkout of the WHOLE repository. When the session cwd is a subdirectory of
 * the repo, that is outside the session cwd. The node's origin carries no cwd
 * (compose-executor.node-build.ts:126 sets nodeCwd undefined for isolation),
 * and `relocatesChildren` (acp.permission.paths.ts:84-88) only looks at
 * `cwd`, never `isolation`, so the conservative "child cwd unknown" rule is
 * never armed. The node child's no-path / relative reads (grep, glob,
 * list_directory, read_file 'x') are auto-allowed against a directory the
 * gate never saw.
 *
 * Asserts the SAFE behaviour; failed on afk/acp-v1 bc8ac988d before D19.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AcpClientPeer, ToolCallStart } from './acp.wire.js';
import type { CanUseTool } from '../../agent/types.js';
import { createAcpPermissionGate } from './acp.permission.js';
import { composeNodeGated, type ChildToolOrigin } from '../../agent/tools/nesting.can-use-tool.js';

const repo = path.join(os.tmpdir(), 'rt-repo');
const cwd = path.join(repo, 'packages', 'app'); // session cwd: a subdirectory of the repo

function setup() {
  const requests: { params: unknown; resolve(v: unknown): void }[] = [];
  const peer: AcpClientPeer = {
    request: (_m, params) => new Promise((resolve) => { requests.push({ params, resolve }); }),
    notify: () => Promise.resolve(),
  };
  const gate = createAcpPermissionGate(peer, 'sid', {
    skip: false, cwd, onCancelled: vi.fn(), emitToolCall: vi.fn(async (_u: ToolCallStart) => {}),
  });
  return { gate, requests };
}
const opts = (id: string) => ({ signal: new AbortController().signal, toolUseID: id });
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

describe('D19: worktree-isolated compose node', () => {
  it('the production origin for an isolated node carries no cwd (precondition)', () => {
    let seen: ChildToolOrigin | undefined;
    const factory = (o: ChildToolOrigin): CanUseTool => { seen = o; return async () => ({ behavior: 'allow' }); };
    // compose-executor.node-build.ts:126 passes nodeCwd = undefined when isolation === 'worktree'.
    composeNodeGated({}, factory, { id: 'n' }, 0, undefined);
    expect(seen).toBeDefined();
    expect(seen!.cwd).toBeUndefined();
  });

  it('after an isolated compose node is approved, its no-path / relative reads are asked', async () => {
    const t = setup();
    const p = t.gate.canUseTool('compose', { nodes: [{ id: 'n', prompt: 'look around', isolation: 'worktree' }] }, opts('c1'));
    await flush();
    expect(t.requests).toHaveLength(1);
    t.requests[0]!.resolve({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(await p).toEqual({ behavior: 'allow' });

    // The child runs in <repo>/.afk-worktrees/<slug>; the gate cannot know where.
    const node = t.gate.forChild!({ route: 'compose', depth: 1, label: 'n' });
    const results = await Promise.all([
      Promise.race([node('grep', { pattern: 'API_KEY' }, opts('g1')), flush().then(() => 'pending' as const)]),
      Promise.race([node('read_file', { file_path: '../../.env' }, opts('r1')), flush().then(() => 'pending' as const)]),
    ]);
    await flush();
    // SAFE: each is asked (pending on a request), as for a relocating compose node cwd.
    // On this code the grep is allowed with no request.
    expect(results[0], 'grep with no path in an isolated node ran without asking').toBe('pending');
  });
});

describe('D19: isolation relocates children wherever it is declared', () => {
  const ask = async (gate: ReturnType<typeof setup>['gate'], requests: ReturnType<typeof setup>['requests'],
    tool: string, input: Record<string, unknown>) => {
    const p = gate.canUseTool(tool, input, opts('d'));
    await flush();
    requests[requests.length - 1]!.resolve({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(await p).toEqual({ behavior: 'allow' });
  };
  for (const [tool, input] of [
    ['agent', { prompt: 'p', isolation: 'worktree' }],
    ['compose', { nodes: [{ id: 'a', prompt: 'p' }, { id: 'b', prompt: 'p', isolation: 'worktree' }] }],
    ['compose', { nodes: [{ id: 'a', prompt: 'p', isolation: 'something-new' }] }],
  ] as const) {
    it(`${tool} ${JSON.stringify(input)} arms the unknown-cwd rule`, async () => {
      const t = setup();
      await ask(t.gate, t.requests, tool, input as Record<string, unknown>);
      const child = t.gate.forChild!({ route: 'subagent', depth: 1 });
      const r = await Promise.race([child('list_directory', {}, opts('l1')), flush().then(() => 'pending' as const)]);
      expect(r).toBe('pending');
    });
  }
  it('isolation "none" does not arm the rule', async () => {
    const t = setup();
    await ask(t.gate, t.requests, 'agent', { prompt: 'p', isolation: 'none' });
    const child = t.gate.forChild!({ route: 'subagent', depth: 1 });
    expect(await child('list_directory', {}, opts('l1'))).toEqual({ behavior: 'allow' });
  });
  it('a child that delegates into an isolated worktree arms the rule for grandchildren', async () => {
    const t = setup();
    const child = t.gate.forChild!({ route: 'subagent', depth: 1, cwd });
    const p = child('compose', { nodes: [{ id: 'n', prompt: 'p', isolation: 'worktree' }] }, opts('c1'));
    await flush();
    t.requests[0]!.resolve({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(await p).toEqual({ behavior: 'allow' });
    const grandchild = t.gate.forChild!({ route: 'compose', depth: 2, label: 'n' });
    const r = await Promise.race([grandchild('grep', { pattern: 'x' }, opts('g1')), flush().then(() => 'pending' as const)]);
    expect(r).toBe('pending');
  });
});

describe('D19: a continued agent inherits an unseen cwd', () => {
  it('agent with continuation_chain_id arms the unknown-cwd rule', async () => {
    const t = setup();
    const p = t.gate.canUseTool('agent', { prompt: 'p', continuation_chain_id: 'chain-1' }, opts('a1'));
    await flush();
    t.requests[0]!.resolve({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    expect(await p).toEqual({ behavior: 'allow' });
    const child = t.gate.forChild!({ route: 'subagent', depth: 1 });
    const r = await Promise.race([child('glob', { pattern: '**/*' }, opts('g1')), flush().then(() => 'pending' as const)]);
    expect(r).toBe('pending');
  });
});
