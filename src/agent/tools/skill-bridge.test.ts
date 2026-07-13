/**
 * Tests for skill-bridge — manifest building and skill entry collection.
 *
 * Tests pass `pluginConfigs: []` to bypass the default `scanLocalPlugins()`
 * call inside `buildSkillManifest` / `collectSkillEntries`, so test output
 * depends only on the in-memory skill registry — never on the user's
 * `~/.afk/plugins/` directory.
 *
 * File-level isolation: every test runs with AFK_HOME pointed at a fresh
 * empty temp dir and process.cwd() redirected to an empty temp dir. This
 * ensures that collectSkillEntries()'s disk scan (which now always runs to
 * populate user + project skills) finds nothing — so tests that register
 * skills directly via registerSkill() see only what they registered.
 * The regression describe block at the bottom overrides these stubs to
 * exercise the actual disk-scan path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSkillManifest,
  collectSkillEntries,
  discoverPluginSkillBodies,
  discoverPluginAgents,
  scanAllPluginRoots,
} from './skill-bridge.js';
import { registerSkill, _resetRegistry } from '../../skills/index.js';
import { _resetPluginScanCache } from '../plugins-scanner.js';
import { getPluginsDir } from '../../paths.js';

// ---------------------------------------------------------------------------
// File-level isolation: redirect AFK_HOME + cwd before every test so the
// disk scan inside collectSkillEntries() always finds an empty skills dir.
// Tests that need real disk skills (the regression suite below) override
// these in their own beforeEach.
// ---------------------------------------------------------------------------
let _isolatedAfkHome: string;
let _isolatedCwd: string;
let _origCwd: string;

beforeEach(() => {
  _isolatedAfkHome = mkdtempSync('/tmp/skill-bridge-test-afkhome-');
  _isolatedCwd = mkdtempSync('/tmp/skill-bridge-test-cwd-');
  _origCwd = process.cwd();
  vi.stubEnv('AFK_HOME', _isolatedAfkHome);
  process.chdir(_isolatedCwd);
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.chdir(_origCwd);
  try { rmSync(_isolatedAfkHome, { recursive: true }); } catch { /* non-fatal */ }
  try { rmSync(_isolatedCwd, { recursive: true }); } catch { /* non-fatal */ }
});

describe('buildSkillManifest', () => {
  beforeEach(() => {
    _resetRegistry();
  });

  it('returns empty string when no skills registered', () => {
    const manifest = buildSkillManifest([]);
    expect(manifest).toBe('');
  });

  it('includes all skill names and descriptions in manifest', () => {
    registerSkill({
      name: 'test-skill-1',
      description: 'First test skill',
      handler: vi.fn(),
    });
    registerSkill({
      name: 'test-skill-2',
      description: 'Second test skill',
      handler: vi.fn(),
    });

    const manifest = buildSkillManifest();

    expect(manifest).toContain('Available skills (invoke via the `skill` tool):');
    expect(manifest).toContain('test-skill-1: First test skill');
    expect(manifest).toContain('test-skill-2: Second test skill');
  });

  it('includes argumentHint in skill entry when present', () => {
    registerSkill({
      name: 'plan-skill',
      description: 'Planning skill',
      handler: vi.fn(),
      argumentHint: '<plan>',
    });

    const manifest = buildSkillManifest();

    expect(manifest).toContain('`plan-skill <plan>`');
    expect(manifest).toContain('Planning skill');
  });

  it('includes whenToUse line when field is present', () => {
    registerSkill({
      name: 'debug-skill',
      description: 'Debug skill',
      handler: vi.fn(),
      whenToUse: 'When the user wants to debug something',
    });

    const manifest = buildSkillManifest();

    expect(manifest).toContain('debug-skill: Debug skill');
    expect(manifest).toContain('When to use: When the user wants to debug something');
  });

  it('includes both argumentHint and whenToUse when both present', () => {
    registerSkill({
      name: 'complex-skill',
      description: 'Complex skill',
      handler: vi.fn(),
      argumentHint: '<spec>',
      whenToUse: 'When a detailed spec is needed',
    });

    const manifest = buildSkillManifest();

    expect(manifest).toContain('`complex-skill <spec>`');
    expect(manifest).toContain('Complex skill');
    expect(manifest).toContain('When to use: When a detailed spec is needed');
  });

  it('omits argumentHint line when field is absent', () => {
    registerSkill({
      name: 'simple-skill',
      description: 'Simple skill',
      handler: vi.fn(),
    });

    const manifest = buildSkillManifest();

    expect(manifest).toContain('simple-skill: Simple skill');
    expect(manifest).not.toContain('`simple-skill`');
  });

  it('omits whenToUse line when field is absent', () => {
    registerSkill({
      name: 'minimal-skill',
      description: 'Minimal skill',
      handler: vi.fn(),
    });

    const manifest = buildSkillManifest();

    expect(manifest).toContain('minimal-skill: Minimal skill');
    expect(manifest).not.toMatch(/When to use:/);
  });

  it('handles mixed skills with and without optional fields', () => {
    registerSkill({
      name: 'skill-a',
      description: 'Has both',
      handler: vi.fn(),
      argumentHint: '<arg>',
      whenToUse: 'When A is needed',
    });
    registerSkill({
      name: 'skill-b',
      description: 'Has neither',
      handler: vi.fn(),
    });
    registerSkill({
      name: 'skill-c',
      description: 'Has only hint',
      handler: vi.fn(),
      argumentHint: '<input>',
    });

    const manifest = buildSkillManifest();

    // skill-a
    expect(manifest).toContain('`skill-a <arg>`');
    expect(manifest).toContain('When to use: When A is needed');

    // skill-b
    expect(manifest).toContain('skill-b: Has neither');

    // skill-c
    expect(manifest).toContain('`skill-c <input>`');
    expect(manifest).not.toMatch(/skill-c.*When to use:/);
  });

  it('preserves backwards compatibility with old code expecting name: description format', () => {
    registerSkill({
      name: 'legacy-skill',
      description: 'Legacy skill',
      handler: vi.fn(),
    });

    const manifest = buildSkillManifest();

    // Should still have the basic format without backticks or extra formatting
    expect(manifest).toContain('legacy-skill: Legacy skill');
  });
});

