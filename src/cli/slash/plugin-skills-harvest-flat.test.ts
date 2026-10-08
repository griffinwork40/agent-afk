/**
 * Regression: flag completion for skills from FLAT-installed plugins.
 *
 * A plugin installed at `~/.afk/plugins/<name>/` (not the marketplace cache)
 * is discovered by the skill bridge, so `/pr-triage` registers as a slash
 * command. The flag harvest used to walk only `~/.afk/plugins/cache/` and the
 * bundled dir, so those commands got no flags and the `--` completion menu
 * never opened. `harvestDiscoveredPluginSkillMetadata` walks every root the
 * bridge discovers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { useUnsetAfkHome } from '../../__test-utils__/unset-afk-home.js';
import { _resetPluginScanCache } from '../../agent/plugins-scanner.js';

const SKILL_MD = `---
name: pr-triage
description: "Batch-review open PRs."
category: "Build & ship"
flags: [--auto-merge, --skip-fix, --prs]
---

# PR Triage
`;

describe('harvestDiscoveredPluginSkillMetadata (flat plugin layout)', () => {
  useUnsetAfkHome();

  let tmpRoot: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `afk-harvest-flat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const plugin = join(tmpRoot, '.afk', 'plugins', 'software-factory');
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'software-factory' }));
    mkdirSync(join(plugin, 'skills', 'pr-triage'), { recursive: true });
    writeFileSync(join(plugin, 'skills', 'pr-triage', 'SKILL.md'), SKILL_MD);
    // A SKILL.md under .git must never be harvested.
    mkdirSync(join(plugin, '.git', 'ghost'), { recursive: true });
    writeFileSync(join(plugin, '.git', 'ghost', 'SKILL.md'), '# ghost\n\nUse --ghost-flag.\n');

    originalHome = process.env['HOME'];
    originalUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = tmpRoot;
    process.env['USERPROFILE'] = tmpRoot;
    _resetPluginScanCache();
  });

  afterEach(() => {
    process.env['HOME'] = originalHome;
    process.env['USERPROFILE'] = originalUserProfile;
    _resetPluginScanCache();
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('harvests flags and category from a flat-installed plugin skill', async () => {
    const { harvestDiscoveredPluginSkillMetadata, harvestAllPluginSkillFlags } = await import(
      './plugin-skills/flags.js'
    );
    const { flags, categories } = harvestDiscoveredPluginSkillMetadata();
    expect(flags.get('pr-triage')).toEqual(['--auto-merge', '--prs', '--skip-fix']);
    expect(categories.get('pr-triage')).toBe('Build & ship');
    expect(harvestAllPluginSkillFlags().get('pr-triage')).toEqual(['--auto-merge', '--prs', '--skip-fix']);
  });

  it('skips SKILL.md files inside .git', async () => {
    const { harvestDiscoveredPluginSkillMetadata } = await import('./plugin-skills/flags.js');
    expect(harvestDiscoveredPluginSkillMetadata().flags.has('ghost')).toBe(false);
  });
});
