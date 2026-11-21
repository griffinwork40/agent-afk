/**
 * Regression for profile section 6 (children with an unknown cwd). Red team 2b: a `context: fork` user/project skill forks its child through a
 * cwd-less SubagentManager (src/skills/user-skills.ts:186-212, "this manager
 * passes no `cwd`"), so the child runs in the ACP server's process.cwd(), not
 * the session cwd (D14: the session cwd need not be under the launch dir).
 * The child's gate origin carries no cwd (nesting.can-use-tool.ts:180-186
 * inlineSkillChildGate -> skillChildOrigin without cwd), and `skill` is not a
 * relocating delegation (acp.permission.paths.ts relocatesChildren), so the
 * gate resolves the child's relative / missing paths against the SESSION cwd
 * and auto-allows them, and a remembered write grant covers its relative
 * writes, while the handler resolves them against the launch directory.
 *
 * Asserts the SAFE behaviour; fails on 6f18f96c7.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcpClientPeer, ToolCallStart } from './acp.wire.js';
import type { CanUseTool } from '../../agent/types.js';
import { createAcpPermissionGate } from './acp.permission.js';
import { inlineSkillChildGate } from '../../agent/tools/nesting.can-use-tool.js';
import { scanSkillsFromDir } from '../../skills/user-skills.js';
import { getSkill } from '../../skills/skill-registry.js';
import { SubagentManager } from '../../agent/subagent.js';

const launch = process.cwd();
// Session cwd deliberately NOT the launch dir (validateCwd allows any directory, D14).
const sessionCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt2b-session-')));

function setup() {
  const requests: { params: any; resolve(v: unknown): void }[] = [];
  const peer: AcpClientPeer = {
    request: (_m, params) => new Promise((resolve) => { requests.push({ params, resolve }); }),
    notify: () => Promise.resolve(),
  };
  const gate = createAcpPermissionGate(peer, 'sid', {
    skip: false, cwd: sessionCwd, onCancelled: vi.fn(), emitToolCall: vi.fn(async (_u: ToolCallStart) => {}),
    turnActive: () => true,
  });
  return { gate, requests };
}
const opts = (id: string) => ({ signal: new AbortController().signal, toolUseID: id });
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const pendingOr = (p: Promise<unknown>) => Promise.race([p, flush().then(() => 'pending' as const)]);

/** Run a real `context: fork` disk skill handler and capture what it forks. */
async function forkUserSkill(childGate: ReturnType<typeof inlineSkillChildGate>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt2b-skills-'));
  fs.mkdirSync(path.join(dir, 'rt2b-fork'));
  fs.writeFileSync(path.join(dir, 'rt2b-fork', 'SKILL.md'),
    '---\nname: rt2b-fork\ndescription: red team fork skill\ncontext: fork\n---\nList the files here.\n');
  expect(scanSkillsFromDir(dir, 'project')).toBe(1);
  let captured: { manager: SubagentManager; config: Record<string, unknown> } | undefined;
  vi.spyOn(SubagentManager.prototype, 'forkSubagent').mockImplementation(async function (this: SubagentManager, o: any) {
    captured = { manager: this, config: o.config };
    return { runToResult: async () => 'ok' } as any;
  });
  await getSkill('rt2b-fork').handler(undefined, { sessionId: 'parent', cwd: sessionCwd } as any,
    { defaultSubagentModel: 'sonnet', ...(childGate ? { childGate } : {}) } as any);
  expect(captured).toBeDefined();
  return captured!;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('children with an unknown cwd: a forked user skill runs outside the session cwd', () => {
  it('precondition: the forked child has no cwd, so it runs in the launch dir, not the session cwd', async () => {
    const t = setup();
    const c = await forkUserSkill(inlineSkillChildGate(t.gate.forChild!, 1));
    const effective = (c.config['cwd'] as string | undefined) ?? c.manager.getReadScopeInputs().parentCwd ?? launch;
    expect(launch).not.toBe(sessionCwd);
    // SAFE: the skill child runs in the session cwd. On this code it runs in process.cwd().
    expect(effective, 'user-skill child cwd').toBe(sessionCwd);
  });

  it("the child's relative read is asked (it reads the launch dir, not the session dir)", async () => {
    const t = setup();
    const c = await forkUserSkill(inlineSkillChildGate(t.gate.forChild!, 1));
    const childGate = c.config['canUseTool'] as CanUseTool;
    expect(childGate).toBeTypeOf('function');
    // The handler resolves this against process.cwd(): <launch>/../../.env etc.
    const r = await pendingOr(childGate('read_file', { file_path: '.env' }, opts('r1')));
    const g = await pendingOr(childGate('grep', { pattern: 'API_KEY' }, opts('g1')));
    expect({ read: r, grep: g }, 'relative/no-path reads in a cwd-less skill child ran without asking')
      .toEqual({ read: 'pending', grep: 'pending' });
  });

  it('a top-level "Always allow write_file" does not cover a relative write by the skill child', async () => {
    const t = setup();
    const top = t.gate.canUseTool('write_file', { file_path: 'a.txt', content: 'x' }, opts('w0'));
    await flush();
    expect(t.requests[0]!.params.options.map((o: any) => o.optionId)).toContain('allow_always');
    t.requests[0]!.resolve({ outcome: { outcome: 'selected', optionId: 'allow_always' } });
    expect(await top).toEqual({ behavior: 'allow' });

    const c = await forkUserSkill(inlineSkillChildGate(t.gate.forChild!, 1));
    const childGate = c.config['canUseTool'] as CanUseTool;
    // Real write target: path.resolve(process.cwd(), 'package.json') - outside the session cwd.
    const w = await pendingOr(childGate('write_file', { file_path: 'package.json', content: 'pwned' }, opts('w1')));
    expect(w, 'skill child overwrote <launch>/package.json under the session grant').toBe('pending');
  });
});
