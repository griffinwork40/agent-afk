import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadMcpConfigFile,
  loadMcpConfig,
  discoverPluginMcpConfigs,
} from './config-loader.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcp-config-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeJson(name: string, body: unknown): string {
  const path = join(tmp, name);
  writeFileSync(path, JSON.stringify(body), 'utf-8');
  return path;
}

describe('loadMcpConfigFile', () => {
  it('returns empty result when the file is missing (not an error)', () => {
    const result = loadMcpConfigFile(join(tmp, 'absent.json'));
    expect(result.mcpServers).toEqual({});
    expect(result.warnings).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it('parses a well-formed stdio config', () => {
    const path = writeJson('mcp.json', {
      mcpServers: {
        filesystem: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          env: { LOG_LEVEL: 'warn' },
        },
      },
    });
    const result = loadMcpConfigFile(path);
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers.filesystem).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { LOG_LEVEL: 'warn' },
    });
  });

  it('infers type=stdio when `command` is present and `type` is omitted', () => {
    const path = writeJson('mcp.json', {
      mcpServers: { fs: { command: 'cat' } },
    });
    const result = loadMcpConfigFile(path);
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers.fs?.type).toBe('stdio');
  });

  it('infers type=streamable-http when `url` is present and `type` is omitted', () => {
    const path = writeJson('mcp.json', {
      mcpServers: { remote: { url: 'https://example.com/mcp' } },
    });
    const result = loadMcpConfigFile(path);
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers.remote?.type).toBe('streamable-http');
  });

  it('skips a stdio entry missing `command` with a warning', () => {
    const path = writeJson('mcp.json', {
      mcpServers: {
        broken: { type: 'stdio' },
        ok: { type: 'stdio', command: 'bash' },
      },
    });
    const result = loadMcpConfigFile(path);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/broken/);
    expect(Object.keys(result.mcpServers)).toEqual(['ok']);
  });

  it('preserves `disabled`, `alwaysLoad`, `oauth`, and `timeout` flags', () => {
    const path = writeJson('mcp.json', {
      mcpServers: {
        a: { type: 'stdio', command: 'x', disabled: true },
        b: { type: 'streamable-http', url: 'https://b', alwaysLoad: true, oauth: true, timeout: 12345 },
      },
    });
    const result = loadMcpConfigFile(path);
    expect(result.mcpServers.a?.disabled).toBe(true);
    expect(result.mcpServers.b?.alwaysLoad).toBe(true);
    expect(result.mcpServers.b?.oauth).toBe(true);
    expect(result.mcpServers.b?.timeout).toBe(12345);
  });

  it('reports JSON parse errors as warnings (not throws)', () => {
    const path = join(tmp, 'broken.json');
    writeFileSync(path, '{ not valid json', 'utf-8');
    const result = loadMcpConfigFile(path);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/parse error/);
    expect(result.mcpServers).toEqual({});
  });

  it('treats missing `mcpServers` key as empty', () => {
    const path = writeJson('mcp.json', { other: 'field' });
    const result = loadMcpConfigFile(path);
    expect(result.warnings).toEqual([]);
    expect(result.mcpServers).toEqual({});
  });
});

describe('discoverPluginMcpConfigs', () => {
  it('returns empty when plugins root is missing', () => {
    expect(discoverPluginMcpConfigs(join(tmp, 'absent'))).toEqual([]);
  });

  it('finds <plugin>/.claude-plugin/mcp.json in flat layout', () => {
    const plug = join(tmp, 'my-plugin', '.claude-plugin');
    mkdirSync(plug, { recursive: true });
    writeFileSync(join(plug, 'plugin.json'), '{}', 'utf-8');
    writeFileSync(join(plug, 'mcp.json'), '{}', 'utf-8');
    expect(discoverPluginMcpConfigs(tmp)).toEqual([join(plug, 'mcp.json')]);
  });

  it('finds plugins under the marketplace-cache layout', () => {
    const plug = join(tmp, 'cache', 'official', 'remote-plug', '.claude-plugin');
    mkdirSync(plug, { recursive: true });
    writeFileSync(join(plug, 'plugin.json'), '{}', 'utf-8');
    writeFileSync(join(plug, 'mcp.json'), '{}', 'utf-8');
    expect(discoverPluginMcpConfigs(tmp)).toEqual([join(plug, 'mcp.json')]);
  });

  it('skips plugins that have no mcp.json', () => {
    const plug = join(tmp, 'plain-plugin', '.claude-plugin');
    mkdirSync(plug, { recursive: true });
    writeFileSync(join(plug, 'plugin.json'), '{}', 'utf-8');
    expect(discoverPluginMcpConfigs(tmp)).toEqual([]);
  });
});

