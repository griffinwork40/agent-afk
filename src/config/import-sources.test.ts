/**
 * Tests for cross-tool asset import: config parsing, source detection, and
 * root resolution. Uses an injectable `home` so we can lay out a fake
 * `~/.claude` / `~/.codex` tree under a tmp dir without touching real state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectSources,
  importFromConfigPaths,
  loadImportFromConfig,
  parseImportFromConfig,
  readMcpServers,
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
  home = join(tmpdir(), `afk-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
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
    expect(resolved.pluginRoots).toEqual([claudePlugins]);
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

describe('detectSources', () => {
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
        '[[mcp_servers]]',
        'name = "fs"',
        'command = "mcp-fs"',
        '',
        '[[mcp_servers]]',
        'name = "web"',
        'url = "https://web.example/mcp"',
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
    ]);
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
