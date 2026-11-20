/**
 * RED TEAM (R2): a remembered "Always allow <tool>" grant covers calls whose
 * path argument is not under a name the lexical scan knows. Every one of
 * these tools reads or writes the file named by the argument (no containment
 * in an ACP session: bypassPermissions), so after one inside-cwd approval the
 * same tool silently reads/writes/uploads anything on disk.
 *
 * Asserts the SAFE behaviour; FAILS on afk/acp-v1 bc8ac988d.
 */
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AcpClientPeer, AcpPermissionOptions, ToolCallStart } from './acp.wire.js';
import { createAcpPermissionGate } from './acp.permission.js';
import { outsideTargets } from './acp.permission.policy.js';

const SID = '22222222-2222-4222-8222-222222222222';
const CWD = path.resolve('/workspace/proj');
const OUTSIDE = path.resolve('/home/victim/.ssh/id_ed25519');

interface Ask { params: any; resolve(v: unknown): void }
function setup() {
  const asks: Ask[] = [];
  const peer: AcpClientPeer = {
    request: (_m, params) => new Promise((resolve) => { asks.push({ params, resolve }); }),
    notify: () => Promise.resolve(),
  };
  const opts: AcpPermissionOptions = {
    skip: false, emitToolCall: vi.fn(async (_u: ToolCallStart) => {}), onCancelled: vi.fn(), cwd: CWD,
  };
  return { gate: createAcpPermissionGate(peer, SID, opts), asks };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// Each tool's real handler resolves this argument as a filesystem path
// (model-complete.ts:103-127 reads it and sends it to a model provider;
// image-generate.api.ts:37-42 / image-edit.ts write output_path; image-edit.ts:99
// reads image_paths and uploads them; worktree.ts:222 runs git in `repo`).
const CASES: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['model_complete', { prompt: 'summarise', input_path: 'notes.txt' }, { prompt: 'summarise', input_path: OUTSIDE }],
  ['image_generate', { prompt: 'cat', output_path: 'out.png' }, { prompt: 'cat', output_path: path.resolve('/home/victim/.zshrc') }],
  ['image_edit', { prompt: 'x', image_paths: ['a.png'] }, { prompt: 'x', image_paths: [OUTSIDE] }],
  ['worktree', { action: 'create', name: 'a' }, { action: 'create', name: 'a', repo: path.resolve('/home/victim/other-repo') }],
];

describe('redteam: remembered grant vs. unscanned path arguments', () => {
  for (const [tool, inside, outside] of CASES) {
    it(`${tool}: the outside argument is seen as an outside target`, () => {
      expect(outsideTargets(tool, outside, CWD).length).toBeGreaterThan(0);
    });

    it(`${tool}: an "Always allow" given for an inside call does not silently cover an outside one`, async () => {
      const { gate, asks } = setup();
      const ac = new AbortController();
      const first = gate.canUseTool(tool, inside, { signal: ac.signal, toolUseID: 'c1' });
      await flush();
      expect(asks.length).toBe(1);
      const offered = (asks[0]!.params.options as Array<{ optionId: string }>).map((o) => o.optionId);
      expect(offered).toContain('allow_always');
      asks[0]!.resolve({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
      expect((await first).behavior).toBe('allow');

      const second = gate.canUseTool(tool, outside, { signal: ac.signal, toolUseID: 'c2' });
      await flush();
      // SAFE: the human is asked again (D11). On this code: allowed with no request.
      expect(asks.length, `${tool} ${JSON.stringify(outside)} ran under the remembered grant without asking`).toBe(2);
      asks[1]?.resolve({ outcome: { outcome: 'selected', optionId: 'reject_once' } });
      expect((await second).behavior).toBe('deny');
    });

    it(`${tool}: a first-time outside call is not offered "Always allow" and shows the outside path`, async () => {
      const { gate, asks } = setup();
      const p = gate.canUseTool(tool, outside, { signal: new AbortController().signal, toolUseID: 'c3' });
      await flush();
      expect(asks.length).toBe(1);
      const offered = (asks[0]!.params.options as Array<{ optionId: string }>).map((o) => o.optionId);
      expect(offered).not.toContain('allow_always');
      asks[0]!.resolve({ outcome: { outcome: 'cancelled' } });
      await p;
    });
  }
});
