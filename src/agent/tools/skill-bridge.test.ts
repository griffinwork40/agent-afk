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
import { buildSkillManifest, collectSkillEntries, discoverPluginSkillBodies } from './skill-bridge.js';
import { registerSkill, _resetRegistry } from '../../skills/index.js';

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
