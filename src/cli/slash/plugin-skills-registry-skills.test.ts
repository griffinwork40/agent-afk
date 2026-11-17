/**
 * Registry skills (built-in, user, project, imported) reach
 * `registerPluginSkills` in the same list as plugin skills, because
 * `session.supportedCommands()` returns both.
 *
 * Regression: each registry skill used to be treated as a plugin candidate,
 * find its OWN bare name reserved, and get recorded as shadowing itself under a
 * made-up `plugin:<name>`. `/skills` then printed `↳ also: /plugin:<name>`
 * under every non-plugin skill, and a skill added mid-session was reachable
 * only under that made-up name.
 *
 * These tests drive the real discovery path (SKILL.md on disk →
 * collectSkillEntries → collectSupportedCommands → registerPluginSkills).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { useUnsetAfkHome } from '../../__test-utils__/unset-afk-home.js';
import { _resetPluginScanCache } from '../../agent/plugins-scanner.js';
import { collectSupportedCommands } from '../../agent/providers/shared/supported-commands.js';
import { registerPluginSkills } from './plugin-skills.js';
import { state, isRegistrySource } from './plugin-skills/state.js';
import { lookup, resetRegistry } from './registry.js';
import { evictSkillsByOrigin } from '../../skills/skill-registry.js';
import { stripAnsi } from '../display.js';
import type { SlashContext } from './types.js';

type Session = Parameters<typeof registerPluginSkills>[0];

function skillMd(name: string, description: string, extraFrontmatter = ''): string {
  return `---\nname: ${name}\ndescription: "${description}"\n${extraFrontmatter}---\n\nBody of ${name}.\n`;
}

function makeCtx(): { ctx: SlashContext; lines: string[] } {
  const lines: string[] = [];
  const push = (t = ''): void => void lines.push(t);
  const ctx = {
    session: { current: {} },
    stats: {},
    out: { line: push, raw: push, success: push, info: push, warn: push, error: push },
    ui: { clearScreen: vi.fn(), repaintStatusLine: vi.fn() },
  } as unknown as SlashContext;
  return { ctx, lines };
}

async function renderSkillsListing(): Promise<string> {
  const { ctx, lines } = makeCtx();
  await lookup('/skills')!.handler(ctx, '');
  return stripAnsi(lines.join('\n'));
}

describe('registry skills in registerPluginSkills', () => {
  useUnsetAfkHome();

  let tmpRoot: string;
  let userSkills: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  const realSession = { supportedCommands: () => collectSupportedCommands() } as unknown as Session;

  function writeUserSkill(name: string, content: string): void {
    mkdirSync(join(userSkills, name), { recursive: true });
    writeFileSync(join(userSkills, name, 'SKILL.md'), content);
  }

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `afk-regskills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    userSkills = join(tmpRoot, '.afk', 'skills');
    mkdirSync(userSkills, { recursive: true });
    originalHome = process.env['HOME'];
    originalUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = tmpRoot;
    process.env['USERPROFILE'] = tmpRoot;
    _resetPluginScanCache();
    resetRegistry();
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    process.env['USERPROFILE'] = originalUserProfile;
    evictSkillsByOrigin('user');
    _resetPluginScanCache();
    resetRegistry();
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('gives a user skill its bare command and no made-up plugin form', async () => {
    writeUserSkill('zzreg-alpha', skillMd('zzreg-alpha', 'Alpha registry skill for the self-collision test.'));

    await registerPluginSkills(realSession);

    expect(lookup('/zzreg-alpha')).toBeDefined();
    expect(lookup('/plugin:zzreg-alpha')).toBeUndefined();
    // Built-in registry skills take the same path.
    expect(lookup('/mint')).toBeDefined();
    expect(lookup('/plugin:mint')).toBeUndefined();
    // No registry skill is ever recorded as shadowing itself.
    expect(state.collisions.filter((c) => isRegistrySource(c.source))).toEqual([]);
    // The full discovered list is kept: the reload delta reads it.
    expect(state.discovered.some((d) => d.name === 'zzreg-alpha')).toBe(true);
  });

  it('lists a registry skill once in /skills, with no alternative line', async () => {
    writeUserSkill('zzreg-alpha', skillMd('zzreg-alpha', 'Alpha registry skill for the self-collision test.'));

    await registerPluginSkills(realSession);
    const out = await renderSkillsListing();

    expect(out).toContain('/zzreg-alpha');
    expect(out).not.toContain('/plugin:');
    expect(out).not.toContain('↳ also:');
  });

  it('gives a skill added to disk mid-session its bare command on the next registration', async () => {
    await registerPluginSkills(realSession);
    expect(lookup('/zzreg-late')).toBeUndefined();

    // The skill appears on disk after boot; `/reload-plugins` re-runs registration.
    writeUserSkill('zzreg-late', skillMd('zzreg-late', 'Skill added after the first registration.'));
    await registerPluginSkills(realSession);

    expect(lookup('/zzreg-late')).toBeDefined();
    expect(lookup('/plugin:zzreg-late')).toBeUndefined();
  });

  it('picks up an edited SKILL.md on the next registration', async () => {
    writeUserSkill('zzreg-edit', skillMd('zzreg-edit', 'Original description of the edited skill.'));
    await registerPluginSkills(realSession);
    expect(lookup('/zzreg-edit')?.summary).toBe('Original description of the edited skill.');

    writeUserSkill('zzreg-edit', skillMd('zzreg-edit', 'Rewritten description of the edited skill.'));
    await registerPluginSkills(realSession);

    expect(lookup('/zzreg-edit')?.summary).toBe('Rewritten description of the edited skill.');
  });

  it('registers a registry skill with the boot handler, carrying its when-to-use hint', async () => {
    // The plugin passthrough derives `hint` from the description; the boot
    // handler takes it from the authored `when-to-use` field. Seeing the
    // authored value proves the registry skill kept the boot-style command.
    writeUserSkill(
      'zzreg-hint',
      skillMd('zzreg-hint', 'Skill with an authored hint.', 'when-to-use: "Only when the moon is full."\n'),
    );

    await registerPluginSkills(realSession);

    expect(lookup('/zzreg-hint')?.hint).toBe('Only when the moon is full.');
  });

  it('still reports a genuine plugin collision as an alternative form', async () => {
    const session = {
      supportedCommands: async () => [
        { name: 'mint', description: 'Built-in mint.', source: 'builtin' },
        { name: 'demo-plugin:mint', description: 'Plugin mint.', source: 'plugin' },
      ],
    } as unknown as Session;

    await registerPluginSkills(session);

    expect(state.collisions).toEqual([{ bare: 'mint', altSlash: '/demo-plugin:mint', source: 'plugin' }]);
    expect(lookup('/demo-plugin:mint')).toBeDefined();
    expect(lookup('/plugin:mint')).toBeUndefined();
    const out = await renderSkillsListing();
    expect(out).toContain('↳ also: /demo-plugin:mint');
  });

  it('skips a registry-sourced entry whose skill is no longer in the registry', async () => {
    // Another session can evict project skills between discovery and
    // registration. The entry must be dropped, not turned into a plugin command.
    const session = {
      supportedCommands: async () => [
        { name: 'zzreg-gone', description: 'Evicted before registration.', source: 'project' },
      ],
    } as unknown as Session;

    await registerPluginSkills(session);

    expect(lookup('/zzreg-gone')).toBeUndefined();
    expect(lookup('/plugin:zzreg-gone')).toBeUndefined();
    expect(state.collisions).toEqual([]);
  });

  it('keeps the boot handler for a namespaced user skill (user:mint) and records no collision', async () => {
    // A user skill named `mint` collides with the built-in, so the skill
    // registry holds it under the `user:mint` namespace. The discovery list
    // carries `source: 'user'`, so `isRegistrySource` routes it through
    // `registerRegistrySkillCommand` — NOT `makeForwardHandler`. That means
    // the authored `when-to-use` hint is preserved (the forward handler would
    // derive hint from the description instead). No collision is recorded
    // because registry skills never compete with themselves for the bare slot.
    writeUserSkill(
      'mint',
      skillMd('mint', 'User override of mint.', 'when-to-use: "Only when the user owns this."\n'),
    );

    await registerPluginSkills(realSession);

    // The namespaced form is reachable and carries the authored hint.
    expect(lookup('/user:mint')?.hint).toBe('Only when the user owns this.');
    // The user skill is never recorded as shadowing itself.
    expect(state.collisions.filter((c) => isRegistrySource(c.source))).toEqual([]);
  });

  it('classifies isRegistrySource correctly for all relevant source values', () => {
    // Branches exercised by other tests: 'builtin', 'user', 'project'.
    // This test closes the gap for 'imported' and the false cases.
    expect(isRegistrySource('imported')).toBe(true);
    // Falsy inputs — an entry with no source is a plugin candidate, not a
    // registry skill, and must NOT be treated as a registry entry.
    expect(isRegistrySource(undefined)).toBe(false);
    // Plugin and command sources are not registry sources.
    expect(isRegistrySource('plugin')).toBe(false);
    expect(isRegistrySource('command')).toBe(false);
  });
});
