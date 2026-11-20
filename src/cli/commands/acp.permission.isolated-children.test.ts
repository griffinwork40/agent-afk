/**
 * RED TEAM (R2), class D: a worktree-isolated compose node runs in
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
 * Asserts the SAFE behaviour; FAILS on afk/acp-v1 bc8ac988d.
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

describe('redteam D: worktree-isolated compose node', () => {
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
