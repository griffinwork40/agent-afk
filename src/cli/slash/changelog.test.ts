import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Test the changelog command's core logic (parse + format + write) by
 * creating a temporary git repo with conventional commits and running
 * the functions directly.
 */

// Import the internals indirectly by exercising the handler against a
// real temp git repo. We test the full handler path.
import { changelogCmd } from './commands/changelog.js';
import type { SlashContext, Writer } from './types.js';

function makeWriter(): Writer & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    line(text?: string) { lines.push(text ?? ''); },
    raw(text: string) { lines.push(text); },
    success(text: string) { lines.push(`✓ ${text}`); },
    info(text: string) { lines.push(`ℹ ${text}`); },
    warn(text: string) { lines.push(`⚠ ${text}`); },
    error(text: string) { lines.push(`✗ ${text}`); },
  };
}

function makeCtx(writer: Writer): SlashContext {
  return {
    out: writer,
    stats: { totalTurns: 0, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 0, sessionStartTime: 0, turnCosts: [], turnTokens: [], turns: [], model: 'claude-opus' as const, permissionMode: 'default' },
    session: {} as never,
    ui: { clearScreen: () => {}, repaintStatusLine: () => {} },
  } as SlashContext;
}

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
}

describe('/changelog', () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'changelog-test-'));

    sh('git init', tmpDir);
    sh('git config user.email "test@test.com"', tmpDir);
    sh('git config user.name "Test"', tmpDir);

    const changelogContent = `# Changelog

## [Unreleased]

## [0.1.0] - 2026-01-01

### Added
- Initial release

[Unreleased]: https://github.com/test/test/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/test/test/releases/tag/v0.1.0
`;
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), changelogContent);
    sh('git add -A && git commit -m "chore: initial commit"', tmpDir);
    sh('git tag v0.1.0', tmpDir);

    // Add commits after the tag
    writeFileSync(join(tmpDir, 'a.ts'), 'export const a = 1;');
    sh('git add -A && git commit -m "feat: add new feature A"', tmpDir);

    writeFileSync(join(tmpDir, 'b.ts'), 'export const b = 2;');
    sh('git add -A && git commit -m "fix: resolve crash on startup"', tmpDir);

    writeFileSync(join(tmpDir, 'c.ts'), 'export const c = 3;');
    sh('git add -A && git commit -m "refactor(core): simplify session logic"', tmpDir);

    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates grouped entries from conventional commits', async () => {
    const writer = makeWriter();
    const ctx = makeCtx(writer);

    const result = await changelogCmd.handler(ctx, '--dry-run');
    expect(result).toBe('continue');

    const output = writer.lines.join('\n');
    expect(output).toContain('3 commits since last tag');
    expect(output).toContain('### Added');
    expect(output).toContain('add new feature A');
    expect(output).toContain('### Fixed');
    expect(output).toContain('resolve crash on startup');
    expect(output).toContain('### Changed');
    expect(output).toContain('simplify session logic');
    expect(output).toContain('Dry run');
  });

  it('writes entries to CHANGELOG.md', async () => {
    const writer = makeWriter();
    const ctx = makeCtx(writer);

    await changelogCmd.handler(ctx, '');

    const cl = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(cl).toContain('### Added');
    expect(cl).toContain('add new feature A');
    expect(cl).toContain('### Fixed');
    expect(cl).toContain('resolve crash on startup');
    // Existing release section preserved
    expect(cl).toContain('## [0.1.0] - 2026-01-01');

    const output = writer.lines.join('\n');
    expect(output).toContain('Wrote entries to CHANGELOG.md');
  });

  it('preserves existing unreleased content', async () => {
    // Pre-populate [Unreleased] with manual entries
    const clPath = join(tmpDir, 'CHANGELOG.md');
    const cl = readFileSync(clPath, 'utf8');
    const withExisting = cl.replace(
      '## [Unreleased]\n',
      '## [Unreleased]\n\n### Security\n- Fix XSS vulnerability\n',
    );
    writeFileSync(clPath, withExisting);

    const writer = makeWriter();
    const ctx = makeCtx(writer);

    await changelogCmd.handler(ctx, '');

    const updated = readFileSync(clPath, 'utf8');
    expect(updated).toContain('Fix XSS vulnerability');
    expect(updated).toContain('add new feature A');

    const output = writer.lines.join('\n');
    expect(output).toContain('Existing [Unreleased] entries will be preserved');
  });

  it('warns when no commits found', async () => {
    // Tag HEAD so there are no new commits
    sh('git tag v999.0.0', tmpDir);

    const writer = makeWriter();
    const ctx = makeCtx(writer);

    // Re-parse with the new tag as latest
    // We need the tag to be the latest for git describe to pick it up
    const result = await changelogCmd.handler(ctx, '');
    expect(result).toBe('continue');

    const output = writer.lines.join('\n');
    expect(output).toContain('No commits found');
  });

  it('registers with the expected name and no aliases', () => {
    expect(changelogCmd.name).toBe('/changelog');
    expect(changelogCmd.aliases ?? []).not.toContain('/cl');
  });

  it('updates CHANGELOG with only [Unreleased] section', async () => {
    writeFileSync(join(tmpDir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n');

    const writer = makeWriter();
    const ctx = makeCtx(writer);

    await changelogCmd.handler(ctx, '');

    const updated = readFileSync(join(tmpDir, 'CHANGELOG.md'), 'utf8');
    expect(updated).toContain('### Added');
    expect(updated).toContain('add new feature A');
    expect(updated).toContain('### Fixed');
    expect(updated).toContain('resolve crash on startup');

    const output = writer.lines.join('\n');
    expect(output).toContain('Wrote entries to CHANGELOG.md');
  });

  it('reports error when CHANGELOG.md is missing', async () => {
    rmSync(join(tmpDir, 'CHANGELOG.md'));

    const writer = makeWriter();
    const ctx = makeCtx(writer);

    const result = await changelogCmd.handler(ctx, '');
    expect(result).toBe('continue');

    const output = writer.lines.join('\n');
    expect(output).toContain('CHANGELOG.md not found');
  });

  it('classifies non-conventional commits as Changed', async () => {
    writeFileSync(join(tmpDir, 'd.ts'), 'export const d = 4;');
    sh('git add -A && git commit -m "bump version to 2.0"', tmpDir);

    const writer = makeWriter();
    const ctx = makeCtx(writer);

    await changelogCmd.handler(ctx, '--dry-run');

    const output = writer.lines.join('\n');
    expect(output).toContain('bump version to 2.0');
    expect(output).toContain('### Changed');
  });

  it('parses breaking change syntax', async () => {
    writeFileSync(join(tmpDir, 'e.ts'), 'export const e = 5;');
    sh('git add -A && git commit -m "feat!: drop Node 16 support"', tmpDir);

    const writer = makeWriter();
    const ctx = makeCtx(writer);

    await changelogCmd.handler(ctx, '--dry-run');

    const output = writer.lines.join('\n');
    expect(output).toContain('drop Node 16 support');
    expect(output).toContain('### Added');
  });

  it('handles --dry-run with surrounding whitespace', async () => {
    const writer = makeWriter();
    const ctx = makeCtx(writer);

    const result = await changelogCmd.handler(ctx, '  --dry-run  ');
    expect(result).toBe('continue');

    const output = writer.lines.join('\n');
    expect(output).toContain('3 commits since last tag');
    expect(output).toContain('Dry run — CHANGELOG.md not modified.');
  });
});
