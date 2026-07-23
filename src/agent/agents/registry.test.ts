/**
 * Tests for the named-agent registry: scopes, precedence, duplicates,
 * builtins, and config-tier injection.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAgentRegistry } from './registry.js';
import { builtinAgents } from './builtins.js';

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
    // Anti-runaway bound: the read-only research/review builtins carry an
    // explicit tool-use-round cap so the uncapped agent-tool dispatch path
    // cannot let them loop forever and die opaquely when cut off mid-run.
    expect(registry.get('research-agent')?.definition.maxToolUseIterations).toBe(50);
    expect(registry.get('Explore')?.definition.maxToolUseIterations).toBe(50);
    // git-investigator is a read-only git-archaeology leaf (dispatched by
    // research-agent) and must carry the same cap.
    expect(registry.get('git-investigator')?.definition.maxToolUseIterations).toBe(50);
    // general-purpose now carries a GENEROUS ceiling (not the read-only 50): a
    // full-tool multi-step worker needs headroom, but leaving it "uncapped" let
    // a busy, non-converging worker run to the 45-min wall-clock. 150 bounds a
    // runaway to the graceful capped-partial wind-down while clearing legit
    // multi-step work; opt out per-dispatch via explicit max_tool_use_iterations.
    expect(registry.get('general-purpose')?.definition.maxToolUseIterations).toBe(150);
  });

  // Drift-catcher: iterate the BUILTIN registry (not the vendored consts) so a
  // newly-added builtin that forgets its anti-runaway cap fails here.
  // Structural predicate (no hardcoded per-agent list): EVERY builtin must be
  // bounded — a builtin with an explicit `tools` allowlist is a
  // restricted/read-only leaf capped at 50; a builtin that OMITS `tools`
  // (inherit-all, the full tool surface — only general-purpose today) is the
  // multi-step worker, capped at the generous worker ceiling (150), never
  // uncapped.
  it('every builtin is bounded: read-only leaves cap at 50, the inherit-all worker at the generous ceiling', () => {
    const builtins = builtinAgents();
    // Guard the guard: ensure we actually iterated real builtins and covered
    // BOTH arms (at least one capped read-only leaf and the inherit-all worker),
    // so a future refactor that empties the map can't make this vacuously pass.
    let sawRestricted = false;
    let sawInheritAll = false;
    for (const [name, entry] of builtins) {
      const hasExplicitTools = entry.definition.tools !== undefined;
      if (hasExplicitTools) {
        sawRestricted = true;
        expect(
          entry.definition.maxToolUseIterations,
          `read-only builtin ${name} (explicit tools) is missing the anti-runaway cap`,
        ).toBe(50);
      } else {
        sawInheritAll = true;
        expect(
          entry.definition.maxToolUseIterations,
          `inherit-all builtin ${name} must carry the generous worker ceiling (never uncapped)`,
        ).toBe(150);
      }
    }
    expect(sawRestricted, 'expected ≥1 restricted read-only builtin').toBe(true);
    expect(sawInheritAll, 'expected the inherit-all worker (general-purpose)').toBe(true);
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

  describe('pluginAgents scope', () => {
    it('merges pluginAgents into the registry with their plugin source', () => {
      const registry = loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn: () => {},
        pluginAgents: [
          {
            name: 'demo:helper',
            source: 'plugin:demo',
            definition: { description: 'd', prompt: 'p' },
            filePath: '/x/agents/helper.md',
          },
        ],
      });
      expect(registry.get('demo:helper')?.source).toBe('plugin:demo');
      expect(registry.get('demo:helper')?.filePath).toBe('/x/agents/helper.md');
    });

    it('namespaced plugin agents coexist with bare builtins (no shadow)', () => {
      const registry = loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn: () => {},
        pluginAgents: [
          {
            name: 'demo:research-agent',
            source: 'plugin:demo',
            definition: { description: 'd', prompt: 'p' },
          },
        ],
      });
      expect(registry.get('research-agent')?.source).toBe('builtin');
      expect(registry.get('demo:research-agent')?.source).toBe('plugin:demo');
    });

    it('plugin agents shadow builtins by name (plugin > builtin)', () => {
      const registry = loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn: () => {},
        pluginAgents: [
          {
            name: 'research-agent',
            source: 'plugin:x',
            definition: { description: 'plugin override', prompt: 'p' },
          },
        ],
      });
      expect(registry.get('research-agent')?.source).toBe('plugin:x');
    });

    it('user scope shadows a plugin agent of the same name (user > plugin)', () => {
      writeAgent(join(tmp, 'afk-home', 'agents'), 's.md', 'shared-name');
      const registry = loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn: () => {},
        pluginAgents: [
          {
            name: 'shared-name',
            source: 'plugin:x',
            definition: { description: 'plugin', prompt: 'p' },
          },
        ],
      });
      expect(registry.get('shared-name')?.source).toBe('user');
    });

    it('config scope shadows a plugin agent of the same name (config > plugin)', () => {
      const registry = loadAgentRegistry({
        cwd: join(tmp, 'proj'),
        warn: () => {},
        pluginAgents: [
          {
            name: 'p:dupe',
            source: 'plugin:p',
            definition: { description: 'plugin', prompt: 'p' },
          },
        ],
        configAgents: { 'p:dupe': { description: 'config', prompt: 'c' } },
      });
      expect(registry.get('p:dupe')?.source).toBe('config');
    });
  });
});
