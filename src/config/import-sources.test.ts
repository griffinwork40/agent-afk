/**
 * Tests for cross-tool asset import: config parsing, source detection, and
 * root resolution. Uses an injectable `home` so we can lay out a fake
 * `~/.claude` / `~/.codex` tree under a tmp dir without touching real state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectSources,
  importFromConfigPaths,
  loadImportFromConfig,
  parseImportFromConfig,
  readMcpServers,
  readSourceEnabledState,
  resolveImportedRoots,
} from './import-sources.js';

let home: string;

function writePlugin(root: string, name: string): void {
  const dir = join(root, name, '.claude-plugin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
}

function writeSkill(root: string, name: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill\n---\nbody\n`,
  );
}

beforeEach(() => {
  vi.stubEnv('CODEX_HOME', '');
  home = join(tmpdir(), `afk-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

describe('parseImportFromConfig', () => {
  it('returns undefined for non-objects', () => {
    expect(parseImportFromConfig(undefined)).toBeUndefined();
    expect(parseImportFromConfig(null)).toBeUndefined();
    expect(parseImportFromConfig('claude-code')).toBeUndefined();
    expect(parseImportFromConfig([])).toBeUndefined();
  });

  it('expands a bare `true` to all-asset-types-on', () => {
    expect(parseImportFromConfig({ 'claude-code': true })).toEqual({
      'claude-code': { plugins: true, skills: true, mcp: true },
    });
  });

  it('treats `false` and absent the same (omitted)', () => {
    expect(parseImportFromConfig({ 'claude-code': false })).toBeUndefined();
  });

  it('reads explicit per-asset toggles, defaulting missing keys to false', () => {
    expect(parseImportFromConfig({ codex: { plugins: true } })).toEqual({
      codex: { plugins: true, skills: false, mcp: false },
    });
  });

  it('drops unknown binary keys', () => {
    expect(parseImportFromConfig({ cursor: true, 'claude-code': true })).toEqual({
      'claude-code': { plugins: true, skills: true, mcp: true },
    });
  });
});

describe('resolveImportedRoots', () => {
  it('returns empty roots when config is undefined', () => {
    expect(resolveImportedRoots(undefined, home)).toEqual({
      pluginRoots: [],
      skillRoots: [],
      mcpConfigs: [],
    });
  });

  it('resolves only enabled asset types whose roots exist on disk', () => {
    const claudePlugins = join(home, '.claude', 'plugins');
    const claudeSkills = join(home, '.claude', 'skills');
    writePlugin(claudePlugins, 'foo');
    writeSkill(claudeSkills, 'bar');
    writeFileSync(join(home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: {} }));

    const resolved = resolveImportedRoots(
      { 'claude-code': { plugins: true, skills: true, mcp: false } },
      home,
    );
    expect(resolved.pluginRoots).toEqual([{ dir: claudePlugins, binary: 'claude-code' }]);
    expect(resolved.skillRoots).toEqual([{ dir: claudeSkills, origin: 'imported:claude-code' }]);
    expect(resolved.mcpConfigs).toEqual([]); // mcp disabled
  });

  it('includes the MCP config (first existing candidate) when mcp is enabled', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'mcp.json'), JSON.stringify({ mcpServers: {} }));
    const resolved = resolveImportedRoots(
      { 'claude-code': { plugins: false, skills: false, mcp: true } },
      home,
    );
    expect(resolved.mcpConfigs).toEqual([
      { source: join(home, '.claude', 'mcp.json'), format: 'json' },
    ]);
  });

  it('skips roots that do not exist', () => {
    const resolved = resolveImportedRoots({ 'claude-code': { plugins: true, skills: true, mcp: true } }, home);
    expect(resolved.pluginRoots).toEqual([]);
    expect(resolved.skillRoots).toEqual([]);
    expect(resolved.mcpConfigs).toEqual([]);
  });
});

describe('readSourceEnabledState', () => {
  function writeClaudeSettings(content: unknown): void {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(content));
  }

  it('reads Claude Code enabledPlugins as a name@marketplace → bool map', () => {
    writeClaudeSettings({
      enabledPlugins: { 'foo@mp': true, 'bar@mp': false },
      otherKey: 'ignored',
    });
    const map = readSourceEnabledState('claude-code', home);
    expect(map.get('foo@mp')).toBe(true);
    expect(map.get('bar@mp')).toBe(false);
    expect(map.size).toBe(2);
  });

  it('returns an empty map when settings.json is missing', () => {
    expect(readSourceEnabledState('claude-code', home).size).toBe(0);
  });

  it('returns an empty map when settings.json is malformed JSON (fail-open)', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not valid json');
    expect(readSourceEnabledState('claude-code', home).size).toBe(0);
  });

  it('returns an empty map when enabledPlugins is absent or not a plain object', () => {
    writeClaudeSettings({ someOtherSetting: true });
    expect(readSourceEnabledState('claude-code', home).size).toBe(0);
    writeClaudeSettings({ enabledPlugins: ['foo@mp'] });
    expect(readSourceEnabledState('claude-code', home).size).toBe(0);
  });

  it('ignores non-boolean enabledPlugins values', () => {
    writeClaudeSettings({ enabledPlugins: { 'a@mp': true, 'b@mp': 'yes', 'c@mp': 1 } });
    const map = readSourceEnabledState('claude-code', home);
    expect(map.get('a@mp')).toBe(true);
    expect(map.has('b@mp')).toBe(false);
    expect(map.has('c@mp')).toBe(false);
  });

  it('reads disabled Codex plugins', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), '[plugins."x@mp"]\nenabled = false\n');
    expect(readSourceEnabledState('codex', home).get('x@mp')).toBe(false);
  });
});

describe('detectSources', () => {
  it('selects registered global installs instead of old caches and marketplace copies', () => {
    const root = join(home, '.claude', 'plugins');
    for (const version of ['1.0', '2.0']) writePlugin(join(root, 'cache', 'mp', version), 'demo');
    writePlugin(join(root, 'marketplaces', 'mp'), 'demo');
    writePlugin(root, 'project-only');
    const active = join(root, 'cache', 'mp', '2.0', 'demo');
    writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
      'demo@mp': [{ scope: 'user', installPath: active }, { scope: 'managed', installPath: active }],
      'project-only@mp': [{ scope: 'local', installPath: join(root, 'project-only') }],
    } }));
    // path is now the resolved realpath (symlinks expanded) — use realpathSync
    // so the assertion survives macOS /var → /private/var aliasing.
    expect(detectSources(home).find((s) => s.binary === 'claude-code')?.plugins)
      .toEqual([{ name: 'demo', path: realpathSync(active) }]);
  });

  it('does not load cached plugins when the installed registry is empty or malformed', () => {
    const root = join(home, '.claude', 'plugins');
    writePlugin(root, 'stale');
    for (const content of ['{', JSON.stringify({ version: 2, plugins: {} })]) {
      writeFileSync(join(root, 'installed_plugins.json'), content);
      expect(detectSources(home).find((s) => s.binary === 'claude-code')?.plugins).toEqual([]);
    }
  });

  it('deduplicates fallback discovery without an installed registry', () => {
    const root = join(home, '.codex', 'plugins');
    writePlugin(join(root, 'a'), 'demo');
    writePlugin(join(root, 'b'), 'demo');
    expect(detectSources(home).find((s) => s.binary === 'codex')?.plugins).toHaveLength(1);
  });

  it('uses CODEX_HOME for native plugins, skills, MCP and enablement', () => {
    const codex = join(home, 'custom-codex');
    vi.stubEnv('CODEX_HOME', codex);
    for (const version of ['1.9', '1.10']) {
      const dir = join(codex, 'plugins', 'cache', 'mp', 'native', version, '.codex-plugin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'native' }));
    }
    writePlugin(join(home, '.codex', 'plugins'), 'wrong-home');
    writeSkill(join(codex, 'skills'), 'custom');
    writeSkill(join(home, '.agents', 'skills'), 'shared');
    writeFileSync(join(codex, 'config.toml'), '[plugins."native@mp"]\nenabled = false # disabled\n[mcp_servers.test]\ncommand = "server"\n');
    const detected = detectSources(home).find((s) => s.binary === 'codex');
    expect(detected?.plugins).toEqual([{ name: 'native', path: join(codex, 'plugins', 'cache', 'mp', 'native', '1.10') }]);
    expect(detected?.skills.map((s) => s.name)).toEqual(['custom', 'shared']);
    expect(detected?.mcpServers).toEqual([{ name: 'test', command: 'server' }]);
    expect(readSourceEnabledState('codex', home).get('native@mp')).toBe(false);
    expect(resolveImportedRoots({ codex: { plugins: true, skills: true, mcp: true } }, home)).toEqual({
      pluginRoots: [{ dir: join(codex, 'plugins'), binary: 'codex' }],
      skillRoots: [
        { dir: join(codex, 'skills'), origin: 'imported:codex' },
        { dir: join(home, '.agents', 'skills'), origin: 'imported:codex' },
      ],
      mcpConfigs: [{ source: join(codex, 'config.toml'), format: 'toml' }],
    });
  });

  it('marks a binary not-present when nothing exists', () => {
    const sources = detectSources(home);
    const claude = sources.find((s) => s.binary === 'claude-code')!;
    expect(claude.present).toBe(false);
    expect(claude.plugins).toEqual([]);
    expect(claude.skills).toEqual([]);
  });

  it('enumerates plugins and skills found on disk', () => {
    writePlugin(join(home, '.claude', 'plugins'), 'p1');
    writeSkill(join(home, '.claude', 'skills'), 's1');
    const claude = detectSources(home).find((s) => s.binary === 'claude-code')!;
    expect(claude.present).toBe(true);
    expect(claude.plugins.map((p) => p.name)).toEqual(['p1']);
    expect(claude.skills.map((s) => s.name)).toEqual(['s1']);
  });

  it('discovers marketplace-cache-layout plugins', () => {
    writePlugin(join(home, '.claude', 'plugins', 'cache', 'mp', 'deep'), 'cached');
    const claude = detectSources(home).find((s) => s.binary === 'claude-code')!;
    expect(claude.plugins.map((p) => p.name)).toContain('cached');
  });

  it('reads MCP server names + commands from a JSON config (Claude Code)', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
          remote: { url: 'https://example.com/mcp' },
        },
      }),
    );
    const claude = detectSources(home).find((s) => s.binary === 'claude-code')!;
    expect(claude.mcpServers).toEqual([
      { name: 'github', command: 'npx -y @modelcontextprotocol/server-github' },
      { name: 'remote', command: 'https://example.com/mcp' },
    ]);
  });

  it('reads MCP servers from a Codex TOML config', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.fs]',
        'command = "mcp-fs"',
        '',
        '[mcp_servers.web]',
        'url = "https://web.example/mcp"',
        '',
        '[mcp_servers.gh]',
        'command = "npx"',
        'args = ["-y", "pkg"]',
        '',
        '[other]',
        'key = "value"',
      ].join('\n'),
    );
    const codex = detectSources(home).find((s) => s.binary === 'codex')!;
    expect(codex.mcpFormat).toBe('toml');
    expect(codex.mcpServers).toEqual([
      { name: 'fs', command: 'mcp-fs' },
      { name: 'web', command: 'https://web.example/mcp' },
      { name: 'gh', command: 'npx -y pkg' },
    ]);
  });
});

describe('plugin-discovery: per-entry realpathSync isolation', () => {
  it('skips a dangling installPath entry and still returns other valid entries', () => {
    const root = join(home, '.claude', 'plugins');
    // writePlugin(pluginRoot, name) writes pluginRoot/name/.claude-plugin/plugin.json,
    // so the installPath for the registry is pluginRoot/name.
    const pluginRoot = join(root, 'cache', 'mp', '1.0');
    writePlugin(pluginRoot, 'good');
    const goodPath = join(pluginRoot, 'good');
    // Write the registry with two plugin keys: one with a dangling path, one valid
    writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'bad@mp': [{ scope: 'user', installPath: join(root, 'does-not-exist', 'bad') }],
        'good@mp': [{ scope: 'user', installPath: goodPath }],
      },
    }));
    const plugins = detectSources(home).find((s) => s.binary === 'claude-code')?.plugins ?? [];
    // The dangling entry must NOT cause the whole batch to be discarded.
    // path is now the resolved realpath — use realpathSync to survive macOS aliasing.
    expect(plugins).toEqual([{ name: 'good', path: realpathSync(goodPath) }]);
  });

  it('skips a symlink-to-deleted-target entry (dangling symlink) and returns other valid entries', () => {
    const root = join(home, '.claude', 'plugins');
    // Create a real plugin directory that the symlink will initially point to
    const realTarget = join(home, 'real-plugin-target');
    writePlugin(realTarget, 'gone');
    const targetPath = join(realTarget, 'gone');

    // Create a symlink pointing to the target, then delete the target
    const symlinkDir = join(root, 'symlinked');
    mkdirSync(symlinkDir, { recursive: true });
    const symlinkPath = join(symlinkDir, 'gone');
    symlinkSync(targetPath, symlinkPath);
    // Remove the real target — symlink is now dangling
    rmSync(realTarget, { recursive: true, force: true });

    // Create a valid second plugin for the registry
    const pluginRoot = join(root, 'cache', 'mp', '1.0');
    writePlugin(pluginRoot, 'valid');
    const validPath = join(pluginRoot, 'valid');

    writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        // Entry whose installPath is a symlink pointing to a now-deleted target
        'gone@mp': [{ scope: 'user', installPath: symlinkPath }],
        'valid@mp': [{ scope: 'user', installPath: validPath }],
      },
    }));

    const plugins = detectSources(home).find((s) => s.binary === 'claude-code')?.plugins ?? [];
    // The dangling-symlink entry must be skipped; the valid entry must survive.
    // path is now the resolved realpath — use realpathSync to survive macOS aliasing.
    expect(plugins).toEqual([{ name: 'valid', path: realpathSync(validPath) }]);
  });
});

describe('codexHome: CODEX_HOME validation', () => {
  it('uses an absolute CODEX_HOME override', () => {
    const codex = join(home, 'my-codex');
    mkdirSync(codex, { recursive: true });
    vi.stubEnv('CODEX_HOME', codex);
    const sources = detectSources(home);
    const detected = sources.find((s) => s.binary === 'codex')!;
    // present is false since we have nothing under codex, but the source map
    // used codex as root — confirmed by the mcpConfigPath check below
    expect(detected.mcpConfigPath).toBeNull(); // nothing there — correct root used
  });

  it('ignores a relative CODEX_HOME override and falls back to ~/.codex', () => {
    // A relative path is almost certainly wrong and would resolve against cwd
    vi.stubEnv('CODEX_HOME', 'relative/path');
    // Place a plugin under the REAL ~/.codex (our injected home) to confirm
    // codexHome fell back to home/.codex
    writePlugin(join(home, '.codex', 'plugins'), 'fallback-plugin');
    const sources = detectSources(home);
    const detected = sources.find((s) => s.binary === 'codex')!;
    expect(detected.plugins.map((p) => p.name)).toContain('fallback-plugin');
  });
});

describe('readMcpServers', () => {
  it('returns [] for a missing file', () => {
    expect(readMcpServers(join(home, 'nope.json'), 'json')).toEqual([]);
  });

  it('returns [] for malformed JSON', () => {
    const p = join(home, 'bad.json');
    writeFileSync(p, '{ not json');
    expect(readMcpServers(p, 'json')).toEqual([]);
  });
});

describe('loadImportFromConfig', () => {
  it('reads a valid importFrom from an allowed (user-global) config path', () => {
    const p = join(home, 'afk.config.json');
    writeFileSync(p, JSON.stringify({ importFrom: { 'claude-code': true } }));
    expect(loadImportFromConfig([p])).toEqual({
      'claude-code': { plugins: true, skills: true, mcp: true },
    });
  });

  it('first existing config WITH a valid importFrom wins; files lacking one are skipped', () => {
    const a = join(home, 'a.json'); // exists, no importFrom
    const b = join(home, 'b.json'); // exists, has importFrom
    writeFileSync(a, JSON.stringify({ model: 'sonnet' }));
    writeFileSync(b, JSON.stringify({ importFrom: { codex: { plugins: true } } }));
    expect(loadImportFromConfig([a, b])).toEqual({
      codex: { plugins: true, skills: false, mcp: false },
    });
  });

  it('returns undefined when no provided config has a valid importFrom', () => {
    const p = join(home, 'afk.config.json');
    writeFileSync(p, JSON.stringify({ model: 'sonnet' }));
    expect(loadImportFromConfig([p])).toBeUndefined();
    expect(loadImportFromConfig([join(home, 'missing.json')])).toBeUndefined();
  });

  it('SECURITY: the default config-path list excludes the project-local cwd config', () => {
    // importFrom must never be honored from <cwd>/afk.config.json — a cloned
    // repo could otherwise silently enable foreign-asset / MCP-server import.
    expect(importFromConfigPaths()).not.toContain(join(process.cwd(), 'afk.config.json'));
  });
});
