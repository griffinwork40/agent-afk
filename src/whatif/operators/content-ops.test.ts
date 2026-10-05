/**
 * Unit tests for appendOperator.apply — specifically the blank-line
 * normalization fix for issue #2412, including
 * leading-newline stripping of change.text.
 *
 * @module whatif/operators/content-ops.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { appendOperator } from './content-ops.js';
import type { Environment, OperatorContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(os.tmpdir(), 'content-ops-test-'));
}

function makeEnv(home: string, cwd: string): Environment {
  return { label: 'candidate', home, cwd, launch: { env: {} } };
}

const ctx: OperatorContext = { realHome: '/fake/home', realCwd: '/fake/cwd' };

// ---------------------------------------------------------------------------
// appendOperator — blank-line normalisation (#2412)
// ---------------------------------------------------------------------------

describe('appendOperator.apply — blank-line normalisation', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let env: Environment;
  let afkMdPath: string;

  beforeEach(() => {
    root = makeTmpDir();
    home = join(root, 'home');
    cwd = join(root, 'cwd');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    env = makeEnv(home, cwd);
    afkMdPath = join(home, 'AFK.md');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const change = (text: string) =>
    ({ kind: 'append', target: 'user-afk-md', text } as const);

  it('missing file — no leading blank lines, ends with exactly one newline', async () => {
    // AFK.md does not exist
    await appendOperator.apply(change('Hello'), env, ctx);
    const result = readFileSync(afkMdPath, 'utf8');
    expect(result).toBe('Hello\n');
  });

  it('empty file — no leading blank lines, ends with exactly one newline', async () => {
    writeFileSync(afkMdPath, '', 'utf8');
    await appendOperator.apply(change('Hello'), env, ctx);
    const result = readFileSync(afkMdPath, 'utf8');
    expect(result).toBe('Hello\n');
  });

  it('file ending in single newline — exactly one blank line before appended text', async () => {
    writeFileSync(afkMdPath, '# Existing\n', 'utf8');
    await appendOperator.apply(change('Appended'), env, ctx);
    const result = readFileSync(afkMdPath, 'utf8');
    expect(result).toBe('# Existing\n\nAppended\n');
  });

  it('file ending in multiple newlines — exactly one blank line before appended text', async () => {
    writeFileSync(afkMdPath, '# Existing\n\n\n', 'utf8');
    await appendOperator.apply(change('Appended'), env, ctx);
    const result = readFileSync(afkMdPath, 'utf8');
    expect(result).toBe('# Existing\n\nAppended\n');
  });

  it('file without trailing newline — exactly one blank line before appended text', async () => {
    writeFileSync(afkMdPath, '# Existing', 'utf8');
    await appendOperator.apply(change('Appended'), env, ctx);
    const result = readFileSync(afkMdPath, 'utf8');
    expect(result).toBe('# Existing\n\nAppended\n');
  });

  it('change.text with trailing newlines — result ends with exactly one newline', async () => {
    writeFileSync(afkMdPath, '# Existing\n', 'utf8');
    await appendOperator.apply(change('Appended\n\n'), env, ctx);
    const result = readFileSync(afkMdPath, 'utf8');
    expect(result).toBe('# Existing\n\nAppended\n');
  });

  it('result always ends with exactly one newline regardless of input', async () => {
    for (const existing of ['content\n', 'content\n\n', 'content', '']) {
      writeFileSync(afkMdPath, existing, 'utf8');
      await appendOperator.apply(change('New\n\n'), env, ctx);
      const result = readFileSync(afkMdPath, 'utf8');
      expect(result.endsWith('\n'), `expected trailing newline for existing=${JSON.stringify(existing)}`).toBe(true);
      expect(result.endsWith('\n\n'), `unexpected double newline at end for existing=${JSON.stringify(existing)}`).toBe(false);
    }
  });

  it('change.text with leading newlines into empty file — no leading blank lines', async () => {
    writeFileSync(afkMdPath, '', 'utf8');
    await appendOperator.apply(change('\n\nRule'), env, ctx);
    expect(readFileSync(afkMdPath, 'utf8')).toBe('Rule\n');
  });

  it('change.text with leading newlines into non-empty file — exactly one blank line separator', async () => {
    writeFileSync(afkMdPath, '# Existing\n', 'utf8');
    await appendOperator.apply(change('\n\nRule'), env, ctx);
    expect(readFileSync(afkMdPath, 'utf8')).toBe('# Existing\n\nRule\n');
  });

  it('project-afk-md target — normalises the project AFK.md under env.cwd', async () => {
    const projectPath = join(cwd, 'AFK.md');
    writeFileSync(projectPath, '# Project\n\n\n', 'utf8');
    await appendOperator.apply(
      { kind: 'append', target: 'project-afk-md', text: '\nRule\n' },
      env,
      ctx,
    );
    expect(readFileSync(projectPath, 'utf8')).toBe('# Project\n\nRule\n');
  });
});

// ---------------------------------------------------------------------------
// appendOperator.touchesProject
// ---------------------------------------------------------------------------

describe('appendOperator.touchesProject', () => {
  it('returns true for project-afk-md target', () => {
    expect(
      appendOperator.touchesProject({ kind: 'append', target: 'project-afk-md', text: 'x' }),
    ).toBe(true);
  });

  it('returns false for user-afk-md target', () => {
    expect(
      appendOperator.touchesProject({ kind: 'append', target: 'user-afk-md', text: 'x' }),
    ).toBe(false);
  });
});
