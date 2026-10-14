import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandExecutableBasename, gatherHooks } from './hooks-source.js';
import { buildRuntimeStateSource } from './runtime-source.js';
import { createGetRuntimeStateHandler } from './tool.js';
import { _resetPluginScanCache } from '../plugins-scanner.js';

let tmp: string;
let home: string;
let cwd: string;
let pluginsDir: string;
function writeJson(file: string, body: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
}
const commandHook = (command: string) => ({ type: 'command', command, timeout_ms: 1200 });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hooks-view-'));
  home = join(tmp, 'home');
  cwd = join(tmp, 'project');
  pluginsDir = join(home, 'plugins');
  mkdirSync(cwd, { recursive: true });
  vi.stubEnv('AFK_HOME', home);
  _resetPluginScanCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  _resetPluginScanCache();
  rmSync(tmp, { recursive: true, force: true });
});

function source(getCwd = () => cwd) {
  return buildRuntimeStateSource({
    surface: 'cli', getCwd, modelName: 'sonnet', providerName: 'anthropic-direct',
    permissionMode: 'default', getEnabledToolNames: () => [], getMcpTools: () => [],
    getMcpServerStates: () => [], getSubagents: () => ({ active: [], backgroundJobs: [] }),
  });
}

describe('hooks runtime view', () => {
  it('merges all admitted tiers in loader order without exposing command text or arguments', async () => {
    const userCommand = '/private/bin/notify.sh --password=hunter2';
    const projectCommand = 'export MY_DB_PASS=hunter2 && notify.sh';
    const pluginCommand = 'node /private/plugin/run.js --token=sk-ant-sensitive';
    writeJson(join(home, 'config', 'settings.json'), {
      enableShellHooks: true, allowProjectHooks: true, enablePluginHooks: true,
      hooks: { PreToolUse: [{ matcher: 'bash', hooks: [commandHook(userCommand)] }] },
    });
    writeJson(join(cwd, '.afk', 'settings.json'), {
      hooks: { PreToolUse: [{ hooks: [commandHook(projectCommand)] }] },
    });
    const plugin = join(pluginsDir, 'demo');
    writeJson(join(plugin, '.claude-plugin', 'plugin.json'), { name: 'demo' });
    writeJson(join(plugin, 'hooks', 'hooks.json'), {
      hooks: { PreToolUse: [{ matcher: '*', hooks: [commandHook(pluginCommand)] }] },
    });
    const result = await createGetRuntimeStateHandler(source())({ view: 'hooks' }, new AbortController().signal);
    expect(result.isError).toBeFalsy();
    const { hooks } = JSON.parse(result.content);
    expect(hooks.configured).toEqual([
      { event: 'PreToolUse', matcher: 'bash', source: 'user-global', type: 'command', timeoutMs: 1200,
        commandFingerprint: createHash('sha256').update(userCommand).digest('hex').slice(0, 12), executableBasename: 'notify.sh' },
      { event: 'PreToolUse', source: 'project-local', type: 'command', timeoutMs: 1200,
        commandFingerprint: createHash('sha256').update(projectCommand).digest('hex').slice(0, 12) },
      { event: 'PreToolUse', matcher: '*', source: 'plugin', pluginName: 'demo', type: 'command', timeoutMs: 1200,
        commandFingerprint: createHash('sha256').update(pluginCommand).digest('hex').slice(0, 12), executableBasename: 'node' },
    ]);
    for (const forbidden of [userCommand, projectCommand, pluginCommand, 'hunter2', 'MY_DB_PASS', 'sk-ant-sensitive', '/private', '--password', 'export']) {
      expect(result.content).not.toContain(forbidden);
    }
    expect(hooks).toMatchObject({ userGlobalEnabled: true, allowProjectHooks: true, pluginHooksEnabled: true, warningCount: 0, builtinListing: 'unavailable' });
  });

  it('returns an empty inventory when no hook config exists', () => {
    expect(gatherHooks({ cwd, pluginsDir })).toEqual({ configured: [], userGlobalEnabled: false,
      allowProjectHooks: false, pluginHooksEnabled: false, warningCount: 0, builtinListing: 'unavailable' });
  });

  it('honors project and plugin trust gates', () => {
    writeJson(join(cwd, '.afk', 'settings.json'), { hooks: { Stop: [{ hooks: [commandHook('notify --secret=hunter2')] }] } });
    expect(gatherHooks({ cwd, pluginsDir }).configured).toEqual([]);
  });

  it('counts loader warnings without returning attacker controlled warning text', () => {
    writeJson(join(home, 'config', 'settings.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'secret-hunter2', command: 'notify --secret=hunter2' }] }] },
    });
    const result = gatherHooks({ cwd, pluginsDir });
    expect(result.warningCount).toBe(1);
    expect(result.configured).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    writeFileSync(join(home, 'config', 'settings.json'), '{"hunter2":broken');
    expect(gatherHooks({ cwd, pluginsDir }).warningCount).toBe(1);
    expect(JSON.stringify(gatherHooks({ cwd, pluginsDir }))).not.toContain('hunter2');
  });

  it('uses the live cwd for hook configuration', () => {
    writeJson(join(home, 'config', 'settings.json'), { allowProjectHooks: true });
    const next = join(tmp, 'next');
    writeJson(join(next, '.afk', 'settings.json'), { hooks: { Stop: [{ hooks: [commandHook('notify --secret=hunter2')] }] } });
    let live = cwd;
    const runtime = source(() => live);
    expect(runtime.getHooks!().configured).toEqual([]);
    live = next;
    expect(runtime.getHooks!().configured).toHaveLength(1);
  });

  it('does not read hooks in the all view', async () => {
    const runtime = source();
    const getHooks = vi.fn(() => { throw new Error('must not read hooks'); });
    runtime.getHooks = getHooks;
    const result = await createGetRuntimeStateHandler(runtime)({ view: 'all' }, new AbortController().signal);
    expect(getHooks).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).not.toHaveProperty('hooks');
  });

  it('reports unavailable rather than an invented empty inventory for custom sources', async () => {
    const runtime = source();
    delete runtime.getHooks;
    await expect(createGetRuntimeStateHandler(runtime)({ view: 'hooks' }, new AbortController().signal))
      .rejects.toThrow('Hooks view is unavailable');
  });
});

describe('command executable basename allowlist', () => {
  it.each([
    ['notify --password=hunter2', 'notify'], ['/private/bin/notify.sh --token=secret', 'notify.sh'],
    ['./scripts/notify.sh arg', 'notify.sh'], ['  node script.js', 'node'],
    ['MY_DB_PASS=hunter2 notify', undefined], ['export MY_DB_PASS=hunter2 && notify', undefined],
    ['"/private/bin/notify.sh" arg', undefined], ['${CLAUDE_PLUGIN_ROOT}/notify.sh arg', undefined],
    ['$(cat secret) notify', undefined], ['notify;echo secret', undefined], ['notify&&echo secret', undefined],
    ['notify>secret', undefined], ['(notify secret)', undefined], ['# secret', undefined],
    ['', undefined], ['.', undefined], ['..', undefined], ['--secret', undefined],
    ['declare -x SECRET=hunter2', undefined], ['if true; then notify; fi', undefined],
  ])('projects %j to %j', (command, expected) => {
    expect(commandExecutableBasename(command)).toBe(expected);
  });
});
