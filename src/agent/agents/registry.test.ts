/**
 * Tests for the named-agent registry: scopes, precedence, duplicates,
 * builtins, and config-tier injection.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAgentRegistry } from './registry.js';

let tmp: string;
let prevAfkHome: string | undefined;

function writeAgent(dir: string, file: string, name: string, extra = ''): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, file),
    `---\nname: ${name}\ndescription: from ${dir}\n${extra}---\nprompt for ${name}\n`,
  );
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'afk-agents-test-'));
  prevAfkHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = join(tmp, 'afk-home');
});

afterEach(() => {
  if (prevAfkHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = prevAfkHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('loadAgentRegistry', () => {
  it('always contains the builtin agents', () => {
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn: () => {} });
    expect(registry.get('research-agent')?.source).toBe('builtin');
    expect(registry.get('git-investigator')?.source).toBe('builtin');
    expect(registry.get('git-investigator')?.bashReadOnly).toBe(true);
    expect(registry.get('general-purpose')?.source).toBe('builtin');
    expect(registry.get('Explore')?.source).toBe('builtin');
    // research-agent keeps its vendored read-only contract PLUS the scoped
    // git-investigator dispatch grant (matches the vendored prompt frontmatter;
    // resolve.ts turns Agent(git-investigator) into nestedAgentTypes and the
    // executor restricts research-agent to dispatching only git-investigator).
    expect(registry.get('research-agent')?.definition.tools).toEqual([
      'Read',
      'Grep',
      'Glob',
      'WebFetch',
      'WebSearch',
      'Agent(git-investigator)',
    ]);
  });

  it('strips vendored frontmatter from builtin prompts (body-only system prompt)', () => {
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn: () => {} });
    for (const name of ['research-agent', 'git-investigator']) {
      const prompt = registry.get(name)?.definition.prompt ?? '';
      expect(prompt.startsWith('---')).toBe(false);
      expect(prompt.length).toBeGreaterThan(0);
    }
  });

  it('scans user scope (~/.afk/agents) recursively', () => {
    const userDir = join(tmp, 'afk-home', 'agents', 'review');
    writeAgent(userDir, 'security.md', 'security-reviewer');
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn: () => {} });
    expect(registry.get('security-reviewer')?.source).toBe('user');
    expect(registry.get('security-reviewer')?.filePath).toBe(join(userDir, 'security.md'));
  });

  it('project scope shadows user scope; .afk/agents shadows .claude/agents', () => {
    const proj = join(tmp, 'proj');
    writeAgent(join(tmp, 'afk-home', 'agents'), 'a.md', 'shadowed');
    writeAgent(join(proj, '.claude', 'agents'), 'a.md', 'shadowed');
    writeAgent(join(proj, '.claude', 'agents'), 'cc-only.md', 'cc-only');
    writeAgent(join(proj, '.afk', 'agents'), 'a.md', 'shadowed');

    const registry = loadAgentRegistry({ cwd: proj, warn: () => {} });
    const winner = registry.get('shadowed');
    expect(winner?.source).toBe('project');
    expect(winner?.filePath).toBe(join(proj, '.afk', 'agents', 'a.md'));
    // Claude Code compat dir is read when not shadowed
    expect(registry.get('cc-only')?.filePath).toBe(join(proj, '.claude', 'agents', 'cc-only.md'));
  });

  it('user/project files shadow builtins by name', () => {
    writeAgent(join(tmp, 'afk-home', 'agents'), 'r.md', 'research-agent');
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn: () => {} });
    expect(registry.get('research-agent')?.source).toBe('user');
  });

  it('warns on same-scope duplicate names and keeps the first (sorted) file', () => {
    const warn = vi.fn();
    const dir = join(tmp, 'proj', '.afk', 'agents');
    writeAgent(dir, 'a-first.md', 'dupe');
    writeAgent(dir, 'z-second.md', 'dupe');
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn });
    expect(registry.get('dupe')?.filePath).toBe(join(dir, 'a-first.md'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate agent name'));
  });

  it('warns when a name is defined in both project dirs (.claude + .afk); .afk still wins', () => {
    const warn = vi.fn();
    const proj = join(tmp, 'proj');
    writeAgent(join(proj, '.claude', 'agents'), 'dup.md', 'both-dirs');
    writeAgent(join(proj, '.afk', 'agents'), 'dup.md', 'both-dirs');
    const registry = loadAgentRegistry({ cwd: proj, warn });
    // Precedence unchanged: .afk wins the project tier.
    expect(registry.get('both-dirs')?.filePath).toBe(join(proj, '.afk', 'agents', 'dup.md'));
    // ...but the cross-directory override is no longer silent.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('overrides'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate agent name'));
  });

  it('does not warn on override when a project name lives in only one project dir', () => {
    const warn = vi.fn();
    const proj = join(tmp, 'proj');
    writeAgent(join(proj, '.claude', 'agents'), 'cc.md', 'cc-only-agent');
    writeAgent(join(proj, '.afk', 'agents'), 'afk.md', 'afk-only-agent');
    loadAgentRegistry({ cwd: proj, warn });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('overrides'));
  });

  it('skips malformed files without failing the scan', () => {
    const warn = vi.fn();
    const dir = join(tmp, 'proj', '.afk', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.md'), 'no frontmatter here');
    writeAgent(dir, 'ok.md', 'works');
    const registry = loadAgentRegistry({ cwd: join(tmp, 'proj'), warn });
    expect(registry.get('works')).toBeDefined();
    expect(warn).toHaveBeenCalled();
  });

  it('configAgents take highest precedence', () => {
    writeAgent(join(tmp, 'proj', '.afk', 'agents'), 'a.md', 'contested');
    const registry = loadAgentRegistry({
      cwd: join(tmp, 'proj'),
      warn: () => {},
      configAgents: {
        contested: { description: 'programmatic', prompt: 'config prompt' },
      },
    });
    expect(registry.get('contested')?.source).toBe('config');
    expect(registry.get('contested')?.definition.prompt).toBe('config prompt');
  });

  it('missing scope directories are silently fine', () => {
    const warn = vi.fn();
    const registry = loadAgentRegistry({ cwd: join(tmp, 'nonexistent-proj'), warn });
    expect(registry.size).toBeGreaterThanOrEqual(4); // builtins only
    // no read-failure warnings for absent dirs
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('cannot read'));
  });
});
