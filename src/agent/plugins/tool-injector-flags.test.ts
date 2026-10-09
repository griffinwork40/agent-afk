/**
 * #3332 — plugin SKILL.md flags + category are parsed ONCE during discovery
 * (`parseSkillMetadata`) instead of a separate CLI-side disk walk.
 *
 * Pins the shared precedence: an explicit frontmatter `flags:` list (inline or
 * block form) wins outright; otherwise flags come from `argument-hint` + body.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractPluginSkills, parseSkillMetadata } from './tool-injector.js';
import { _resetPluginScanCache } from '../plugins-scanner.js';

describe('parseSkillMetadata — flags + category (#3332)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'plugin-flags-'));
    _resetPluginScanCache();
  });

  afterEach(() => {
    _resetPluginScanCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSkill(content: string): string {
    const path = join(tmpDir, 'SKILL.md');
    writeFileSync(path, content);
    return path;
  }

  it('parses inline-form flags (normalised + sorted) and category', () => {
    const meta = parseSkillMetadata(
      writeSkill(`---
name: pr-triage
description: Batch-review PRs
category: "Build & ship"
flags: [--skip-fix, auto-merge, --prs]
---
Body mentions --body-only-flag.
`),
    );
    expect(meta.flags).toEqual(['--auto-merge', '--prs', '--skip-fix']);
    expect(meta.category).toBe('Build & ship');
  });

  it('parses block-form flags and does not mistake list items for keys', () => {
    const meta = parseSkillMetadata(
      writeSkill(`---
name: tackle
description: Tackle issues
flags:
  - --draft
  - label
category: Debug & fix
---
Body mentions --ignored.
`),
    );
    expect(meta.flags).toEqual(['--draft', '--label']);
    expect(meta.category).toBe('Debug & fix');
    expect(meta.name).toBe('tackle');
  });

  it('falls back to argument-hint + body scan when no flags: list is declared', () => {
    const meta = parseSkillMetadata(
      writeSkill(`---
name: review
description: Review a diff
argument-hint: "[--post github|telegram] [--light]"
---
Run with --staged to review staged changes.
`),
    );
    expect(meta.flags).toEqual(['--light', '--post', '--staged']);
    expect(meta.category).toBeUndefined();
  });

  it('frontmatter flags: wins over argument-hint flags', () => {
    const meta = parseSkillMetadata(
      writeSkill(`---
name: ship
description: Ship it
argument-hint: "[--verify]"
flags: [--dry-run]
---
`),
    );
    expect(meta.flags).toEqual(['--dry-run']);
  });

  it('omits flags entirely when nothing declares any', () => {
    const meta = parseSkillMetadata(writeSkill(`---
name: plain
description: No flags here
---
Just prose.
`));
    expect(meta.flags).toBeUndefined();
  });

  it('extractPluginSkills surfaces flags + category on discovered skills', () => {
    mkdirSync(join(tmpDir, 'skills', 'pr-triage'), { recursive: true });
    writeFileSync(
      join(tmpDir, 'skills', 'pr-triage', 'SKILL.md'),
      `---
name: pr-triage
description: Batch-review PRs
category: Build & ship
flags: [--prs]
---
`,
    );
    const [skill] = extractPluginSkills(tmpDir);
    expect(skill?.flags).toEqual(['--prs']);
    expect(skill?.category).toBe('Build & ship');
  });
});