describe('collectSkillEntries', () => {
  beforeEach(() => {
    _resetRegistry();
  });

  it('collects registered skills with metadata', () => {
    registerSkill({
      name: 'entry-skill',
      description: 'Entry skill',
      handler: vi.fn(),
      argumentHint: '<arg>',
      whenToUse: 'When needed',
    });

    const entries = collectSkillEntries([]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'entry-skill',
      description: 'Entry skill',
      source: 'builtin',
      argumentHint: '<arg>',
      whenToUse: 'When needed',
    });
  });

  it('omits optional metadata fields when not present', () => {
    registerSkill({
      name: 'basic-skill',
      description: 'Basic skill',
      handler: vi.fn(),
    });

    const entries = collectSkillEntries([]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'basic-skill',
      description: 'Basic skill',
      source: 'builtin',
    });
    expect(entries[0].argumentHint).toBeUndefined();
    expect(entries[0].whenToUse).toBeUndefined();
  });

  it('collects multiple skills preserving all metadata', () => {
    registerSkill({
      name: 'skill-1',
      description: 'Skill 1',
      handler: vi.fn(),
      argumentHint: '<plan>',
      whenToUse: 'For planning',
    });
    registerSkill({
      name: 'skill-2',
      description: 'Skill 2',
      handler: vi.fn(),
    });

    const entries = collectSkillEntries([]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: 'skill-1',
      argumentHint: '<plan>',
      whenToUse: 'For planning',
    });
    expect(entries[1]).toMatchObject({
      name: 'skill-2',
      argumentHint: undefined,
      whenToUse: undefined,
    });
  });
});

