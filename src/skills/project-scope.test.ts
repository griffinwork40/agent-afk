/**
 * Tests for project-level discovery from <cwd>/.afk/.
 *
 * Verifies that skills and plugins under the working directory's .afk/
 * directory are discovered alongside user-scope (~/.afk/) resources.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { _resetRegistry, listSkills, getSkill } from './index.js';

// ---------------------------------------------------------------------------
// Set up a temp project dir and mock process.cwd() + getSkillsDir/getPluginsDir
// so the user-scope scanner hits an empty dir (no cross-talk with real ~/.afk)
// ---------------------------------------------------------------------------

const tempDir = join(tmpdir(), `afk-project-scope-test-${Date.now()}`);
const projectAfk = join(tempDir, 'project', '.afk');
const projectSkillsDir = join(projectAfk, 'skills');
const projectPluginsDir = join(projectAfk, 'plugins');
const userSkillsDir = join(tempDir, 'user-skills');

vi.mock('../paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../paths.js')>();
  return {
    ...actual,
    getSkillsDir: () => userSkillsDir,
    getProjectAfkDir: () => projectAfk,
    getProjectSkillsDir: () => projectSkillsDir,
    getProjectPluginsDir: () => projectPluginsDir,
  };
});

const { scanAndRegisterUserSkills, scanSkillsFromDir } = await import(
  './user-skills.js'
);

const { getProjectSkillsDir: getProjectSkillsDirFn } = await import(
  '../paths.js'
);

describe('Project-scope skill discovery', () => {
  beforeEach(() => {
    _resetRegistry();
    mkdirSync(projectSkillsDir, { recursive: true });
    mkdirSync(userSkillsDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('getProjectSkillsDir resolves to <cwd>/.afk/skills', () => {
    expect(getProjectSkillsDirFn()).toBe(projectSkillsDir);
  });

  it('discovers a project skill with origin: project', () => {
    const dir = join(projectSkillsDir, 'my-project-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: my-project-skill
description: A project-level skill
---

You are a project-specific assistant.
`,
    );

    const count = scanSkillsFromDir(projectSkillsDir, 'project');
    expect(count).toBe(1);
    expect(listSkills()).toContain('my-project-skill');

    const skill = getSkill('my-project-skill');
    expect(skill.origin).toBe('project');
    expect(skill.description).toBe('A project-level skill');
  });

  it('returns 0 when project .afk/skills/ does not exist', () => {
    rmSync(projectSkillsDir, { recursive: true, force: true });
    expect(scanSkillsFromDir(projectSkillsDir, 'project')).toBe(0);
  });

  it('returns 0 when project skills dir is empty', () => {
    expect(scanSkillsFromDir(projectSkillsDir, 'project')).toBe(0);
  });

  it('user skill keeps bare name; project skill gets project:<name> on collision', () => {
    // Register user skill first
    const userDir = join(userSkillsDir, 'lint');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(userDir, 'SKILL.md'),
      `---
name: lint
description: User lint skill
---

User lint body.
`,
    );
    scanAndRegisterUserSkills();

    // Now register project skill with same name
    const projectDir = join(projectSkillsDir, 'lint');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'SKILL.md'),
      `---
name: lint
description: Project lint skill
---

Project lint body.
`,
    );
    scanSkillsFromDir(projectSkillsDir, 'project');

    // User skill keeps bare name
    expect(getSkill('lint').origin).toBe('user');
    expect(getSkill('lint').description).toBe('User lint skill');

    // Project skill namespaced
    expect(getSkill('project:lint').origin).toBe('project');
    expect(getSkill('project:lint').description).toBe('Project lint skill');
  });

  it('project skill gets bare name when no collision', () => {
    const dir = join(projectSkillsDir, 'deploy');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: deploy
description: Project deploy skill
---

Deploy things.
`,
    );

    scanSkillsFromDir(projectSkillsDir, 'project');
    expect(getSkill('deploy').origin).toBe('project');
    expect(getSkill('deploy').name).toBe('deploy');
  });

  it('both user and project skills coexist without collision', () => {
    const userDir = join(userSkillsDir, 'format');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(userDir, 'SKILL.md'),
      `---
name: format
description: User format
---

Format user.
`,
    );
    scanAndRegisterUserSkills();

    const projDir = join(projectSkillsDir, 'test-runner');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'SKILL.md'),
      `---
name: test-runner
description: Project test runner
---

Run tests.
`,
    );
    scanSkillsFromDir(projectSkillsDir, 'project');

    expect(listSkills()).toContain('format');
    expect(listSkills()).toContain('test-runner');
    expect(getSkill('format').origin).toBe('user');
    expect(getSkill('test-runner').origin).toBe('project');
  });

  it('skips dot-prefixed and underscore-prefixed directories', () => {
    for (const name of ['.hidden', '_internal']) {
      const dir = join(projectSkillsDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---
name: ${name}
description: Should be skipped
---

Body.
`,
      );
    }

    expect(scanSkillsFromDir(projectSkillsDir, 'project')).toBe(0);
  });
});
