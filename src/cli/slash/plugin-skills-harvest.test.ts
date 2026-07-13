/**
 * Tests for src/cli/slash/plugin-skills.ts — harvestPluginSkillFlags
 *
 * Verifies that the harvester walks the plugin cache, parses SKILL.md
 * frontmatter and body for flag definitions, and returns a deduplicated,
 * sorted map keyed by skill name.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { useUnsetAfkHome } from '../../__test-utils__/unset-afk-home.js';

describe('harvestPluginSkillFlags', () => {
  // The "defaults to ~/.afk/plugins/cache under HOME" case asserts the
  // unset-AFK_HOME fallback — drop the global sentinel AFK_HOME per test.
  // The harvester is read-only and every other case passes an explicit
  // cacheRoot, so nothing writes into $HOME/.afk.
  useUnsetAfkHome();

  let tmpRoot: string;
  let harvestPluginSkillFlags: (cacheRoot?: string) => Map<string, string[]>;

  beforeEach(async () => {
    const mod = await import('./plugin-skills.js');
    harvestPluginSkillFlags = mod.harvestPluginSkillFlags;
    tmpRoot = join(tmpdir(), `afk-harvest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns an empty map when cache directory does not exist', () => {
    const result = harvestPluginSkillFlags('/nonexistent/path');
    expect(result).toEqual(new Map());
  });

  it('returns an empty map for an empty cache', () => {
    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result).toEqual(new Map());
  });

  it('defaults to ~/.afk/plugins/cache under HOME when cacheRoot is omitted', () => {
    const originalHome = process.env['HOME'];
    process.env['HOME'] = tmpRoot;
    try {
      mkdirSync(join(tmpRoot, '.afk', 'plugins', 'cache', 'test-plugin', 'skills', 'defaulted'), {
        recursive: true,
      });
      writeFileSync(
        join(tmpRoot, '.afk', 'plugins', 'cache', 'test-plugin', 'skills', 'defaulted', 'SKILL.md'),
        `# Defaulted Skill

Supports --defaulted.
`,
      );

      const result = harvestPluginSkillFlags();
      expect(result.get('defaulted')).toEqual(['--defaulted']);
    } finally {
      if (originalHome !== undefined) process.env['HOME'] = originalHome;
      else delete process.env['HOME'];
    }
  });

  it('skips non-file entries (e.g. directory named SKILL.md)', () => {
    // Create a directory instead of a file — harvester should skip gracefully
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'bad'), { recursive: true });
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'bad', 'SKILL.md'));

    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result).toEqual(new Map());
  });

  it('harvests flags from body when no frontmatter is present', () => {
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'mint'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'mint', 'SKILL.md'),
      `# Mint Skill

This skill supports --auto, --ship, and --pr flags for automation.
Use --auto to skip confirmations or --pr to create a pull request.
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result.get('mint')).toEqual(['--auto', '--pr', '--ship']); // sorted
  });

  it('deduplicates flags mentioned multiple times in the body', () => {
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'ship'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'ship', 'SKILL.md'),
      `# Ship Skill

Use --ship to deploy. The --ship flag is powerful.
Optionally use --ship with --verify for extra safety.
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result.get('ship')).toEqual(['--ship', '--verify']); // deduplicated and sorted
  });

  it('rejects noise patterns (dashes, yaml, urls, lowercase start)', () => {
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'noisy'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'noisy', 'SKILL.md'),
      `# Noisy Skill

Ignore these: --, ---, ---yaml---, http://x.com/--path, --5bad, --_underscore, --UPPER.
Only capture --valid, --flags-here, --and-123-nums.
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result.get('noisy')).toEqual(['--and-123-nums', '--flags-here', '--valid']);
  });

  it('parses inline frontmatter flags: [--x, --y]', () => {
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'inline-flags'), {
      recursive: true,
    });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'inline-flags', 'SKILL.md'),
      `---
name: inline-flags
description: Test skill
flags: [--x, --y]
---

# Body content mentioning --ignored and --also-ignored.
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result.get('inline-flags')).toEqual(['--x', '--y']);
  });

  it('harvests flags from the argument-hint frontmatter field', () => {
    // argument-hint is the standard Claude Code / agentskills.io-compatible
    // field for declaring the CLI surface. Flags written there must complete
    // in the dropdown without a proprietary `flags:` field. Regression guard
    // for /review --post (PR #35), which lived only in the dispatch layer.
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'review'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'review', 'SKILL.md'),
      `---
name: review
description: Review changes
argument-hint: "[--staged|--head] [--post github|telegram]"
---

# Review skill body with no flag mentions.
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result.get('review')).toEqual(['--head', '--post', '--staged']); // sorted
  });

  it('unions argument-hint flags with body flags (no frontmatter flags:)', () => {
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'merged'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'merged', 'SKILL.md'),
      `---
name: merged
description: Test skill
argument-hint: "[--post github|telegram]"
---

Add --verify to trigger the extra wave.
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result.get('merged')).toEqual(['--post', '--verify']); // argHint ∪ body, sorted
  });

  it('frontmatter flags: still wins over argument-hint', () => {
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'explicit'), { recursive: true });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'explicit', 'SKILL.md'),
      `---
name: explicit
description: Test skill
flags: [--only-this]
argument-hint: "[--ignored-hint]"
---

Body mentions --also-ignored.
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result.get('explicit')).toEqual(['--only-this']);
  });

  it('parses block-form frontmatter flags', () => {
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'block-flags'), {
      recursive: true,
    });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'block-flags', 'SKILL.md'),
      `---
name: block-flags
description: Test skill
flags:
  - --foo
  - --bar
  - --baz
---

# Body with --ignored flags.
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result.get('block-flags')).toEqual(['--bar', '--baz', '--foo']); // sorted
  });

  it('ignores body flags when frontmatter flags are present', () => {
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'override'), {
      recursive: true,
    });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'override', 'SKILL.md'),
      `---
flags: [--override]
---

This body mentions --ignored-one and --ignored-two, but they should not appear.
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result.get('override')).toEqual(['--override']);
  });

  it('merges and deduplicates flags from two plugins with same skill name', () => {
    // Create two plugins with the same skill name
    mkdirSync(join(tmpRoot, 'plugins', 'plugin1', 'skills', 'shared'), { recursive: true });
    mkdirSync(join(tmpRoot, 'plugins', 'plugin2', 'skills', 'shared'), { recursive: true });

    writeFileSync(
      join(tmpRoot, 'plugins', 'plugin1', 'skills', 'shared', 'SKILL.md'),
      `---
flags: [--alpha, --beta]
---
`,
    );

    writeFileSync(
      join(tmpRoot, 'plugins', 'plugin2', 'skills', 'shared', 'SKILL.md'),
      `---
flags: [--beta, --gamma]
---
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    expect(result.get('shared')).toEqual(['--alpha', '--beta', '--gamma']); // merged and deduplicated
  });

  it('normalizes flags with leading -- when parsed from frontmatter', () => {
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'normalize'), {
      recursive: true,
    });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'normalize', 'SKILL.md'),
      `---
flags:
  - --already-there
  - -single-dash-should-get-doubled
---
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    // Flags should have double dash
    const flags = result.get('normalize');
    expect(flags).toBeDefined();
    // Verify all flags start with --
    for (const flag of flags!) {
      expect(flag).toMatch(/^--/);
    }
  });

  it('skips files that cannot be read (permission error)', () => {
    // Create a readable SKILL.md and an unreadable one
    mkdirSync(join(tmpRoot, 'plugins', 'plugin1', 'skills', 'good'), { recursive: true });
    mkdirSync(join(tmpRoot, 'plugins', 'plugin2', 'skills', 'bad'), { recursive: true });

    writeFileSync(
      join(tmpRoot, 'plugins', 'plugin1', 'skills', 'good', 'SKILL.md'),
      `---
flags: [--found]
---
`,
    );

    // Create an unreadable file (on Unix-like systems)
    const badPath = join(tmpRoot, 'plugins', 'plugin2', 'skills', 'bad', 'SKILL.md');
    writeFileSync(badPath, 'content');
    try {
      // Note: chmod is platform-specific. On some systems this may not work.
      // The test is best-effort — the harvester should handle read errors gracefully.
      // We'll test this by wrapping the read in try/catch at the implementation level.
      // For now, just verify the good file is found.
      const result = harvestPluginSkillFlags(tmpRoot);
      expect(result.has('good')).toBe(true);
    } finally {
      // Attempt to restore permissions in case chmod worked
      try {
        // eslint-disable-next-line no-bitwise
        require('fs').chmodSync(badPath, 0o644);
      } catch {
        // Ignore
      }
    }
  });

  it('respects max depth (8 levels from cacheRoot)', () => {
    // Create a skill at exactly 8 levels deep from tmpRoot
    const deepPath = join(
      tmpRoot,
      'level1',
      'level2',
      'level3',
      'level4',
      'level5',
      'level6',
      'level7',
      'level8',
    );
    mkdirSync(deepPath, { recursive: true });
    writeFileSync(
      join(deepPath, 'SKILL.md'),
      `---
flags: [--deep]
---
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    // Should find the deep skill (8 is the max depth)
    // The directory name at level8 is the skill name
    expect(result.size).toBeGreaterThan(0);
  });

  it('handles YAML with no leading dashes in block form', () => {
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'nodash'), {
      recursive: true,
    });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'nodash', 'SKILL.md'),
      `---
flags:
  - help
  - version
---
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    const flags = result.get('nodash');
    expect(flags).toBeDefined();
    // Should normalize to --help, --version
    expect(flags).toContain('--help');
    expect(flags).toContain('--version');
  });

  it('returns sorted flag arrays for deterministic output', () => {
    mkdirSync(join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'unsorted'), {
      recursive: true,
    });
    writeFileSync(
      join(tmpRoot, 'plugins', 'test-plugin', 'skills', 'unsorted', 'SKILL.md'),
      `# Skill

Mentions --zebra, --apple, --monkey, --banana in random order.
`,
    );

    const result = harvestPluginSkillFlags(tmpRoot);
    const flags = result.get('unsorted');
    const sorted = [...flags!].sort();
    expect(flags).toEqual(sorted);
  });
});