describe('collectSkillEntries — audience tier gate', () => {
  beforeEach(() => {
    _resetRegistry();
    // Start every test with the tier locked (AFK_INTERNAL not '1') regardless
    // of what the shell environment has set. Tests that need the tier unlocked
    // call vi.stubEnv('AFK_INTERNAL', '1') themselves.
    // Also re-stub AFK_HOME so the disk scan in collectSkillEntries() always
    // targets an empty dir — not the real ~/.afk/skills/.
    vi.unstubAllEnvs();
    vi.stubEnv('AFK_HOME', _isolatedAfkHome);
    vi.stubEnv('AFK_INTERNAL', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hides internal-audience registry skills when tier is locked', () => {
    registerSkill({
      name: 'public-builtin',
      description: 'Visible to all',
      handler: vi.fn(),
      audience: 'public',
    });
    registerSkill({
      name: 'internal-builtin',
      description: 'Maintainer-only',
      handler: vi.fn(),
      audience: 'internal',
    });

    const entries = collectSkillEntries([]);

    const names = entries.map((e) => e.name);
    expect(names).toContain('public-builtin');
    expect(names).not.toContain('internal-builtin');
  });

  it('surfaces internal-audience registry skills when AFK_INTERNAL=1', () => {
    vi.stubEnv('AFK_INTERNAL', '1');

    registerSkill({
      name: 'public-builtin',
      description: 'Visible to all',
      handler: vi.fn(),
      audience: 'public',
    });
    registerSkill({
      name: 'internal-builtin',
      description: 'Maintainer-only',
      handler: vi.fn(),
      audience: 'internal',
    });

    const entries = collectSkillEntries([]);

    const names = entries.map((e) => e.name);
    expect(names).toContain('public-builtin');
    expect(names).toContain('internal-builtin');
  });

  it('treats absent audience as public (visible when tier is locked)', () => {
    registerSkill({
      name: 'absent-audience',
      description: 'Default public',
      handler: vi.fn(),
    });

    const entries = collectSkillEntries([]);

    expect(entries.map((e) => e.name)).toContain('absent-audience');
  });

  it('honors AFK_INTERNAL only when it equals "1" exactly', () => {
    // Defensive: a typo or truthy-but-different value MUST NOT unlock.
    // "true", "yes", "on" all leave the tier LOCKED.
    vi.stubEnv('AFK_INTERNAL', 'true');

    registerSkill({
      name: 'internal-builtin',
      description: 'Maintainer-only',
      handler: vi.fn(),
      audience: 'internal',
    });

    const entries = collectSkillEntries([]);
    expect(entries.map((e) => e.name)).not.toContain('internal-builtin');
  });
});

describe('collectSkillEntries — plugin frontmatter audience filter', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetRegistry();
    // Lock the tier (AFK_INTERNAL not '1') regardless of shell env, and
    // re-stub AFK_HOME so the disk scan in collectSkillEntries() never reads
    // real ~/.afk/skills/ entries and pollutes plugin audience assertions.
    vi.unstubAllEnvs();
    vi.stubEnv('AFK_HOME', _isolatedAfkHome);
    vi.stubEnv('AFK_INTERNAL', '');
    tmpDir = mkdtempSync('/tmp/skill-bridge-audience-test-');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // Non-fatal cleanup.
    }
  });

  function writePluginSkill(
    pluginPath: string,
    skillName: string,
    audience: 'public' | 'internal' | null,
  ): void {
    const dir = join(pluginPath, 'skills', skillName);
    mkdirSync(dir, { recursive: true });
    const audienceLine = audience === null ? '' : `audience: ${audience}\n`;
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: Plugin skill ${skillName}\n${audienceLine}---\n# Body\n`,
    );
  }

  it('hides plugin SKILL.md with `audience: internal` when tier is locked', () => {
    const plugin = join(tmpDir, 'p1');
    mkdirSync(plugin, { recursive: true });
    writePluginSkill(plugin, 'public-plug', 'public');
    writePluginSkill(plugin, 'internal-plug', 'internal');

    const entries = collectSkillEntries([{ type: 'local', path: plugin }]);
    const names = entries.map((e) => e.name);

    expect(names).toContain('public-plug');
    expect(names).not.toContain('internal-plug');
  });

  it('surfaces plugin internal-audience SKILL.md when AFK_INTERNAL=1', () => {
    vi.stubEnv('AFK_INTERNAL', '1');

    const plugin = join(tmpDir, 'p2');
    mkdirSync(plugin, { recursive: true });
    writePluginSkill(plugin, 'internal-plug', 'internal');

    const entries = collectSkillEntries([{ type: 'local', path: plugin }]);
    expect(entries.map((e) => e.name)).toContain('internal-plug');
  });

  it('treats absent audience as public for plugin SKILL.md', () => {
    const plugin = join(tmpDir, 'p3');
    mkdirSync(plugin, { recursive: true });
    writePluginSkill(plugin, 'no-audience-plug', null);

    const entries = collectSkillEntries([{ type: 'local', path: plugin }]);
    expect(entries.map((e) => e.name)).toContain('no-audience-plug');
  });

  it('drops unrecognized audience values silently (defaults to public)', () => {
    // Defensive: if a SKILL.md has `audience: maintainer` (typo) we don't
    // want to accidentally hide it from end users. The extractor only
    // accepts the two well-known values and discards anything else.
    const plugin = join(tmpDir, 'p4');
    mkdirSync(plugin, { recursive: true });
    const dir = join(plugin, 'skills', 'weird-audience');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: weird-audience\ndescription: Bad audience value\naudience: maintainer\n---\n# Body\n`,
    );

    const entries = collectSkillEntries([{ type: 'local', path: plugin }]);
    expect(entries.map((e) => e.name)).toContain('weird-audience');
  });
});

