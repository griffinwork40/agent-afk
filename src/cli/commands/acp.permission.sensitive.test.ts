import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { grantFits } from './acp.permission.grants.js';
import { AGENT_MARKER, CONFIG_MARKER, GIT_MARKER, sensitiveMarker, sensitiveMarkers } from './acp.permission.sensitive.js';
import { permissionOptions } from './acp.permission.policy.js';
import { toolTitle } from './acp.tool-kind.js';

const cwd = path.posix.resolve('/work/repo');
const wcwd = 'C:\\work\\repo';

describe('sensitive write targets (profile section 6)', () => {
  it('git internals: any .git segment, a .git file, .gitattributes and .gitmodules at any depth', () => {
    for (const p of ['.git/config', '.git/hooks/pre-commit', '.git/info/attributes', '.git', 'sub/.git',
      'vendor/lib/.git/config', '.gitattributes', 'pkg/.gitattributes', '.gitmodules', 'a/b/.gitmodules',
      '.GIT/config', '.Git/HEAD', '.GitAttributes', `${cwd}/.git/config`, 'sub/.git/../x', 'x/../.git/config']) {
      expect(sensitiveMarker(p, cwd, path.posix), p).toBe(GIT_MARKER);
    }
  });
  it('Windows variants: case, trailing dots and spaces, streams, separators and 8.3 names', () => {
    for (const p of ['.git\\config', '.GIT.\\config', '.git \\hooks\\pre-commit', '.git::$INDEX_ALLOCATION\\config',
      '.gitattributes.', '.gitmodules ', 'GIT~1\\config', 'GITATT~1', 'C:\\work\\repo\\.git\\config', 'sub/.Git/config']) {
      expect(sensitiveMarker(p, wcwd, path.win32), p).toBe(GIT_MARKER);
    }
  });
  it('project config that runs commands: .mcp.json, afk.config.json, .afk/settings.json, .afk/worktree-setup.json', () => {
    for (const p of ['.mcp.json', 'afk.config.json', '.afk/settings.json', '.afk/worktree-setup.json', '.MCP.JSON', 'sub/.mcp.json']) {
      expect(sensitiveMarker(p, cwd, path.posix), p).toBe(CONFIG_MARKER);
    }
    expect(sensitiveMarker('.mcp.json. ', wcwd, path.win32)).toBe(CONFIG_MARKER);
    expect(sensitiveMarker('.AFK\\Settings.json', wcwd, path.win32)).toBe(CONFIG_MARKER);
  });
  it('agent instructions or definitions: everything under a .afk segment, and AFK.md at any depth', () => {
    for (const p of ['AFK.md', 'afk.md', 'sub/AFK.md', '.afk/skills/x/SKILL.md', '.afk/agents/reviewer.md', '.afk/plugins/p/plugin.json',
      '.afk/plans/plan.md', '.afk', 'pkg/nested/.afk/skills/y/SKILL.md', '.AFK/Agents/r.md', `${cwd}/.afk/skills/z/SKILL.md`, 'x/../.afk/a.md']) {
      expect(sensitiveMarker(p, cwd, path.posix), p).toBe(AGENT_MARKER);
    }
    for (const p of ['.afk\\skills\\x\\SKILL.md', '.AFK.\\agents\\r.md', 'AFK~1\\skills\\s.md', 'AFK.md. ', 'Afk.Md:stream', 'C:\\work\\repo\\sub\\.afk\\a.md']) {
      expect(sensitiveMarker(p, wcwd, path.win32), p).toBe(AGENT_MARKER);
    }
  });
  it('marker precedence: git internals, then command-running config, then instructions', () => {
    expect(sensitiveMarker('.afk/.git/config', cwd, path.posix)).toBe(GIT_MARKER);
    expect(sensitiveMarker('.afk/settings.json', cwd, path.posix)).toBe(CONFIG_MARKER);
    expect(sensitiveMarker('.afk/worktree-setup.json', cwd, path.posix)).toBe(CONFIG_MARKER);
    expect(sensitiveMarker('.afk/sub/.mcp.json', cwd, path.posix)).toBe(CONFIG_MARKER);
    expect(sensitiveMarkers('patch_apply', { changes: [{ path: 'AFK.md' }, { path: '.git/HEAD' }, { path: '.mcp.json' }] }, cwd, path.posix))
      .toEqual([GIT_MARKER, CONFIG_MARKER, AGENT_MARKER]);
  });
  it('instruction and definition writes are never grant-covered, whichever writing tool', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['write_file', { file_path: 'AFK.md', content: 'x' }],
      ['edit_file', { file_path: 'AFK.md', old_string: 'a', new_string: 'b' }],
      ['edit_file', { file_path: '.afk/skills/s/SKILL.md', old_string: 'a', new_string: 'b' }],
      ['write_file', { file_path: '.afk/agents/reviewer.md', content: '---\nname: reviewer\n---\n' }],
      ['write_file', { file_path: 'packages/app/.afk/skills/s/SKILL.md', content: 'x' }],
      ['patch_apply', { changes: [{ path: 'ok.txt', content: 'x' }, { path: '.afk/agents/r.md', content: 'x' }] }],
      ['patch_apply', { changes: [{ path: 'sub/AFK.md', content: 'x' }] }],
    ];
    for (const [tool, input] of cases) {
      expect(grantFits(tool, input, cwd, undefined, path.posix), `${tool} ${JSON.stringify(input)}`).toBe(false);
      expect(sensitiveMarkers(tool, input, cwd, path.posix), tool).toContain(AGENT_MARKER);
    }
    expect(grantFits('write_file', { file_path: 'AFK~1\\skills\\s.md', content: 'x' }, wcwd, undefined, path.win32)).toBe(false);
    expect(grantFits('write_file', { file_path: 'docs/afk-notes.md', content: 'x' }, cwd, undefined, path.posix)).toBe(true);
  });
  it('ordinary files are not sensitive', () => {
    for (const p of ['notes.md', 'src/git.ts', 'github/workflows/ci.yml', '.gitignore', 'settings.json', 'docs/.afk.md', 'mcp.json']) {
      expect(sensitiveMarker(p, cwd, path.posix), p).toBe('');
    }
  });
  it('write_file, edit_file and every patch_apply change: no grant, no always option, marked title', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['write_file', { file_path: '.git/config', content: 'x' }],
      ['write_file', { file_path: '.git', content: 'gitdir: /elsewhere' }],
      ['edit_file', { file_path: '.gitattributes', old_string: 'a', new_string: '* filter=x' }],
      ['edit_file', { file_path: '.git/config', old_string: 'a', new_string: 'b' }],
      ['patch_apply', { changes: [{ path: 'ok.txt', content: 'x' }, { path: 'sub/.git/hooks/post-checkout', content: 'x' }] }],
      ['patch_apply', { changes: [{ path: '.mcp.json', content: '{}' }] }],
    ];
    for (const [tool, input] of cases) {
      expect(grantFits(tool, input, cwd, undefined, path.posix), `${tool} ${JSON.stringify(input)}`).toBe(false);
      expect(sensitiveMarkers(tool, input, cwd, path.posix).length).toBeGreaterThan(0);
    }
    expect(grantFits('write_file', { file_path: '.GIT.\\config', content: 'x' }, wcwd, undefined, path.win32)).toBe(false);
    expect(grantFits('write_file', { file_path: 'notes.md', content: 'x' }, cwd, undefined, path.posix)).toBe(true);
    expect(permissionOptions('write_file', true).map((o) => o.optionId)).toEqual(['allow_once', 'reject_once']);
  });
  it('the card title says why', () => {
    const real = path.resolve(os.tmpdir(), 'acp-title-ws');
    expect(toolTitle('write_file', { file_path: '.git/config' }, real)).toContain(GIT_MARKER);
    expect(toolTitle('edit_file', { file_path: '.afk/settings.json' }, real)).toContain(CONFIG_MARKER);
    expect(toolTitle('patch_apply', { changes: [{ path: 'a' }, { path: '.gitmodules' }] }, real)).toContain(GIT_MARKER);
    expect(toolTitle('write_file', { file_path: 'AFK.md' }, real)).toContain(AGENT_MARKER);
    expect(toolTitle('edit_file', { file_path: '.afk/skills/s/SKILL.md' }, real)).toContain(AGENT_MARKER);
    expect(toolTitle('write_file', { file_path: 'notes.md' }, real)).not.toMatch(/\((git internals|project config|agent instructions)/);
  });
});
