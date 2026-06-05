/**
 * Tests for plugin tool extraction and injection.
 *
 * Coverage:
 *  - Extract skills from a plugin directory structure
 *  - Parse SKILL.md frontmatter (YAML)
 *  - Convert skills to tool definitions
 *  - Handle missing or malformed SKILL.md files
 *  - Extract plugin name from path
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmdirSync } from 'fs';
import { join } from 'path';
import {
  extractPluginSkills,
  extractPluginTools,
  extractAllPluginTools,
  extractPluginName,
} from './tool-injector.js';

describe('plugin tool injector', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync('/tmp/plugin-test-');
  });

  afterEach(() => {
    try {
      rmdirSync(tmpDir, { recursive: true });
    } catch {
      // Cleanup failure is non-fatal
    }
  });

  it('should extract skills from a plugin directory', () => {
    const skillDir = join(tmpDir, 'skills');
    const fs = require('fs');
    fs.mkdirSync(skillDir, { recursive: true });

    // Write a skill file with frontmatter
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(
      skillPath,
      `---
name: test-skill
description: A test skill
argumentHint: "[optional args]"
---
# Test Skill

This is a test skill.
`
    );

    const skills = extractPluginSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      name: 'test-skill',
      description: 'A test skill',
      argumentHint: '[optional args]',
      body: '# Test Skill\n\nThis is a test skill.',
    });
  });

  it('should handle SKILL.md without frontmatter', () => {
    const skillDir = join(tmpDir, 'skills');
    const fs = require('fs');
    fs.mkdirSync(skillDir, { recursive: true });

    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, '# No Frontmatter\n\nJust content.');

    const skills = extractPluginSkills(tmpDir);
    expect(skills).toHaveLength(0);
  });

  it('should discover skills in nested directories', () => {
    const fs = require('fs');
    const skill1Dir = join(tmpDir, 'skills', 'subdir1');
    const skill2Dir = join(tmpDir, 'skills', 'subdir2');
    fs.mkdirSync(skill1Dir, { recursive: true });
    fs.mkdirSync(skill2Dir, { recursive: true });

    writeFileSync(
      join(skill1Dir, 'SKILL.md'),
      `---
name: skill-one
description: First skill
---
Content`
    );
    writeFileSync(
      join(skill2Dir, 'SKILL.md'),
      `---
name: skill-two
description: Second skill
---
Content`
    );

    const skills = extractPluginSkills(tmpDir);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name).sort()).toEqual(['skill-one', 'skill-two']);
  });

  it('should convert skills to tool definitions', () => {
    const skillDir = join(tmpDir, 'skills');
    const fs = require('fs');
    fs.mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: my-skill
description: My skill description
---
Content`
    );

    const tools = extractPluginTools(tmpDir, 'my-plugin');
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'plugin_my_plugin_my_skill',
      description: 'My skill description',
      input_schema: {
        type: 'object',
        properties: expect.objectContaining({
          arguments: expect.objectContaining({
            type: 'string',
          }),
        }),
      },
    });
  });

  it('should handle special characters in skill names', () => {
    const skillDir = join(tmpDir, 'skills');
    const fs = require('fs');
    fs.mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: my-special-skill_123
description: Test
---
Content`
    );

    const tools = extractPluginTools(tmpDir, 'test-plugin');
    expect(tools[0].name).toBe('plugin_test_plugin_my_special_skill_123');
  });

  it('should handle missing argumentHint gracefully', () => {
    const skillDir = join(tmpDir, 'skills');
    const fs = require('fs');
    fs.mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: no-hint-skill
description: A skill without argumentHint
---
Content`
    );

    const tools = extractPluginTools(tmpDir, 'plugin');
    expect(tools[0].input_schema.properties.arguments.description).toBe(
      'Arguments to pass to the skill'
    );
  });

  it('should extract multiple plugin tools', () => {
    const plugins = [
      { type: 'local' as const, path: tmpDir },
    ];

    const skillDir = join(tmpDir, 'skills');
    const fs = require('fs');
    fs.mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: multi-skill
description: Multiple plugins test
---
Content`
    );

    const tools = extractAllPluginTools(plugins);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0].name).toContain('plugin_');
  });

  it('should skip non-local plugins gracefully', () => {
    const plugins = [
      // @ts-expect-error Testing edge case
      { type: 'marketplace', path: '/some/path' },
    ];

    const tools = extractAllPluginTools(plugins);
    expect(tools).toHaveLength(0);
  });

  it('should handle plugin paths that do not exist', () => {
    const nonexistentPlugin = join(tmpDir, 'nonexistent');
    const skills = extractPluginSkills(nonexistentPlugin);
    expect(skills).toHaveLength(0);
  });

  it('should handle malformed YAML gracefully', () => {
    const skillDir = join(tmpDir, 'skills');
    const fs = require('fs');
    fs.mkdirSync(skillDir, { recursive: true });

    // Malformed frontmatter (missing closing ---)
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: bad-skill
description: This is malformed

# No closing frontmatter
Content`
    );

    const skills = extractPluginSkills(tmpDir);
    expect(skills).toHaveLength(0);
  });

  it('should parse quoted YAML values', () => {
    const skillDir = join(tmpDir, 'skills');
    const fs = require('fs');
    fs.mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: "quoted-skill"
description: "A skill with quoted values"
---
Content`
    );

    const skills = extractPluginSkills(tmpDir);
    expect(skills[0]!.name).toBe('quoted-skill');
    expect(skills[0]!.description).toBe('A skill with quoted values');
  });

  it('should extract SKILL.md body content', () => {
    const skillDir = join(tmpDir, 'skills');
    const fs = require('fs');
    fs.mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: body-test
description: Test body extraction
---
## Instructions

Do the thing.

Use **bold** for emphasis.`
    );

    const skills = extractPluginSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.body).toBe('## Instructions\n\nDo the thing.\n\nUse **bold** for emphasis.');
  });

  it('should not set body when SKILL.md has no content after frontmatter', () => {
    const skillDir = join(tmpDir, 'skills');
    const fs = require('fs');
    fs.mkdirSync(skillDir, { recursive: true });

    writeFileSync(
      join(skillDir, 'SKILL.md'),
      `---
name: empty-body
description: No body
---
`
    );

    const skills = extractPluginSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.body).toBeUndefined();
  });

  describe('extractPluginName', () => {
    it('should extract name from flat layout', () => {
      expect(extractPluginName('/Users/me/.afk/plugins/my-plugin')).toBe('my-plugin');
    });

    it('should extract name from marketplace cache layout', () => {
      expect(
        extractPluginName('/Users/me/.afk/plugins/cache/marketplace1/my-plugin/1.0.0')
      ).toBe('my-plugin');
    });

    it('should handle cache layout with deep nesting', () => {
      expect(
        extractPluginName('/home/user/.afk/plugins/cache/registry/awesome-plugin/2.3.1')
      ).toBe('awesome-plugin');
    });

    it('should return "unknown" for empty path', () => {
      expect(extractPluginName('')).toBe('unknown');
    });

    it('should use last component when no cache in path', () => {
      expect(extractPluginName('/some/random/path/plugin-name')).toBe('plugin-name');
    });
  });
});
