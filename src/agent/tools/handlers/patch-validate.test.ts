/**
 * Tests for patch-validate.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes, createHash } from 'crypto';
import { validatePatchChanges } from './patch-validate.js';
import type { PatchFileChange } from './patch-validate.js';

// Scratch directory outside the repo working tree.
const tempDir = path.join(
  os.tmpdir(),
  `afk-patch-validate-test-${process.pid}-${randomBytes(4).toString('hex')}`,
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

// Context that permits writes anywhere inside tempDir.
const makeCtx = () => ({
  resolveBase: tempDir,
  writeRoots: [tempDir],
  readRoots: [tempDir],
});

afterEach(async () => {
  try {
    await rm(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe('validatePatchChanges', () => {
  it('passes for a valid content change', async () => {
    const filePath = await writeTemp('a.txt', 'hello\n');
    const changes: PatchFileChange[] = [{ path: filePath, content: 'world\n' }];
    const result = await validatePatchChanges(changes, tempDir, makeCtx());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.fileContents.get(filePath)).toBe('hello\n');
  });

  it('passes for a valid edit change', async () => {
    const filePath = await writeTemp('b.txt', 'foo bar baz\n');
    const changes: PatchFileChange[] = [
      { path: filePath, edits: [{ old: 'bar', new: 'qux' }] },
    ];
    const result = await validatePatchChanges(changes, tempDir, makeCtx());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes hash verification when hash matches', async () => {
    const content = 'exact content\n';
    const filePath = await writeTemp('c.txt', content);
    const hash = sha256(content);
    const changes: PatchFileChange[] = [
      { path: filePath, expected_hash: `sha256:${hash}`, content: 'new\n' },
    ];
    const result = await validatePatchChanges(changes, tempDir, makeCtx());
    expect(result.valid).toBe(true);
  });

  it('fails hash verification when file has changed', async () => {
    const filePath = await writeTemp('d.txt', 'current content\n');
    const staleHash = sha256('old content\n');
    const changes: PatchFileChange[] = [
      { path: filePath, expected_hash: `sha256:${staleHash}`, content: 'new\n' },
    ];
    const result = await validatePatchChanges(changes, tempDir, makeCtx());
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error).toBe('hash_mismatch');
    expect(result.errors[0]!.path).toBe(filePath);
  });

  it('fails when expected_hash has wrong format', async () => {
    const filePath = await writeTemp('e.txt', 'x\n');
    const changes: PatchFileChange[] = [
      { path: filePath, expected_hash: 'md5:abcdef', content: 'y\n' },
    ];
    const result = await validatePatchChanges(changes, tempDir, makeCtx());
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.error).toBe('invalid_hash_format');
  });

  it('fails when edit old-string has zero matches', async () => {
    const filePath = await writeTemp('f.txt', 'hello world\n');
    const changes: PatchFileChange[] = [
      { path: filePath, edits: [{ old: 'nothere', new: 'x' }] },
    ];
    const result = await validatePatchChanges(changes, tempDir, makeCtx());
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.error).toBe('edit_not_found');
    expect(result.errors[0]!.detail).toContain('Edit #1');
  });

  it('fails when edit old-string has more than one match', async () => {
    const filePath = await writeTemp('g.txt', 'foo foo foo\n');
    const changes: PatchFileChange[] = [
      { path: filePath, edits: [{ old: 'foo', new: 'bar' }] },
    ];
    const result = await validatePatchChanges(changes, tempDir, makeCtx());
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.error).toBe('edit_ambiguous');
    expect(result.errors[0]!.detail).toContain('3 locations');
  });

  it('rejects a change that has both edits and content', async () => {
    const filePath = await writeTemp('h.txt', 'x\n');
    const changes: PatchFileChange[] = [
      { path: filePath, edits: [{ old: 'x', new: 'y' }], content: 'z\n' },
    ];
    const result = await validatePatchChanges(changes, tempDir, makeCtx());
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.error).toBe('mutually_exclusive');
  });

  it('rejects a change that has neither edits nor content', async () => {
    const filePath = await writeTemp('i.txt', 'x\n');
    const changes: PatchFileChange[] = [{ path: filePath }];
    const result = await validatePatchChanges(changes, tempDir, makeCtx());
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.error).toBe('no_change_specified');
  });

  it('collects ALL errors across multiple files without short-circuiting', async () => {
    const file1 = await writeTemp('j1.txt', 'aaa\n');
    const file2 = await writeTemp('j2.txt', 'bbb\n');
    const file3 = await writeTemp('j3.txt', 'ccc ccc\n');
    const changes: PatchFileChange[] = [
      // file1: bad hash
      { path: file1, expected_hash: `sha256:${sha256('wrong')}`, content: 'x\n' },
      // file2: edit not found
      { path: file2, edits: [{ old: 'nothere', new: 'x' }] },
      // file3: ambiguous edit
      { path: file3, edits: [{ old: 'ccc', new: 'ddd' }] },
    ];
    const result = await validatePatchChanges(changes, tempDir, makeCtx());
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(3);
    const codes = result.errors.map((e) => e.error);
    expect(codes).toContain('hash_mismatch');
    expect(codes).toContain('edit_not_found');
    expect(codes).toContain('edit_ambiguous');
  });

  it('rejects write to denylist path', async () => {
    // Use a known denied system path; pass as absolute so containment is bypassed
    // but denylist fires.
    const deniedPath = '/etc/passwd';
    const changes: PatchFileChange[] = [{ path: deniedPath, content: 'evil\n' }];
    // allowAll=false (default), resolveBase tempDir.
    const result = await validatePatchChanges(changes, tempDir, {
      resolveBase: tempDir,
      writeRoots: [tempDir, '/etc'],   // grant containment so denylist is tested
      allowAll: false,
    });
    expect(result.valid).toBe(false);
    const errCodes = result.errors.map((e) => e.error);
    expect(errCodes).toContain('write_denied');
  });

  it('rejects path outside write roots', async () => {
    const filePath = await writeTemp('k.txt', 'x\n');
    // Restrict write roots to a completely different dir.
    const restrictedCtx = {
      resolveBase: '/some/other/dir',
      writeRoots: ['/some/other/dir'],
      readRoots: ['/some/other/dir'],
    };
    const changes: PatchFileChange[] = [{ path: filePath, content: 'y\n' }];
    const result = await validatePatchChanges(changes, '/some/other/dir', restrictedCtx);
    expect(result.valid).toBe(false);
    const errCodes = result.errors.map((e) => e.error);
    expect(errCodes).toContain('path_containment');
  });

  it('validates sequential edits against progressively-modified content', async () => {
    // First edit makes a change; second edit targets the NEW content, not original.
    const filePath = await writeTemp('l.txt', 'alpha beta gamma\n');
    const changes: PatchFileChange[] = [
      {
        path: filePath,
        edits: [
          { old: 'alpha', new: 'A' },     // valid: 'alpha' exists once
          { old: 'A beta', new: 'AB' },   // valid against modified: 'A beta' exists
        ],
      },
    ];
    const result = await validatePatchChanges(changes, tempDir, makeCtx());
    expect(result.valid).toBe(true);
  });
});
