/**
 * Tests for patch-apply-engine.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, readFile, mkdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { applyPatch } from './patch-apply-engine.js';
import type { PatchFileChange } from './patch-validate.js';

const tempDir = path.join(
  os.tmpdir(),
  `afk-patch-engine-test-${process.pid}-${randomBytes(4).toString('hex')}`,
);

async function writeTemp(filename: string, content: string): Promise<string> {
  await mkdir(tempDir, { recursive: true });
  const p = path.join(tempDir, filename);
  await writeFile(p, content, 'utf-8');
  return p;
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

afterEach(async () => {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  vi.restoreAllMocks();
});

describe('applyPatch (dry-run)', () => {
  it('returns diff without modifying the file', async () => {
    const filePath = await writeTemp('dry.txt', 'before\n');
    const changes: PatchFileChange[] = [{ path: filePath, content: 'after\n' }];
    const fileContents = new Map([[filePath, 'before\n']]);

    const result = await applyPatch(changes, fileContents, tempDir, /* dryRun */ true);

    expect(result.status).toBe('dry_run');
    expect(result.diff).toContain('-before');
    expect(result.diff).toContain('+after');
    expect(result.errors).toHaveLength(0);

    // File must NOT have been modified.
    const actual = await readFile(filePath, 'utf-8');
    expect(actual).toBe('before\n');
  });

  it('dry-run diff for sequential edits', async () => {
    const filePath = await writeTemp('dry-edits.txt', 'foo bar baz\n');
    const changes: PatchFileChange[] = [
      {
        path: filePath,
        edits: [
          { old: 'foo', new: 'FOO' },
          { old: 'bar', new: 'BAR' },
        ],
      },
    ];
    const fileContents = new Map([[filePath, 'foo bar baz\n']]);

    const result = await applyPatch(changes, fileContents, tempDir, true);

    expect(result.status).toBe('dry_run');
    expect(result.diff).toContain('+FOO BAR baz');
    const actual = await readFile(filePath, 'utf-8');
    expect(actual).toBe('foo bar baz\n'); // unchanged
  });

  it('dry-run returns correct before/after hashes', async () => {
    const filePath = await writeTemp('hash-check.txt', 'original\n');
    const changes: PatchFileChange[] = [{ path: filePath, content: 'replaced\n' }];
    const fileContents = new Map([[filePath, 'original\n']]);

    const result = await applyPatch(changes, fileContents, tempDir, true);

    expect(result.files_changed).toHaveLength(1);
    const fc = result.files_changed[0]!;
    expect(fc.before_hash).toBe(`sha256:${sha256('original\n')}`);
    expect(fc.after_hash).toBe(`sha256:${sha256('replaced\n')}`);
  });
});

describe('applyPatch (live write)', () => {
  it('writes correct content for full-file replacement', async () => {
    const filePath = await writeTemp('write.txt', 'old content\n');
    const changes: PatchFileChange[] = [{ path: filePath, content: 'new content\n' }];
    const fileContents = new Map([[filePath, 'old content\n']]);

    const result = await applyPatch(changes, fileContents, tempDir, false);

    expect(result.status).toBe('applied');
    expect(result.errors).toHaveLength(0);
    const actual = await readFile(filePath, 'utf-8');
    expect(actual).toBe('new content\n');
  });

  it('applies sequential edits in order', async () => {
    const filePath = await writeTemp('seq.txt', 'step1 step2 step3\n');
    const changes: PatchFileChange[] = [
      {
        path: filePath,
        edits: [
          { old: 'step1', new: 'STEP1' },
          { old: 'STEP1 step2', new: 'STEP1+STEP2' },
        ],
      },
    ];
    const fileContents = new Map([[filePath, 'step1 step2 step3\n']]);

    const result = await applyPatch(changes, fileContents, tempDir, false);

    expect(result.status).toBe('applied');
    const actual = await readFile(filePath, 'utf-8');
    expect(actual).toBe('STEP1+STEP2 step3\n');
  });

  it('includes diff in successful result', async () => {
    const filePath = await writeTemp('diff-check.txt', 'hello\n');
    const changes: PatchFileChange[] = [{ path: filePath, content: 'world\n' }];
    const fileContents = new Map([[filePath, 'hello\n']]);

    const result = await applyPatch(changes, fileContents, tempDir, false);

    expect(result.status).toBe('applied');
    expect(result.diff).toContain('-hello');
    expect(result.diff).toContain('+world');
  });

  it('handles new-file creation (empty originalContent)', async () => {
    const newFilePath = path.join(tempDir, 'newfile.txt');
    await mkdir(tempDir, { recursive: true });
    const changes: PatchFileChange[] = [{ path: newFilePath, content: 'brand new\n' }];
    const fileContents = new Map([[newFilePath, '']]);

    const result = await applyPatch(changes, fileContents, tempDir, false);

    expect(result.status).toBe('applied');
    const actual = await readFile(newFilePath, 'utf-8');
    expect(actual).toBe('brand new\n');
  });

  it('reports partial_failure when rename cannot succeed', async () => {
    // Make the target path a directory so rename fails with EISDIR.
    const targetPath = path.join(tempDir, 'is-a-dir');
    await mkdir(targetPath, { recursive: true });
    // The fileContents map stores '' so the engine doesn't fail on the temp write.
    const fileContents = new Map([[targetPath, '']]);
    const changes: PatchFileChange[] = [{ path: targetPath, content: 'new content\n' }];

    const result = await applyPatch(changes, fileContents, tempDir, false);

    // rename(tmpFile, directory) → EISDIR on POSIX.
    expect(result.status).toBe('partial_failure');
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
