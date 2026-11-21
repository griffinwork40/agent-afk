/**
 * Inline skill handlers fork through their OWN SubagentManager. With a
 * surface gate in SkillExecutionContext.childGate, every fork config they
 * build carries it as `config.canUseTool`, which the child's session resolves
 * into its provider (bareProviderResolver). Only SubagentManager is replaced,
 * by a recorder that captures each fork's config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentConfig, CanUseTool } from '../agent/types.js';
import type { ModelProvider } from '../agent/provider.js';
import type { SessionToolDispatcher } from '../agent/tools/dispatcher.js';
import type { ToolResult } from '../agent/tools/types.js';

const forks = vi.hoisted(() => ({ configs: [] as Array<{ config: AgentConfig; agentType?: string }> }));
vi.mock('../agent/subagent.js', () => ({
  SubagentManager: vi.fn(function () {
    return {
      forkSubagent: vi.fn(async (opts: { config: AgentConfig; agentType?: string }) => {
        forks.configs.push({ config: opts.config, ...(opts.agentType !== undefined ? { agentType: opts.agentType } : {}) });
        return { id: 'h', runToResult: vi.fn(async () => ({ status: 'failed' })), teardown: vi.fn(async () => {}), cancel: vi.fn() };
      }),
      teardownAll: vi.fn(async () => {}),
    };
  }),
}));
vi.mock('../agent/subagent/wave.js', () => ({ runWave: vi.fn(async (tasks: unknown[]) => tasks.map(() => ({ id: 'r', status: 'succeeded', output: [] }))) }));
vi.mock('../agent/routing-telemetry.js', () => ({ appendRoutingDecision: vi.fn(async () => {}) }));

import { bareProviderResolver } from '../agent/session/provider-lifecycle.js';
import { scanSkillsFromDir } from './user-skills.js';
import { getSkill, _resetRegistry } from './skill-registry.js';
import { handler as auditFitHandler } from './audit-fit/handler.js';
import { runBuildPhase } from './mint/_phases/build.js';
import { runSpecPhase } from './mint/_phases/spec.js';
import { setMintChildGate } from './mint/_phases/child-gate.js';

let tmp: string;
let prevHome: string | undefined;
const opened: ModelProvider[] = [];
beforeEach(() => {
  forks.configs.length = 0;
  tmp = mkdtempSync(join(tmpdir(), 'afk-inline-gate-'));
  prevHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmp;
  _resetRegistry();
});
afterEach(() => {
  for (const p of opened.splice(0)) { try { p.close?.(); } catch { /* closed */ } }
  _resetRegistry();
  if (prevHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

const parent = { sessionId: 'root', abortSignal: new AbortController().signal } as never;

function recording(): { childGate: (t: string) => CanUseTool; labels: string[]; calls: string[] } {
  const labels: string[] = [];
  const calls: string[] = [];
  return {
    labels, calls,
    childGate: (agentType) => {
      labels.push(agentType);
      return async (tool) => { calls.push(`${agentType}:${tool}`); return tool === 'write_file' ? { behavior: 'deny', message: `GUI denied ${tool}` } : { behavior: 'allow' }; };
    },
  };
}

async function runInChild(config: AgentConfig, tool: string, input: Record<string, unknown>): Promise<ToolResult> {
  const p = bareProviderResolver(config)('sonnet');
  opened.push(p);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (p as any).buildDispatcher('default', { cwd: tmp, readRoots: [tmp], writeRoots: [tmp], sessionId: 'root', parentSessionId: 'root', subagentId: 'c' }) as SessionToolDispatcher;
  return d.execute({ id: 't', name: tool, input, signal: new AbortController().signal });
}

async function expectGatedFork(config: AgentConfig): Promise<void> {
  const target = join(tmp, `denied-${Math.random().toString(36).slice(2)}.txt`);
  const r = await runInChild(config, 'write_file', { file_path: target, content: 'x' });
  expect(r.failureClass).toBe('permission-denied');
  expect(String(r.content)).toContain('GUI denied write_file');
  expect(existsSync(target)).toBe(false);
  const ok = await runInChild(config, 'list_directory', { path: tmp });
  expect(ok.failureClass).not.toBe('permission-denied');
}

function userForkSkill(): NonNullable<ReturnType<typeof getSkill>> {
  const dir = join(tmp, 'skills', 'myfork');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: myfork\ndescription: d\ncontext: fork\n---\nDo the thing.\n');
  expect(scanSkillsFromDir(join(tmp, 'skills'), 'user')).toBe(1);
  return getSkill('myfork')!;
}

describe('inline handlers carry ctx.childGate onto every fork config', () => {
  it('user-authored SKILL.md with context: fork', async () => {
    const g = recording();
    await userForkSkill().handler('args', parent, { defaultSubagentModel: 'sonnet', childGate: g.childGate }).catch(() => undefined);
    const fork = forks.configs[0]!;
    expect(g.labels).toEqual(['user-skill-myfork']);
    await expectGatedFork(fork.config);
  });

  it('/audit-fit inspectors: own allowlist first, then the surface gate', async () => {
    const g = recording();
    await auditFitHandler({ scope: 'user', writeBriefs: false }, parent, { defaultSubagentModel: 'sonnet', childGate: g.childGate }).catch(() => undefined);
    expect(forks.configs.length).toBeGreaterThan(0);
    const cfg = forks.configs[0]!.config;
    // write_file is outside the inspector allowlist: denied without asking.
    const w = await runInChild(cfg, 'write_file', { file_path: join(tmp, 'a.txt'), content: 'x' });
    expect(w.failureClass).toBe('permission-denied');
    expect(g.calls).toEqual([]);
    await runInChild(cfg, 'read_file', { file_path: join(tmp, 'nope') });
    expect(g.calls[0]).toMatch(/^inspector-\w+:read_file$/);
  });

  it('/mint phases (read-write build, read-only spec) read the recorded gate', async () => {
    const g = recording();
    setMintChildGate('root', g.childGate);
    await runBuildPhase('plan', undefined, 'root', tmp, undefined, 'sonnet').catch(() => undefined);
    await runSpecPhase('idea', 'root', tmp, undefined, 'sonnet').catch(() => undefined);
    setMintChildGate('root', undefined);
    expect(forks.configs.map((f) => f.agentType)).toEqual(['mint-build', 'mint-spec']);
    expect(g.labels).toEqual(['mint-build', 'mint-spec']);
    for (const f of forks.configs) await expectGatedFork(f.config);
  });
});

describe('ctx.childGate absent: fork configs unchanged', () => {
  it('no canUseTool key on user-skill or mint forks; audit-fit keeps only its own allowlist', async () => {
    await userForkSkill().handler(undefined, parent, { defaultSubagentModel: 'sonnet' }).catch(() => undefined);
    await runBuildPhase('plan', undefined, 'root', tmp, undefined, 'sonnet').catch(() => undefined);
    for (const f of forks.configs) expect('canUseTool' in f.config).toBe(false);
    const target = join(tmp, 'ungated.txt');
    const r = await runInChild(forks.configs[0]!.config, 'write_file', { file_path: target, content: 'x' });
    expect(r.isError).toBeFalsy();
    forks.configs.length = 0;
    await auditFitHandler({ scope: 'user', writeBriefs: false }, parent, { defaultSubagentModel: 'sonnet' }).catch(() => undefined);
    const w = await runInChild(forks.configs[0]!.config, 'read_file', { file_path: join(tmp, 'nope') });
    expect(w.failureClass).not.toBe('permission-denied');
  });
});