describe('loadMcpConfig (layered)', () => {
  let afkHome: string;
  let projectCwd: string;
  let pluginsRoot: string;
  let originalAfkHome: string | undefined;

  beforeEach(() => {
    afkHome = join(tmp, 'afk-home');
    projectCwd = join(tmp, 'project');
    pluginsRoot = join(afkHome, 'plugins');
    mkdirSync(join(afkHome, 'config'), { recursive: true });
    mkdirSync(projectCwd, { recursive: true });
    mkdirSync(pluginsRoot, { recursive: true });
    originalAfkHome = process.env['AFK_HOME'];
    process.env['AFK_HOME'] = afkHome;
  });

  afterEach(() => {
    if (originalAfkHome === undefined) delete process.env['AFK_HOME'];
    else process.env['AFK_HOME'] = originalAfkHome;
    vi.restoreAllMocks();
  });

  function writeUserGlobal(body: unknown): void {
    writeFileSync(join(afkHome, 'config', 'mcp.json'), JSON.stringify(body), 'utf-8');
  }
  function writeProjectLocal(body: unknown): void {
    writeFileSync(join(projectCwd, '.mcp.json'), JSON.stringify(body), 'utf-8');
  }
  function writePluginContrib(name: string, body: unknown): string {
    const dir = join(pluginsRoot, name, '.claude-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), '{}', 'utf-8');
    const p = join(dir, 'mcp.json');
    writeFileSync(p, JSON.stringify(body), 'utf-8');
    return p;
  }

  it('returns empty when no layer contributes anything', () => {
    const result = loadMcpConfig({ cwd: projectCwd, pluginsRoot });
    expect(result.mcpServers).toEqual({});
    expect(result.warnings).toEqual([]);
  });

  it('reads user-global by default', () => {
    writeUserGlobal({ mcpServers: { a: { type: 'stdio', command: 'x' } } });
    const result = loadMcpConfig({ cwd: projectCwd, pluginsRoot });
    expect(result.mcpServers.a?.command).toBe('x');
  });

  it('project-local overrides user-global on conflict with a warning', () => {
    writeUserGlobal({ mcpServers: { a: { type: 'stdio', command: 'user' } } });
    writeProjectLocal({ mcpServers: { a: { type: 'stdio', command: 'project' } } });
    const result = loadMcpConfig({ cwd: projectCwd, pluginsRoot });
    expect(result.mcpServers.a?.command).toBe('project');
    expect(result.warnings.some((w) => w.includes('overridden'))).toBe(true);
  });

  it('CLI override wins over project-local and user-global', () => {
    writeUserGlobal({ mcpServers: { a: { type: 'stdio', command: 'user' } } });
    writeProjectLocal({ mcpServers: { a: { type: 'stdio', command: 'project' } } });
    const cliPath = join(tmp, 'cli.json');
    writeFileSync(
      cliPath,
      JSON.stringify({ mcpServers: { a: { type: 'stdio', command: 'cli' } } }),
      'utf-8',
    );
    const result = loadMcpConfig({
      cwd: projectCwd,
      pluginsRoot,
      cliOverride: cliPath,
    });
    expect(result.mcpServers.a?.command).toBe('cli');
  });

  it('plugin-contributed configs sit at the lowest priority', () => {
    writePluginContrib('p1', {
      mcpServers: { plug: { type: 'stdio', command: 'plug' } },
    });
    writeUserGlobal({ mcpServers: { plug: { type: 'stdio', command: 'user' } } });
    const result = loadMcpConfig({ cwd: projectCwd, pluginsRoot });
    expect(result.mcpServers.plug?.command).toBe('user');
    expect(result.warnings.some((w) => w.includes('overridden'))).toBe(true);
  });

  it('imported MCP configs sit below plugins — user-global wins on conflict', () => {
    const importedPath = writeJson('imported-mcp.json', {
      mcpServers: { shared: { type: 'stdio', command: 'imported' } },
    });
    writeUserGlobal({ mcpServers: { shared: { type: 'stdio', command: 'user' } } });
    const result = loadMcpConfig({
      cwd: projectCwd,
      pluginsRoot,
      importedMcpConfigs: [importedPath],
    });
    // User-global (higher layer) wins the name; the imported entry is displaced.
    expect(result.mcpServers.shared?.command).toBe('user');
    expect(result.warnings.some((w) => w.includes('overridden'))).toBe(true);
  });

  it('imported MCP configs contribute non-conflicting servers', () => {
    const importedPath = writeJson('imported-mcp.json', {
      mcpServers: { fromImport: { type: 'stdio', command: 'i' } },
    });
    writeUserGlobal({ mcpServers: { fromUser: { type: 'stdio', command: 'u' } } });
    const result = loadMcpConfig({
      cwd: projectCwd,
      pluginsRoot,
      importedMcpConfigs: [importedPath],
    });
    expect(Object.keys(result.mcpServers).sort()).toEqual(['fromImport', 'fromUser']);
  });

  it('non-conflicting servers from every layer all merge into the result', () => {
    writePluginContrib('p1', {
      mcpServers: { fromPlugin: { type: 'stdio', command: 'p' } },
    });
    writeUserGlobal({
      mcpServers: { fromUser: { type: 'stdio', command: 'u' } },
    });
    writeProjectLocal({
      mcpServers: { fromProject: { type: 'stdio', command: 'pr' } },
    });
    const result = loadMcpConfig({ cwd: projectCwd, pluginsRoot });
    expect(Object.keys(result.mcpServers).sort()).toEqual([
      'fromPlugin',
      'fromProject',
      'fromUser',
    ]);
    // project-local load now emits a security notice
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/project-local/);
  });

  it('honors skipUserGlobal and skipProjectLocal', () => {
    writeUserGlobal({ mcpServers: { a: { type: 'stdio', command: 'user' } } });
    writeProjectLocal({ mcpServers: { b: { type: 'stdio', command: 'project' } } });
    const result = loadMcpConfig({
      cwd: projectCwd,
      pluginsRoot,
      skipUserGlobal: true,
      skipProjectLocal: true,
    });
    expect(result.mcpServers).toEqual({});
  });

  it('skips plugin scan when pluginsRoot is null', () => {
    writePluginContrib('p1', {
      mcpServers: { plug: { type: 'stdio', command: 'plug' } },
    });
    const result = loadMcpConfig({ cwd: projectCwd, pluginsRoot: null });
    expect(result.mcpServers).toEqual({});
  });

  it('emits a security notice when project-local .mcp.json is loaded', () => {
    writeProjectLocal({ mcpServers: { a: { type: 'stdio', command: 'x' } } });
    const result = loadMcpConfig({ cwd: projectCwd, pluginsRoot });
    expect(result.mcpServers.a?.command).toBe('x');
    expect(result.warnings.some((w) => w.includes('project-local'))).toBe(true);
  });

  it('skips project-local layer when AFK_ALLOW_PROJECT_MCP=0', () => {
    writeProjectLocal({ mcpServers: { local: { type: 'stdio', command: 'local' } } });
    const prev = process.env['AFK_ALLOW_PROJECT_MCP'];
    process.env['AFK_ALLOW_PROJECT_MCP'] = '0';
    try {
      const result = loadMcpConfig({ cwd: projectCwd, pluginsRoot });
      expect(result.mcpServers['local']).toBeUndefined();
      expect(result.warnings.every((w) => !w.includes('project-local'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['AFK_ALLOW_PROJECT_MCP'];
      else process.env['AFK_ALLOW_PROJECT_MCP'] = prev;
    }
  });
});