describe('discoverPluginSkillBodies', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/skill-bodies-test-');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // Non-fatal cleanup.
    }
  });

  function writeSkill(pluginPath: string, skillName: string, body: string): void {
    const dir = join(pluginPath, 'skills', skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: A test skill\n---\n${body}\n`,
    );
  }

  it('returns body + pluginPath for each discovered skill', () => {
    const pluginA = join(tmpDir, 'plugin-a');
    mkdirSync(pluginA, { recursive: true });
    writeSkill(pluginA, 'alpha', '# Alpha body');

    const bodies = discoverPluginSkillBodies([
      { type: 'local', path: pluginA },
    ]);

    expect(bodies.size).toBe(1);
    const alpha = bodies.get('alpha');
    expect(alpha).toBeDefined();
    expect(alpha?.body).toContain('# Alpha body');
    expect(alpha?.pluginPath).toBe(pluginA);
  });

  it('first-wins on skill-name collisions across plugins', () => {
    // PLUGIN_ROOT injection downstream uses pluginPath, so when two plugins
    // contribute a skill with the same name the FIRST scanned plugin wins —
    // otherwise the wrong PLUGIN_ROOT would reach the subagent.
    const pluginA = join(tmpDir, 'a');
    const pluginB = join(tmpDir, 'b');
    mkdirSync(pluginA, { recursive: true });
    mkdirSync(pluginB, { recursive: true });
    writeSkill(pluginA, 'shared', '# from A');
    writeSkill(pluginB, 'shared', '# from B');

    const bodies = discoverPluginSkillBodies([
      { type: 'local', path: pluginA },
      { type: 'local', path: pluginB },
    ]);

    const entry = bodies.get('shared');
    expect(entry?.pluginPath).toBe(pluginA);
    expect(entry?.body).toContain('# from A');
  });

  it('returns empty map when no plugins yield skills', () => {
    const bodies = discoverPluginSkillBodies([]);
    expect(bodies.size).toBe(0);
  });

  it('propagates allowedTools from tools: frontmatter field', () => {
    const pluginA = join(tmpDir, 'plugin-a');
    mkdirSync(pluginA, { recursive: true });
    const dir = join(pluginA, 'skills', 'read-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        'name: read-skill',
        'description: Read-only research skill',
        'tools: read_file, grep, glob',
        '---',
        'Research the codebase.',
      ].join('\n'),
    );

    const bodies = discoverPluginSkillBodies([{ type: 'local', path: pluginA }]);
    const entry = bodies.get('read-skill');
    expect(entry).toBeDefined();
    expect(entry?.allowedTools).toEqual(['read_file', 'grep', 'glob']);
  });

  it('leaves allowedTools undefined when tools: is absent', () => {
    const pluginA = join(tmpDir, 'plugin-a');
    mkdirSync(pluginA, { recursive: true });
    const dir = join(pluginA, 'skills', 'full-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        'name: full-skill',
        'description: Full-access skill',
        '---',
        'Do anything.',
      ].join('\n'),
    );

    const bodies = discoverPluginSkillBodies([{ type: 'local', path: pluginA }]);
    const entry = bodies.get('full-skill');
    expect(entry).toBeDefined();
    expect(entry?.allowedTools).toBeUndefined();
  });
});

describe('discoverPluginAgents', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/plugin-agents-test-');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true });
    } catch {
      // Non-fatal cleanup.
    }
  });

  function writeManifest(pluginPath: string, name: string): void {
    const dir = join(pluginPath, '.claude-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  }

  function writeAgentFile(pluginPath: string, file: string, name: string, extra = ''): void {
    const dir = join(pluginPath, 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, file),
      `---\nname: ${name}\ndescription: A test agent\n${extra}---\nAgent body for ${name}.\n`,
    );
  }

  it('namespaces discovered agents as <plugin>:<agent> with plugin source', () => {
    const pluginA = join(tmpDir, 'plugin-a');
    writeManifest(pluginA, 'demo');
    writeAgentFile(pluginA, 'researcher.md', 'research-agent');

    const agents = discoverPluginAgents([{ type: 'local', path: pluginA }]);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('demo:research-agent');
    expect(agents[0]?.source).toBe('plugin:demo');
    expect(agents[0]?.definition.description).toBe('A test agent');
    expect(agents[0]?.definition.prompt).toContain('Agent body for research-agent.');
    expect(agents[0]?.filePath).toBe(join(pluginA, 'agents', 'researcher.md'));
  });

  it('takes identity from frontmatter name, not filename (CC parity)', () => {
    const pluginA = join(tmpDir, 'plugin-a');
    writeManifest(pluginA, 'demo');
    writeAgentFile(pluginA, 'anything.md', 'git-investigator');
    const agents = discoverPluginAgents([{ type: 'local', path: pluginA }]);
    expect(agents[0]?.name).toBe('demo:git-investigator');
  });

  it('scans agents/ recursively (subfolders)', () => {
    const pluginA = join(tmpDir, 'plugin-a');
    writeManifest(pluginA, 'demo');
    const sub = join(pluginA, 'agents', 'review');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'sec.md'), '---\nname: security\ndescription: d\n---\nbody\n');
    const agents = discoverPluginAgents([{ type: 'local', path: pluginA }]);
    expect(agents.map((a) => a.name)).toContain('demo:security');
  });

  it('carries bash: read-only through as bashReadOnly', () => {
    const pluginA = join(tmpDir, 'plugin-a');
    writeManifest(pluginA, 'demo');
    writeAgentFile(pluginA, 'git.md', 'git-investigator', 'tools: Bash, Read\nbash: read-only\n');
    const agents = discoverPluginAgents([{ type: 'local', path: pluginA }]);
    expect(agents[0]?.bashReadOnly).toBe(true);
  });

  it('first-wins on qualified-name collisions', () => {
    const a = join(tmpDir, 'a');
    const b = join(tmpDir, 'b');
    writeManifest(a, 'dup');
    writeManifest(b, 'dup');
    writeAgentFile(a, 'x.md', 'shared');
    writeAgentFile(b, 'x.md', 'shared');
    const agents = discoverPluginAgents([
      { type: 'local', path: a },
      { type: 'local', path: b },
    ]);
    const shared = agents.filter((ag) => ag.name === 'dup:shared');
    expect(shared).toHaveLength(1);
    expect(shared[0]?.filePath).toBe(join(a, 'agents', 'x.md'));
  });

  it('supports agents-only plugins (no skills/ dir)', () => {
    const pluginA = join(tmpDir, 'agents-only');
    writeManifest(pluginA, 'agentsonly');
    writeAgentFile(pluginA, 'a.md', 'solo');
    const agents = discoverPluginAgents([{ type: 'local', path: pluginA }]);
    expect(agents.map((a) => a.name)).toEqual(['agentsonly:solo']);
  });

  it('skips a plugin with no readable manifest name', () => {
    const pluginA = join(tmpDir, 'no-manifest');
    // No .claude-plugin/plugin.json written — its agents have no stable id.
    writeAgentFile(pluginA, 'a.md', 'orphan');
    const agents = discoverPluginAgents([{ type: 'local', path: pluginA }]);
    expect(agents).toHaveLength(0);
  });

  it('skips malformed agent files without failing the scan', () => {
    const pluginA = join(tmpDir, 'plugin-a');
    writeManifest(pluginA, 'demo');
    const dir = join(pluginA, 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.md'), 'no frontmatter at all');
    writeAgentFile(pluginA, 'ok.md', 'works');
    const agents = discoverPluginAgents([{ type: 'local', path: pluginA }]);
    expect(agents.map((a) => a.name)).toEqual(['demo:works']);
  });

  it('returns empty for a plugin with no agents/ dir', () => {
    const pluginA = join(tmpDir, 'plugin-a');
    writeManifest(pluginA, 'demo');
    const agents = discoverPluginAgents([{ type: 'local', path: pluginA }]);
    expect(agents).toHaveLength(0);
  });

  it('ignores non-local plugin configs', () => {
    const agents = discoverPluginAgents([
      { type: 'git', path: join(tmpDir, 'nope') } as never,
    ]);
    expect(agents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: collectSkillEntries() must scan disk fresh so ~/.afk/skills/
// skills appear in the manifest on all surfaces (daemon, Telegram, one-shot,
// subagent) — not only when the CLI slash-command init path ran first.
//
// History: before this fix collectSkillEntries() was read-only against the
// registry, relying on scanAndRegisterUserSkills() having been called at
// session startup via registerBuiltinSkillCommands(). That path is only
// exercised by interactive REPL sessions, leaving user skills absent from
// the manifest on every other surface.
// ---------------------------------------------------------------------------
describe('collectSkillEntries — disk-scan regression (user + project skills)', () => {
  let tmpAfkHome: string;
  let tmpCwd: string;
  let origCwd: string;

  beforeEach(() => {
    _resetRegistry();
    vi.unstubAllEnvs();

    // Isolated AFK_HOME so the test never reads from the real ~/.afk/skills/.
    tmpAfkHome = mkdtempSync('/tmp/skill-bridge-disk-regression-afkhome-');
    // Isolated cwd so getProjectSkillsDir() doesn't pick up real project skills.
    tmpCwd = mkdtempSync('/tmp/skill-bridge-disk-regression-cwd-');
    origCwd = process.cwd();

    vi.stubEnv('AFK_HOME', tmpAfkHome);
    process.chdir(tmpCwd);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(origCwd);
    try { rmSync(tmpAfkHome, { recursive: true }); } catch { /* non-fatal */ }
    try { rmSync(tmpCwd, { recursive: true }); } catch { /* non-fatal */ }
  });

  function writeUserSkill(name: string, description: string, extra: string = ''): void {
    const dir = join(tmpAfkHome, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# Body\n`,
    );
  }

  function writeProjectSkill(name: string, description: string): void {
    const dir = join(tmpCwd, '.afk', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n# Body\n`,
    );
  }

  it('surfaces a user skill from disk without prior scanAndRegisterUserSkills() call', () => {
    writeUserSkill('my-user-skill', 'User skill from disk');

    // Registry is empty — no prior scan. collectSkillEntries() must scan
    // disk itself and return the skill.
    const entries = collectSkillEntries([]);

    const names = entries.map((e) => e.name);
    expect(names).toContain('my-user-skill');
  });

  it('reports source: "user" for a disk-scanned user skill', () => {
    writeUserSkill('user-src-check', 'Check source field');

    const entries = collectSkillEntries([]);
    const entry = entries.find((e) => e.name === 'user-src-check');

    expect(entry).toBeDefined();
    expect(entry?.source).toBe('user');
  });

  it('surfaces a project skill from disk (cwd/.afk/skills/)', () => {
    writeProjectSkill('my-project-skill', 'Project skill from disk');

    const entries = collectSkillEntries([]);

    const names = entries.map((e) => e.name);
    expect(names).toContain('my-project-skill');
  });

  it('reports source: "project" for a disk-scanned project skill', () => {
    writeProjectSkill('project-src-check', 'Check project source field');

    const entries = collectSkillEntries([]);
    const entry = entries.find((e) => e.name === 'project-src-check');

    expect(entry).toBeDefined();
    expect(entry?.source).toBe('project');
  });

  it('surfaces both user and project skills in a single call', () => {
    writeUserSkill('user-multi', 'User skill');
    writeProjectSkill('project-multi', 'Project skill');

    const entries = collectSkillEntries([]);
    const names = entries.map((e) => e.name);

    expect(names).toContain('user-multi');
    expect(names).toContain('project-multi');
  });

  it('preserves argumentHint from a disk-scanned user skill', () => {
    writeUserSkill('hint-skill', 'Skill with hint', 'argument-hint: <plan>\n');

    const entries = collectSkillEntries([]);
    const entry = entries.find((e) => e.name === 'hint-skill');

    expect(entry?.argumentHint).toBe('<plan>');
  });

  it('includes user skill in buildSkillManifest() output', () => {
    writeUserSkill('manifest-user-skill', 'Appears in manifest');

    const manifest = buildSkillManifest([]);

    expect(manifest).toContain('Available skills');
    expect(manifest).toContain('manifest-user-skill: Appears in manifest');
  });

  it('is idempotent: calling collectSkillEntries twice does not duplicate entries', () => {
    writeUserSkill('idem-skill', 'Idempotent skill');

    const first = collectSkillEntries([]);
    const second = collectSkillEntries([]);

    const firstCount = first.filter((e) => e.name === 'idem-skill').length;
    const secondCount = second.filter((e) => e.name === 'idem-skill').length;

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);

    // Regression guard for the duplicate-alias bug: before the same-origin
    // fix in resolveSkillKey(), the second scan registered `user:idem-skill`
    // alongside the bare `idem-skill`, so the total entry count grew by one
    // and the namespaced alias leaked into the manifest. The bare-name count
    // above stays 1 either way, so it cannot catch the regression — these two
    // assertions can. They fail on the buggy code and pass on the fix.
    expect(second.length).toBe(first.length);
    expect(second.map((e) => e.name)).not.toContain('user:idem-skill');
  });

  it('returns empty when ~/.afk/skills/ does not exist (no crash)', () => {
    // No skills dir created — must not throw, must return empty.
    const entries = collectSkillEntries([]);
    // We only assert no throw and no user/project entries.
    const userOrProject = entries.filter(
      (e) => e.source === 'user' || e.source === 'project',
    );
    expect(userOrProject).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: #179 — project-origin skills must be evicted when cwd changes.
//
// Simulates a long-lived daemon serving project A, then project B: the project
// scan in collectSkillEntries() must remove stale project-A entries before
// registering project-B entries. User-origin and built-in skills must survive.
// ---------------------------------------------------------------------------
describe('collectSkillEntries — project skill eviction on cwd change (#179)', () => {
  let tmpAfkHome: string;
  let cwdA: string;
  let cwdB: string;
  let origCwd: string;

  beforeEach(() => {
    _resetRegistry();
    vi.unstubAllEnvs();

    tmpAfkHome = mkdtempSync('/tmp/skill-bridge-evict-afkhome-');
    cwdA = mkdtempSync('/tmp/skill-bridge-evict-cwdA-');
    cwdB = mkdtempSync('/tmp/skill-bridge-evict-cwdB-');
    origCwd = process.cwd();

    vi.stubEnv('AFK_HOME', tmpAfkHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(origCwd);
    try { rmSync(tmpAfkHome, { recursive: true }); } catch { /* non-fatal */ }
    try { rmSync(cwdA, { recursive: true }); } catch { /* non-fatal */ }
    try { rmSync(cwdB, { recursive: true }); } catch { /* non-fatal */ }
  });

  function writeSkillIn(baseDir: string, name: string, description: string): void {
    const dir = join(baseDir, '.afk', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n# Body\n`,
    );
  }

  function writeUserSkillIn(afkHome: string, name: string, description: string): void {
    const dir = join(afkHome, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n# Body\n`,
    );
  }

  it('evicts project-A skills after switching to project B', () => {
    writeSkillIn(cwdA, 'proj-a-skill', 'Skill only in project A');
    writeSkillIn(cwdB, 'proj-b-skill', 'Skill only in project B');

    // First call: cwd = project A
    process.chdir(cwdA);
    const entriesA = collectSkillEntries([]);
    const namesA = entriesA.map((e) => e.name);
    expect(namesA).toContain('proj-a-skill');
    expect(namesA).not.toContain('proj-b-skill');

    // Second call: cwd = project B — proj-a-skill must be gone
    process.chdir(cwdB);
    const entriesB = collectSkillEntries([]);
    const namesB = entriesB.map((e) => e.name);
    expect(namesB).toContain('proj-b-skill');
    expect(namesB).not.toContain('proj-a-skill');
  });

  it('user-origin skills survive the cwd change', () => {
    writeUserSkillIn(tmpAfkHome, 'global-user-skill', 'Always present');
    writeSkillIn(cwdA, 'proj-a-only', 'Project A only');
    writeSkillIn(cwdB, 'proj-b-only', 'Project B only');

    // First call: cwd = project A
    process.chdir(cwdA);
    const entriesA = collectSkillEntries([]);
    expect(entriesA.map((e) => e.name)).toContain('global-user-skill');

    // Second call: cwd = project B — user skill must still be present
    process.chdir(cwdB);
    const entriesB = collectSkillEntries([]);
    const namesB = entriesB.map((e) => e.name);
    expect(namesB).toContain('global-user-skill');
    expect(namesB).toContain('proj-b-only');
    expect(namesB).not.toContain('proj-a-only');
  });

  it('evicted project entries are fully absent from the manifest', () => {
    writeSkillIn(cwdA, 'stale-skill', 'Stale from project A');

    process.chdir(cwdA);
    const manifestA = buildSkillManifest([]);
    expect(manifestA).toContain('stale-skill');

    // Switch to project B (no skills)
    process.chdir(cwdB);
    const manifestB = buildSkillManifest([]);
    expect(manifestB).not.toContain('stale-skill');
  });

  // -------------------------------------------------------------------------
  // Session-cwd resolution (daemon / Telegram): the host process never
  // chdir()s — the session's configured cwd is passed explicitly instead.
  // These cases exercise the opts.cwd path with process.cwd() held constant.
  // -------------------------------------------------------------------------

  it('resolves project skills against opts.cwd without process.chdir()', () => {
    writeSkillIn(cwdA, 'proj-a-skill', 'Skill only in project A');
    writeSkillIn(cwdB, 'proj-b-skill', 'Skill only in project B');

    // Host process cwd stays wherever the test runner lives — never chdir.
    const entriesA = collectSkillEntries([], { cwd: cwdA });
    const namesA = entriesA.map((e) => e.name);
    expect(namesA).toContain('proj-a-skill');
    expect(namesA).not.toContain('proj-b-skill');

    // A different session cwd in the same process — stale entries evicted.
    const entriesB = collectSkillEntries([], { cwd: cwdB });
    const namesB = entriesB.map((e) => e.name);
    expect(namesB).toContain('proj-b-skill');
    expect(namesB).not.toContain('proj-a-skill');
  });

  it('buildSkillManifest forwards opts.cwd to the project scan', () => {
    writeSkillIn(cwdA, 'session-cwd-skill', 'Visible only via session cwd');

    // Without the override the host cwd has no .afk/skills — skill absent.
    expect(buildSkillManifest([])).not.toContain('session-cwd-skill');
    // With the session cwd the same process sees the project skill.
    expect(buildSkillManifest([], { cwd: cwdA })).toContain('session-cwd-skill');
    // And a later no-override call evicts it again (no leak into other sessions).
    expect(buildSkillManifest([])).not.toContain('session-cwd-skill');
  });

  it('evicts collision-fallback `project:<name>` entries on cwd change', () => {
    // Same skill name in user scope and project A: user scope scans first and
    // keeps the bare name, so the project entry registers as `project:<name>`.
    writeUserSkillIn(tmpAfkHome, 'shared-name', 'User-scope variant');
    writeSkillIn(cwdA, 'shared-name', 'Project-A variant');

    const entriesA = collectSkillEntries([], { cwd: cwdA });
    const namesA = entriesA.map((e) => e.name);
    expect(namesA).toContain('shared-name');
    expect(namesA).toContain('project:shared-name');

    // Switching to project B must evict the namespaced fallback entry too.
    const entriesB = collectSkillEntries([], { cwd: cwdB });
    const namesB = entriesB.map((e) => e.name);
    expect(namesB).toContain('shared-name');
    expect(namesB).not.toContain('project:shared-name');
  });
});

describe('scanAllPluginRoots', () => {
  it('returns well-formed local plugin configs', () => {
    _resetPluginScanCache();
    const roots = scanAllPluginRoots();
    expect(Array.isArray(roots)).toBe(true);
    for (const r of roots) {
      expect(r.type).toBe('local');
      expect(typeof r.path).toBe('string');
    }
  });

  it('surfaces a user-scope plugin together with its manifest `main`', () => {
    // AFK_HOME is stubbed to an empty temp dir by the file-level beforeEach, so
    // getPluginsDir() points inside it. Drop a fixture plugin that declares a
    // `main`, then assert scanAllPluginRoots() carries it through — this is the
    // scan→entrypoint flow that loadPluginEntrypoints() consumes at boot.
    const pluginDir = join(getPluginsDir(), 'with-main');
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'with-main', version: '0.0.0', main: 'dist/index.js' }),
    );
    _resetPluginScanCache();

    expect(scanAllPluginRoots()).toContainEqual({
      type: 'local',
      path: pluginDir,
      main: 'dist/index.js',
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: project-scoped plugins must resolve against the session cwd,
// not process.cwd(). Same bug class as the skills-cwd fix (#179 follow-up).
// ---------------------------------------------------------------------------
describe('scanAllPluginRoots — project plugin session-cwd resolution', () => {
  let tmpAfkHome: string;
  let cwdA: string;
  let cwdB: string;
  let origCwd: string;

  beforeEach(() => {
    _resetPluginScanCache();
    vi.unstubAllEnvs();

    tmpAfkHome = mkdtempSync('/tmp/plugin-roots-evict-afkhome-');
    cwdA = mkdtempSync('/tmp/plugin-roots-evict-cwdA-');
    cwdB = mkdtempSync('/tmp/plugin-roots-evict-cwdB-');
    origCwd = process.cwd();

    vi.stubEnv('AFK_HOME', tmpAfkHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(origCwd);
    try { rmSync(tmpAfkHome, { recursive: true }); } catch { /* non-fatal */ }
    try { rmSync(cwdA, { recursive: true }); } catch { /* non-fatal */ }
    try { rmSync(cwdB, { recursive: true }); } catch { /* non-fatal */ }
  });

  function writePluginIn(baseDir: string, pluginName: string, _description: string): void {
    const pluginDir = join(baseDir, '.afk', 'plugins', pluginName);
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: pluginName, version: '0.0.0' }),
    );
  }

  it('scanAllPluginRoots resolves project plugins against opts.cwd', () => {
    writePluginIn(cwdA, 'proj-a-plugin', 'Plugin only in project A');

    _resetPluginScanCache();
    const rootsA = scanAllPluginRoots({ cwd: cwdA });
    const pathsA = rootsA.map((r) => r.path);
    expect(pathsA.some((p) => p.includes('proj-a-plugin'))).toBe(true);

    _resetPluginScanCache();
    const rootsB = scanAllPluginRoots({ cwd: cwdB });
    const pathsB = rootsB.map((r) => r.path);
    expect(pathsB.some((p) => p.includes('proj-a-plugin'))).toBe(false);
  });
});

describe('discoverPluginSkillBodies — project plugin session-cwd resolution', () => {
  let tmpAfkHome: string;
  let cwdA: string;
  let cwdB: string;
  let origCwd: string;

  beforeEach(() => {
    _resetPluginScanCache();
    vi.unstubAllEnvs();

    tmpAfkHome = mkdtempSync('/tmp/plugin-bodies-evict-afkhome-');
    cwdA = mkdtempSync('/tmp/plugin-bodies-evict-cwdA-');
    cwdB = mkdtempSync('/tmp/plugin-bodies-evict-cwdB-');
    origCwd = process.cwd();

    vi.stubEnv('AFK_HOME', tmpAfkHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(origCwd);
    try { rmSync(tmpAfkHome, { recursive: true }); } catch { /* non-fatal */ }
    try { rmSync(cwdA, { recursive: true }); } catch { /* non-fatal */ }
    try { rmSync(cwdB, { recursive: true }); } catch { /* non-fatal */ }
  });

  function writePluginSkillIn(baseDir: string, skillName: string, body: string): void {
    const pluginDir = join(baseDir, '.afk', 'plugins', `${skillName}-plugin`);
    const skillDir = join(pluginDir, 'skills', skillName);
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pluginDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: `${skillName}-plugin`, version: '0.0.0' }),
    );
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: Plugin skill ${skillName}\n---\n${body}\n`,
    );
  }

  it('discoverPluginSkillBodies forwards opts.cwd to project scan', () => {
    writePluginSkillIn(cwdA, 'session-cwd-plugin-skill', 'Plugin skill body');

    _resetPluginScanCache();
    const bodiesWithoutCwd = discoverPluginSkillBodies();
    expect(bodiesWithoutCwd.has('session-cwd-plugin-skill')).toBe(false);

    _resetPluginScanCache();
    const bodiesWithCwd = discoverPluginSkillBodies(undefined, { cwd: cwdA });
    expect(bodiesWithCwd.has('session-cwd-plugin-skill')).toBe(true);

    // And switching to project B must not leak project A's plugin skill,
    // while project B's own plugin skill becomes visible (cwd-A -> cwd-B
    // switch — mirrors the scanAllPluginRoots eviction test above, which
    // this test previously didn't exercise).
    writePluginSkillIn(cwdB, 'other-cwd-plugin-skill', 'Plugin skill body B');

    _resetPluginScanCache();
    const bodiesWithCwdB = discoverPluginSkillBodies(undefined, { cwd: cwdB });
    expect(bodiesWithCwdB.has('other-cwd-plugin-skill')).toBe(true);
    expect(bodiesWithCwdB.has('session-cwd-plugin-skill')).toBe(false);
  });
});
