/**
 * Tier-inspection tests for `/afk-md`.
 *
 * Strategy: real temp files, with `src/paths.ts` mocked so the two AFK.md
 * locations point into the fixture. Never touches the operator's real
 * `$AFK_HOME/AFK.md`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpRoot = '';
const userDir = (): string => join(tmpRoot, 'home');
const projectDir = (): string => join(tmpRoot, 'repo');

vi.mock('../../../../paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../paths.js')>();
  return {
    ...actual,
    getUserAfkMdPath: (): string => join(userDir(), 'AFK.md'),
    getProjectAfkMdPath: (): string => join(projectDir(), 'AFK.md'),
  };
});

const { contributes, resolveTargets, renderTargetRows, formatTokens } = await import('./targets.js');

/** Strip ANSI so assertions do not depend on colour support. */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001B\[[0-9;]*m/g, '');
}

beforeEach(() => {
  tmpRoot = join(tmpdir(), `afk-md-targets-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(userDir(), { recursive: true });
  mkdirSync(projectDir(), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveTargets', () => {
  it('reports both tiers missing when neither file exists', () => {
    const [user, project] = resolveTargets();
    expect(user?.exists).toBe(false);
    expect(project?.exists).toBe(false);
    expect(resolveTargets().filter(contributes)).toHaveLength(0);
  });

  it('returns user-scope first, matching loader concatenation order', () => {
    const targets = resolveTargets();
    expect(targets.map((t) => t.scope)).toEqual(['user', 'project']);
    expect(targets.map((t) => t.label)).toEqual(['personal', 'project']);
  });

  it('counts only the user tier when only it exists', () => {
    writeFileSync(join(userDir(), 'AFK.md'), '- be terse\n', 'utf-8');
    const active = resolveTargets().filter(contributes);
    expect(active).toHaveLength(1);
    expect(active[0]?.scope).toBe('user');
    expect(active[0]?.tokens).toBeGreaterThan(0);
  });

  it('counts only the project tier when only it exists', () => {
    writeFileSync(join(projectDir(), 'AFK.md'), '- use pnpm\n', 'utf-8');
    const active = resolveTargets().filter(contributes);
    expect(active).toHaveLength(1);
    expect(active[0]?.scope).toBe('project');
  });

  it('counts both tiers when both are present and distinct', () => {
    writeFileSync(join(userDir(), 'AFK.md'), '- be terse\n', 'utf-8');
    writeFileSync(join(projectDir(), 'AFK.md'), '- use pnpm\n', 'utf-8');
    expect(resolveTargets().filter(contributes)).toHaveLength(2);
  });

  it('treats a whitespace-only file as absent, matching the loader', () => {
    writeFileSync(join(projectDir(), 'AFK.md'), '   \n\n\t\n', 'utf-8');
    const project = resolveTargets().find((t) => t.scope === 'project');
    expect(project?.exists).toBe(true);
    expect(project?.blank).toBe(true);
    expect(contributes(project!)).toBe(false);
  });

  it('de-duplicates a symlinked project tier instead of double-counting', () => {
    writeFileSync(join(userDir(), 'AFK.md'), '- shared\n', 'utf-8');
    symlinkSync(join(userDir(), 'AFK.md'), join(projectDir(), 'AFK.md'));
    const targets = resolveTargets();
    const project = targets.find((t) => t.scope === 'project');
    expect(project?.duplicate).toBe(true);
    expect(targets.filter(contributes)).toHaveLength(1);
  });
});

describe('renderTargetRows', () => {
  it('marks the project tier as the conflict winner when it contributes', () => {
    writeFileSync(join(userDir(), 'AFK.md'), '- a\n', 'utf-8');
    writeFileSync(join(projectDir(), 'AFK.md'), '- b\n', 'utf-8');
    const out = plain(renderTargetRows(resolveTargets()).join('\n'));
    expect(out).toContain('wins on conflict');
    expect(out).toContain('loaded');
  });

  it('surfaces the empty-file footgun in the status column', () => {
    writeFileSync(join(userDir(), 'AFK.md'), '\n\n', 'utf-8');
    expect(plain(renderTargetRows(resolveTargets()).join('\n'))).toContain('treated as absent');
  });

  it('names the dedup rather than reporting the tier twice', () => {
    writeFileSync(join(userDir(), 'AFK.md'), '- shared\n', 'utf-8');
    symlinkSync(join(userDir(), 'AFK.md'), join(projectDir(), 'AFK.md'));
    expect(plain(renderTargetRows(resolveTargets()).join('\n'))).toContain('counted once');
  });
});

describe('formatTokens', () => {
  it('renders sub-1k counts exactly and larger counts in k', () => {
    expect(formatTokens(940)).toBe('~940');
    expect(formatTokens(2432)).toBe('~2.4k');
  });
});
