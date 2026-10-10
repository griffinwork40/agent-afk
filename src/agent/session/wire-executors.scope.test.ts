/**
 * wireExecutors executor-tree scope (#3442): `pluginConfigs`, `skillAllowlist`,
 * `hookRegistry` reach the root executors AND every nested skill executor the
 * depth-aware factory builds. All three undefined => today's behaviour.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// scanAllPluginRoots (skill-bridge.ts) is built from scanLocalPlugins; mocking
// the cross-module import is the observable seam for "did a plugin scan run".
vi.mock('../plugins-scanner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../plugins-scanner.js')>()),
  scanLocalPlugins: vi.fn(() => []),
}));

import { scanLocalPlugins } from '../plugins-scanner.js';
import { wireExecutors, type WireExecutorsOptions, type WiredExecutors } from './wire-executors.js';
import { createHookRegistry } from '../hooks.js';
import type { SubagentExecutorContext } from '../tools/subagent-executor.js';
import type { SkillExecutorContext } from '../tools/skill-executor/types.js';
import type { SkillExecutor } from '../tools/skill-executor.js';

let tmpHome: string;
let prevHome: string | undefined;
const signal = new AbortController().signal;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'afk-wire-scope-'));
  prevHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpHome;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});
beforeEach(() => vi.mocked(scanLocalPlugins).mockClear());

function wire(extra: Partial<WireExecutorsOptions>): WiredExecutors {
  return wireExecutors({
    surface: 'cli',
    parentSession: {
      sessionId: 'root',
      getInputStreamRef: () => ({ pushUserMessage: () => {} }),
      abortSignal: signal,
    } as unknown as SubagentExecutorContext['parentSession'],
    apiKey: 'k',
    model: 'sonnet',
    managerParentModel: 'sonnet',
    defaultSubagentModel: 'sonnet',
    resolveApiKeyForModel: () => 'k',
    cwd: tmpHome,
    nestedCwd: tmpHome,
    agentRegistryWarn: () => {},
    ...extra,
  });
}

const skillCtx = (e: SkillExecutor): SkillExecutorContext => (e as unknown as { ctx: SkillExecutorContext }).ctx;
const agentCtx = (w: WiredExecutors): SubagentExecutorContext =>
  (w.subagentExecutor as unknown as { ctx: SubagentExecutorContext }).ctx;
/** A depth-2 skill executor built by the same factory agent/skill children get. */
const nested = (w: WiredExecutors, depth = 2): SkillExecutor =>
  skillCtx(w.skillExecutor).childSkillExecutorFactory!(depth, 4, signal, tmpHome);
const call = (name: string) => ({ id: 'c', name: 'skill', input: { name }, signal });

describe('wireExecutors pluginConfigs (#3442)', () => {
  it('pluginConfigs: [] never scans plugin roots: agent discovery, root skill, nested skill', async () => {
    const w = wire({ pluginConfigs: [] });
    await w.skillExecutor.execute(call('nope'));
    await nested(w).execute(call('nope'));
    await nested(w, 3).execute(call('nope'));
    expect(scanLocalPlugins).not.toHaveBeenCalled();
    expect(w.skillExecutor.getManifestScope()).toEqual({ pluginConfigs: [] });
    expect(nested(w).getManifestScope()).toEqual({ pluginConfigs: [] });
  });

  it('control: undefined pluginConfigs still scans (spy is live; today behaviour)', async () => {
    const w = wire({});
    expect(scanLocalPlugins).toHaveBeenCalled(); // discoverPluginAgents(undefined)
    vi.mocked(scanLocalPlugins).mockClear();
    await nested(w).execute(call('nope'));
    expect(scanLocalPlugins).toHaveBeenCalled();
    expect(w.skillExecutor.getManifestScope()).toEqual({});
  });

  it('all scope options undefined => no scope keys on any executor ctx', () => {
    const w = wire({});
    for (const ctx of [skillCtx(w.skillExecutor), skillCtx(nested(w))]) {
      expect(ctx).not.toHaveProperty('pluginConfigs');
      expect(ctx).not.toHaveProperty('skillAllowlist');
      expect(ctx).not.toHaveProperty('hookRegistry');
    }
    expect(agentCtx(w)).not.toHaveProperty('hookRegistry');
    expect((w.rootManager as unknown as { hookRegistry: unknown }).hookRegistry).toBeUndefined();
  });
});

describe('wireExecutors skillAllowlist (#3442)', () => {
  it('refuses a non-listed skill at root and at nested depth, naming the allowed set', async () => {
    const w = wire({ pluginConfigs: [], skillAllowlist: ['plugin:review', 'ground-state'] });
    for (const exec of [w.skillExecutor, nested(w), nested(w, 3)]) {
      const r = await exec.execute(call('mint'));
      expect(r.isError).toBe(true);
      expect(r.content).toContain('not allowed');
      expect(r.content).toContain('plugin:review, ground-state');
    }
    expect(nested(w).getManifestScope().skillAllowlist).toEqual(['plugin:review', 'ground-state']);
  });

  it('exact match only: plugin:name does not authorize bare name, and vice versa', async () => {
    const qualified = wire({ pluginConfigs: [], skillAllowlist: ['plugin:review'] });
    expect((await qualified.skillExecutor.execute(call('review'))).content).toContain('not allowed');
    // Listed verbatim => passes the gate (then misses lookup: no plugins).
    expect((await qualified.skillExecutor.execute(call('plugin:review'))).content).toContain('not found');

    const bare = wire({ pluginConfigs: [], skillAllowlist: ['review'] });
    expect((await nested(bare).execute(call('plugin:review'))).content).toContain('not allowed');
    expect((await nested(bare).execute(call('review'))).content).toContain('not found');
  });

  it('an empty allowlist refuses everything', async () => {
    const w = wire({ pluginConfigs: [], skillAllowlist: [] });
    const r = await w.skillExecutor.execute(call('anything'));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Allowed skills: (none)');
  });
});

describe('wireExecutors hookRegistry (#3442)', () => {
  it('reaches the root manager, the agent executor, the root and nested skill executors', () => {
    const hooks = createHookRegistry();
    const w = wire({ hookRegistry: hooks });
    expect((w.rootManager as unknown as { hookRegistry: unknown }).hookRegistry).toBe(hooks);
    expect(agentCtx(w).hookRegistry).toBe(hooks);
    expect(skillCtx(w.skillExecutor).hookRegistry).toBe(hooks);
    expect(skillCtx(nested(w)).hookRegistry).toBe(hooks);
    expect(skillCtx(nested(w, 3)).hookRegistry).toBe(hooks);
  });
});
